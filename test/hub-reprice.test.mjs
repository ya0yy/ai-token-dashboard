import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { readSnapshot } from '../src/usage-store.mjs';
import { event, startServer, usage } from './helpers/server.mjs';

test('重算可按 Agent 工具筛选，确认时校验工具范围', { timeout: 20_000 }, async t => {
  const hub = await startServer();
  t.after(() => hub.close());
  const pi = usage({ source: 'Pi Agent', costBasis: 'estimated' });
  const claude = { ...pi, source: 'Claude Code', costUSD: 2 };
  const events = [event(pi), event({ ...claude, pricingTime: '2026-09-01T00:00:00.000Z' })];
  assert.equal((await hub.ingest({ daily: [pi, claude], time: events })).status, 200);
  const send = (path, body, method = 'POST') => fetch(hub.base + path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
  });
  const saved = await send('/api/pricing', { timeZone: 'UTC', rules: [], defaults: [
    { model: pi.model, rates: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } }
  ] }, 'PUT');
  assert.equal(saved.status, 200);
  const range = { start: pi.usageDate, end: pi.usageDate };
  const reprice = body => send('/api/pricing/reprice', { ...range, ...body });
  const chosen = await reprice({ source: pi.source });
  assert.equal(chosen.status, 200);
  const preview = await chosen.json();
  assert.equal(preview.counts.time, 1);
  assert.equal(preview.costBefore, 1);
  assert.equal((await (await reprice({})).json()).costBefore, 3);
  assert.equal((await reprice({ source: ['Pi Agent'] })).status, 400);
  assert.equal((await reprice({ source: claude.source, previewId: preview.previewId })).status, 409);
  assert.equal((await reprice({ source: pi.source, previewId: preview.previewId })).status, 200);
  const db = await openDb(join(hub.root, 'usage.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const { time } = await readSnapshot(db);
  assert.deepEqual(Object.fromEntries(time.map(row => [row.source, row.costUSD])), { 'Pi Agent': 0.01, 'Claude Code': 2 });
  const options = await fetch(hub.base + '/api/pricing', { signal: AbortSignal.timeout(5000) });
  assert.deepEqual((await options.json()).sources, ['Claude Code', 'Pi Agent']);
});

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

test('重算预览按日期读取明细，长历史和低内存下仍可预览及备份', { timeout: 30_000 }, async t => {
  const hub = await startServer({ NODE_OPTIONS: '--max-old-space-size=64' });
  const db = await openDb(join(hub.root, 'usage.sqlite'));
  t.after(async () => { await db.close(); await hub.close(); });
  const day = usage({ model: 'gpt-5.3', costBasis: 'estimated', pricingVersion: 'old' });
  const item = event(day);
  const earlier = { ...item, eventKey: 'earlier', usageDate: '2026-08-01', eventTime: '2026-08-01T00:00:00Z' };
  const session = { ...day, projectPath: item.projectPath, sessionId: `local:project:${day.model}`,
    inputTokens: 200, outputTokens: 20, totalTokens: 220, costUSD: 2 };
  assert.equal((await hub.ingest({ daily: [day], time: [item, earlier], sessions: [session] })).status, 200);
  await db.run(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 100000)
    INSERT INTO time_usage (device, source, event_key, event_time, usage_date, model, project_path, updated_at)
    SELECT ?, ?, 'history-' || n, '2026-08-01T00:00:00Z', '2026-08-01', 'other-model',
      '/project/' || hex(randomblob(160)), CURRENT_TIMESTAMP FROM seq`, [day.device, day.source]);
  const range = { start: day.usageDate, end: day.usageDate };
  const request = body => fetch(hub.base + '/api/pricing/reprice', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const response = await request(range);
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.counts.time, 1);
  assert.equal(preview.counts.sessions, 1);
  assert.equal((await db.get("SELECT cost_usd FROM time_usage WHERE event_key = 'a'")).cost_usd, 1);
  const applied = await request({ ...range, previewId: preview.previewId });
  assert.equal(applied.status, 200);
  const result = await applied.json();
  assert.equal(result.counts.time, 1);
  const backup = JSON.parse(await readFile(join(hub.root, 'data', 'backups', result.backupFile), 'utf8'));
  assert.equal(backup.time.length, 100002);
  assert.equal(backup.time.find(row => row.eventKey === 'a').costUSD, 1);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM time_usage WHERE usage_date = '2026-08-01'")).n, 100001);
  assert.equal((await db.get('SELECT cost_usd FROM session_usage')).cost_usd, 1 + preview.costAfter);
});

test('历史重算的目录模型 ID 和采集模型 ID 匹配相同用量', { timeout: 20_000 }, async t => {
  const hub = await startServer();
  t.after(() => hub.close());
  const model = 'deepseek-v4.1-flash-1017';
  const alias = `deepseek/${model}`;
  const daily = [model, alias, 'other-model'].map(id => usage({ model: id, costBasis: 'estimated' }));
  const time = daily.map(day => event({ ...day, eventKey: day.model }));
  assert.equal((await hub.ingest({ daily, time })).status, 200);

  const send = (path, body, method = 'POST') => fetch(hub.base + path, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
  });
  const rates = { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal((await send('/api/pricing', {
    timeZone: 'UTC', defaults: daily.map(row => ({ model: row.model, rates })), rules: []
  }, 'PUT')).status, 200);
  const range = { start: daily[0].usageDate, end: daily[0].usageDate };
  const previewIds = [];
  for (const id of [model, alias]) {
    const result = await send('/api/pricing/reprice', { ...range, model: id });
    assert.equal(result.status, 200);
    const preview = await result.json();
    assert.equal(preview.counts.time, 2);
    assert.equal(preview.costBefore, 2);
    assert.equal(preview.costAfter, 0.02);
    previewIds.push(preview.previewId);
  }
  assert.equal(previewIds[0], previewIds[1]);
  const applied = await send('/api/pricing/reprice', { ...range, model: alias, previewId: previewIds[0] });
  assert.equal(applied.status, 200);
  const db = await openDb(join(hub.root, 'usage.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const { time: stored } = await readSnapshot(db);
  assert.deepEqual(Object.fromEntries(stored.map(row => [row.model, row.costUSD])), {
    [model]: 0.01, [alias]: 0.01, 'other-model': 1
  });
});
