import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, withReadSnapshot } from '../src/db.mjs';
import { readSnapshot, writeSnapshot } from '../src/usage-store.mjs';
import { syncDatabase } from '../src/sync.mjs';
import { event, startServer, usage } from './helpers/server.mjs';

const model = 'deepseek-v4.1-flash-1017';
const usageDate = '2026-10-27';
const scope = { device: 'laptop', source: 'Pi Agent' };
const provider = 'aliyun-token-plan';
const rates = input => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });

async function post(hub, path, data, method = 'POST') {
  const response = await fetch(hub.base + path, {
    method, headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data), signal: AbortSignal.timeout(5000)
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

const publish = (hub, price = 10) => post(hub, '/api/pricing', {
  timeZone: 'Asia/Shanghai', defaults: [{ model, rates: rates(price) }],
  rules: [{ model, provider, enabled: true, offPeakStart: '00:00', offPeakEnd: '08:00',
    offPeak: rates(price / 2), peak: rates(price * 2) }]
}, 'PUT');

const call = (eventKey, overrides = {}) => event({
  ...scope, model, usageDate, eventKey, eventTime: '2026-10-27T02:00:00.000Z',
  inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, ...overrides
});

test('Hub 按真实调用时段计价，保留确认的零账单和重复上报的入库金额', { timeout: 20_000 }, async t => {
  const hub = await startServer();
  const db = await openDb(join(hub.root, 'usage.sqlite'), { readOnly: true });
  const local = await openDb(join(hub.root, 'collector.sqlite'));
  t.after(async () => { await local.close(); await db.close(); await hub.close(); });
  const pricing = await publish(hub);
  await writeSnapshot(local, { daily: [usage({ ...scope, model, usageDate })],
    sessions: [{ ...usage(scope), sessionId: 'summary' }], time: [
    call('valley', { provider, pricingTime: '2026-10-26T18:00:00.000Z', costUSD: 99, costBasis: 'estimated' }),
    call('peak', { provider, pricingTime: '2026-10-27T02:00:00.000Z', costUSD: 98, costBasis: 'estimated' }),
    call('default', { costUSD: 97 }),
    call('bill', { provider, costUSD: 0, costBasis: 'recorded', billedCostUSD: 0 })
  ] });
  const sync = options => syncDatabase({ db: local, url: hub.base + '/api/ingest', ...scope, hubPricing: true, ...options });
  const sent = [];
  await sync({ fetcher: (url, options) => { sent.push(JSON.parse(options.body)); return fetch(url, options); } });
  assert.equal(sent[0].pricing, 'hub');
  assert.equal(sent[0].daily, undefined);
  assert.equal(sent[0].sessions, undefined);
  assert.ok(sent[0].time.every(row => !Object.hasOwn(row, 'costUSD')));
  assert.equal(sent[0].time.find(row => row.eventKey === 'bill').billedCostUSD, 0);
  await publish(hub, 100);
  await sync({ resync: true });
  await sync({ full: true, scopes: [scope] });
  assert.equal((await hub.ingest({ time: [call('peak', { costUSD: 123 })] })).status, 200);
  const stored = await readSnapshot(db);
  const byKey = Object.fromEntries(stored.time.map(row => [row.eventKey, row]));
  assert.equal(byKey.valley.costUSD, 5);
  assert.equal(byKey.valley.pricingVersion, pricing.version);
  assert.equal(byKey.peak.costUSD, 20);
  assert.equal(byKey.default.costUSD, 10);
  assert.equal(byKey.bill.costUSD, 0);
  assert.equal(byKey.bill.costBasis, 'recorded');
  assert.equal(stored.daily[0].costUSD, 35);
  assert.equal(stored.daily[0].totalTokens, 4_000_000);
});

test('定价页主动补算旧 Pi 零估价，预览期间保留原费用，并保护已确认的零账单', { timeout: 20_000 }, async t => {
  const hub = await startServer();
  const db = await openDb(join(hub.root, 'usage.sqlite'), { readOnly: true });
  t.after(async () => { await db.close(); await hub.close(); });
  await publish(hub);
  const legacy = call('legacy-zero', { costBasis: 'recorded', costUSD: 0 });
  const day = usage({ ...scope, model, usageDate, inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000,
    costBasis: 'recorded', costUSD: 0, pricingVersion: 'old-catalog' });
  assert.equal((await hub.ingest({ daily: [day], time: [legacy] })).status, 200);
  const billed = call('confirmed-zero', { device: 'other', billedCostUSD: 0 });
  delete billed.costUSD;
  assert.equal((await hub.ingest({ pricing: 'hub', time: [billed] })).status, 200);
  const other = call('other-source', { source: 'Claude Code', costUSD: 3, costBasis: 'estimated',
    pricingTime: '2026-10-27T02:00:00.000Z' });
  assert.equal((await hub.ingest({ daily: [other], time: [other] })).status, 200);

  const path = '/api/pricing/reprice';
  const range = { start: usageDate, end: usageDate };
  assert.equal((await post(hub, path, range)).counts.time, 1);
  const request = { ...range, model, recoverLegacyPiZero: true };
  const preview = await post(hub, path, request);
  assert.equal(preview.counts.time, 1);
  assert.equal(preview.costBefore, 0);
  assert.equal(preview.difference, 10);
  assert.equal((await readSnapshot(db)).time.find(item => item.eventKey === 'legacy-zero').costUSD, 0);
  assert.equal((await post(hub, path, { ...request, model: 'other-model' })).counts.time, 0);
  await post(hub, path, { ...request, previewId: preview.previewId });
  assert.equal((await hub.ingest({ daily: [day], time: [legacy] })).status, 200);
  const stored = await readSnapshot(db);
  assert.equal(stored.time.find(row => row.eventKey === 'legacy-zero').costUSD, 10);
  assert.equal(stored.time.find(row => row.eventKey === 'confirmed-zero').costUSD, 0);
  assert.equal(stored.time.find(row => row.eventKey === 'other-source').costUSD, 3);
  assert.equal(stored.daily.find(row => row.device === 'laptop' && row.source === 'Pi Agent').costUSD, 10);
});

for (const [driver, name] of [['postgres', 'TEST_POSTGRES_URL'], ['mysql', 'TEST_MYSQL_URL']]) {
  test(`Hub 入库计价和重算兼容 ${driver}`, { skip: !process.env[name], timeout: 30_000 }, async t => {
    const url = process.env[name];
    const hub = await startServer({ DATABASE_URL: url, DB_DRIVER: driver });
    const db = await openDb(url, { readOnly: true });
    const device = `pricing-${driver}-${process.pid}`;
    t.after(async () => {
      await hub.close();
      for (const table of ['daily_usage', 'time_usage']) await db.run(`DELETE FROM ${table} WHERE device = ?`, [device]);
      await db.close();
    });
    await publish(hub);
    const fresh = call('fresh', { device, provider, pricingTime: '2026-10-26T18:00:00.000Z' });
    const legacy = call('legacy', { device, source: 'Pi Agent', usageDate: '2026-10-28',
      eventTime: '2026-10-28T02:00:00.000Z', costUSD: 0, costBasis: 'recorded' });
    assert.equal((await hub.ingest({ pricing: 'hub', time: [fresh] })).status, 200);
    assert.equal((await hub.ingest({ daily: [legacy], time: [legacy] })).status, 200);
    const request = { start: legacy.usageDate, end: legacy.usageDate, model, recoverLegacyPiZero: true };
    const preview = await post(hub, '/api/pricing/reprice', request);
    assert.equal(preview.difference, 10);
    await post(hub, '/api/pricing/reprice', { ...request, previewId: preview.previewId });
    const stored = await withReadSnapshot(db, tx => readSnapshot(tx, device));
    assert.deepEqual(stored.time.map(row => [row.eventKey, Number(row.costUSD)]).sort(), [['fresh', 5], ['legacy', 10]]);
  });
}
