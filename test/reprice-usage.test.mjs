import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../src/db.mjs';
import { readSnapshot, writeSnapshot } from '../src/usage-store.mjs';
import { event, startServer, usage } from './helpers/server.mjs';
import { onboardingFixture } from './helpers/onboarding.mjs';

const runFile = promisify(execFile);

test('采集端从 Hub 拉取规则，按请求时间与渠道上报估价并保留真实账单', { timeout: 30_000 }, async t => {
  const hub = await startServer({ DASHBOARD_TOKEN: 'reader', INGEST_TOKEN: 'collector' });
  t.after(() => hub.close());
  const fixture = onboardingFixture();
  t.after(() => fixture.close());
  const rate = input => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });
  const policy = { timeZone: 'Asia/Shanghai', defaults: [{ model: 'test-model', rates: rate(5) }], rules: [
    { provider: 'edge', model: 'test-model', enabled: true, peak: rate(10), offPeak: rate(2),
      offPeakStart: '23:30', offPeakEnd: '06:15' }
  ] };
  const publish = async rules => {
    const response = await fetch(hub.base + '/api/pricing', {
      method: 'PUT', headers: { authorization: 'Bearer reader', 'content-type': 'application/json' },
      body: JSON.stringify(rules), signal: AbortSignal.timeout(5_000)
    });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).version;
  };
  const version = await publish(policy);
  const records = [
    { type: 'session', version: 3, id: 'pricing-session', cwd: '/synthetic/project' },
    ...[
      ['peak', 'edge', '2026-11-01T15:29:59Z', { total: 99 }],
      ['off', 'edge', '2026-11-01T15:30:00Z', { total: 99 }],
      ['default', undefined, '2026-11-01T15:31:00Z', { total: 99 }],
      ['billed', 'edge', '2026-11-01T15:32:00Z', { total: 0, totalFromProvider: true }]
    ].map(([id, provider, timestamp, cost]) => ({
      type: 'message', id, parentId: null, timestamp,
      message: { role: 'assistant', model: 'test-model', provider, timestamp: Date.parse(timestamp),
        usage: { input: 1_000_000, totalTokens: 1_000_000, cost } }
    }))
  ];
  await writeFile(join(fixture.sessions, 'pricing.jsonl'), records.map(row => JSON.stringify(row)).join('\n') + '\n');
  const run = () => runFile(process.execPath, [resolve('src/collect.mjs'), '--device', 'laptop', '--source', 'Pi Agent',
    '--push', hub.base + '/api/ingest', '--token', 'collector'], { cwd: fixture.root, env: fixture.env, timeout: 10_000 });
  await run();
  const read = async () => {
    const response = await fetch(hub.base + '/api/time?start=2026-11-01T00:00:00Z&end=2026-11-02T00:00:00Z',
      { headers: { authorization: 'Bearer reader' }, signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200);
    return (await response.json()).time.map(row => [row.provider, row.costUSD, row.pricingVersion]);
  };
  const expected = [['edge', 10, version], ['edge', 2, version], [null, 5, version], ['edge', 0, null]];
  assert.deepEqual(await read(), expected);
  await publish({ ...policy, rules: [], defaults: [{ model: 'test-model', rates: rate(50) }] });
  await run();
  assert.deepEqual(await read(), expected);
});

test('历史重算预览只读，执行后备份并把渠道与新版本金额同步到服务端', { timeout: 30_000 }, async t => {
  const hub = await startServer({ DASHBOARD_TOKEN: 'reader', INGEST_TOKEN: 'collector' });
  t.after(() => hub.close());
  const root = await mkdtemp(join(tmpdir(), 'pricing-reprice-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = await openDb(join(root, 'usage.sqlite'));
  t.after(() => db.close());

  const day = usage({ costBasis: 'estimated', pricingVersion: 'old' });
  const item = event({ costBasis: 'estimated', pricingVersion: 'old', provider: 'edge',
    eventTime: '2026-09-01T01:00:00.000Z' });
  await writeSnapshot(db, { daily: [day], time: [item], sessions: [] });

  const policy = {
    timeZone: 'UTC',
    defaults: [],
    rules: [{
      provider: 'edge', model: 'test-model', enabled: true, effectiveFrom: null,
      offPeakStart: '00:00', offPeakEnd: '06:00',
      peak: { input: 300, output: 0, cacheRead: 0, cacheWrite: 0 },
      offPeak: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 }
    }]
  };
  const saved = await fetch(`${hub.base}/api/pricing`, {
    method: 'PUT', headers: { authorization: 'Bearer reader', 'content-type': 'application/json' },
    body: JSON.stringify(policy), signal: AbortSignal.timeout(5_000)
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  const { version } = await saved.json();
  const run = (...args) => runFile(process.execPath, [
    resolve('src/reprice-usage.mjs'), '--db', join(root, 'usage.sqlite'),
    '--start', '2026-09-01', '--end', '2026-09-01', '--push', `${hub.base}/api/ingest`,
    '--token', 'collector', ...args
  ], { cwd: root, env: { PATH: process.env.PATH }, timeout: 10_000 });

  const preview = await run();
  assert.match(preview.stdout, /预览.*调用: 1/);
  assert.equal((await readSnapshot(db)).time[0].costUSD, 1);
  await assert.rejects(readdir(join(root, 'data', 'backups')), { code: 'ENOENT' });
  const remote = await openDb(join(hub.root, 'usage.sqlite'), { readOnly: true });
  t.after(() => remote.close());
  assert.deepEqual((await readSnapshot(remote)).time, []);

  await run('--apply');
  const paths = await readdir(join(root, 'data', 'backups'));
  assert.equal(paths.length, 1);
  const backup = JSON.parse(await readFile(join(root, 'data', 'backups', paths[0]), 'utf8'));
  assert.equal(backup.time[0].costUSD, 1);
  for (const storage of [db, remote]) {
    const result = await readSnapshot(storage);
    assert.equal(result.time[0].provider, 'edge');
    assert.equal(result.time[0].pricingVersion, version);
    assert.ok(Math.abs(result.time[0].costUSD - 0.02) < 1e-10);
    assert.equal(result.daily[0].costUSD, result.time[0].costUSD);
  }

  const rerun = await run('--apply');
  assert.match(rerun.stdout, /执行.*调用: 0/);
  assert.match(rerun.stdout, /同步完成.*请求数: 0/);
  assert.deepEqual(await readdir(join(root, 'data', 'backups')), paths);
});
