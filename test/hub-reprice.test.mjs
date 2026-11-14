import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { readSnapshot } from '../src/usage-store.mjs';
import { event, startServer, usage } from './helpers/server.mjs';

test('Hub 预览后重算完整明细，接收旧上报和迟到调用时保留重算后的金额', { timeout: 30_000 }, async t => {
  const hub = await startServer({ DASHBOARD_TOKEN: 'reader', INGEST_TOKEN: 'collector' });
  t.after(() => hub.close());
  const day = usage({ costBasis: 'estimated', pricingVersion: 'old' });
  const item = event({ ...day, provider: 'edge' });
  const dailyOnly = usage({ usageDate: '2026-09-02', costUSD: 3 });
  const original = { daily: [day, dailyOnly], time: [item] };
  assert.equal((await hub.ingest(original)).status, 200);

  const post = (path, body, token = 'reader', method = 'POST') => fetch(hub.base + path, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
  });
  const rates = { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 };
  const publish = async input => {
    const response = await post('/api/pricing', {
      timeZone: 'UTC', defaults: [{ model: day.model, rates: { ...rates, input } }], rules: []
    }, 'reader', 'PUT');
    assert.equal(response.status, 200);
  };
  await publish(200);
  const db = await openDb(join(hub.root, 'usage.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const range = { start: '2026-09-01', end: '2026-09-02' };
  const endpoint = '/api/pricing/reprice';
  assert.equal((await post(endpoint, range, 'collector')).status, 401);
  const preview = async () => {
    const response = await post(endpoint, range);
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await preview();
  assert.equal(first.costBefore, 1);
  assert.equal(first.costAfter, 0.02);
  assert.equal(first.skipped.incompleteDetail, 1);
  assert.equal((await readSnapshot(db)).time[0].costUSD, 1);
  await assert.rejects(readdir(join(hub.root, 'data', 'backups')), { code: 'ENOENT' });

  await publish(100);
  assert.equal((await post(endpoint, { ...range, previewId: first.previewId })).status, 409);
  const current = await preview();
  const applied = await post(endpoint, { ...range, previewId: current.previewId });
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).applied, true);
  assert.equal((await readdir(join(hub.root, 'data', 'backups'))).length, 1);
  assert.equal((await hub.ingest(original)).status, 200);
  assert.equal((await hub.ingest({ ...original, mode: 'full', scopes: [{ device: day.device, source: day.source }] })).status, 200);

  // 同步允许日汇总和调用明细分批到达，费用应在明细到齐后对上。
  const expanded = { ...day, inputTokens: 200, outputTokens: 20, totalTokens: 220, costUSD: 1.5 };
  assert.equal((await hub.ingest({ daily: [expanded] })).status, 200);
  assert.equal((await hub.ingest({ time: [{ ...item, eventKey: 'late', costUSD: 0.5 }] })).status, 200);
  const stored = await readSnapshot(db);
  assert.equal(stored.time.find(row => row.eventKey === item.eventKey).costUSD, 0.01);
  assert.equal(stored.daily.find(row => row.usageDate === day.usageDate).costUSD, 0.51);
  assert.equal(stored.daily.find(row => row.usageDate === dailyOnly.usageDate).costUSD, 3);
});
