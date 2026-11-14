import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from './helpers/server.mjs';
import { openDb } from '../src/db.mjs';
import { readSnapshot } from '../src/usage-store.mjs';
import { syncDatabase } from '../src/sync.mjs';

const runFile = promisify(execFile);

const collector = resolve('src/collect.mjs');

test('Pi 补采子会话后，本机和 Hub 只移除已核实的父会话汇总', { timeout: 20_000 }, async t => {
  const hub = await startServer({ INGEST_TOKEN: 'test-token' });
  t.after(() => hub.close());
  const root = join(hub.root, 'pi');
  mkdirSync(root);
  const scope = { device: 'pi-test', source: 'Pi Agent' };
  const dbPath = join(hub.root, 'collector.sqlite');
  const local = await openDb(dbPath);
  const remote = await openDb(join(hub.root, 'usage.sqlite'), { readOnly: true });
  t.after(async () => { await local.close(); await remote.close(); });
  const run = () => runFile(process.execPath, [collector, '--db', dbPath, '--device', scope.device, '--source', scope.source], {
    cwd: hub.root, timeout: 5000, env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: root, DISPLAY_TZ: 'Asia/Shanghai' }
  });
  const sync = options => syncDatabase({ db: local, ...scope, url: hub.base + '/api/ingest',
    token: 'test-token', hubPricing: true, ...options });
  const save = (file, id, ...rows) => writeFileSync(join(root, file), [
    { type: 'session', id, cwd: '/work/pi' }, ...rows
  ].map(row => JSON.stringify(row)).join('\n'));
  const entry = (id, message, timestamp = '2026-10-29T03:00:00Z') => ({ type: 'message', id, timestamp, message });
  const usage = { input: 100, output: 20, cost: { total: 0 } };
  const separateUsage = { input: 50, cost: { total: 2 } };
  save('parent.jsonl', 'parent', entry('summary', { role: 'toolResult', toolName: 'subagent', usage,
    details: { results: [{ sessionFile: 'child.jsonl', usage }] } }),
    entry('separate-summary', { role: 'toolResult', toolName: 'subagent', model: 'old-model', usage: separateUsage,
      details: { results: [{ sessionFile: 'separate.jsonl', usage: separateUsage }] } }),
    entry('other', { role: 'toolResult', toolName: 'another-tool', usage: { input: 7 } }));
  await run();
  await sync();
  // 第二个同步目标的进度停在父会话已经上报的版本。
  await sync({ url: hub.base + '/api/ingest?target=offline' });
  assert.equal((await readSnapshot(remote)).time.length, 3);

  save('child.jsonl', 'child', entry('child-call', { role: 'assistant', model: 'child-model', usage }, '2026-10-29T02:59:59Z'));
  save('separate.jsonl', 'separate', entry('other-child-call', { role: 'assistant', model: 'child-model',
    usage: { ...separateUsage, cost: { total: 2, totalFromProvider: true } } }, '2026-10-29T02:59:59Z'));
  await run();
  const assertCorrected = async db => {
    const snapshot = await readSnapshot(db);
    assert.deepEqual(snapshot.time.map(row => row.totalTokens).sort((a, b) => a - b), [7, 50, 120]);
    assert.deepEqual(snapshot.daily.map(row => [row.model, row.totalTokens, row.costUSD]).sort(), [['child-model', 170, 2], ['unknown', 7, 0]]);
  };
  await assertCorrected(local);
  assert.equal((await readSnapshot(local)).sessions.find(row => row.sessionId.endsWith(':unknown')).totalTokens, 7);
  assert.ok(!(await readSnapshot(local)).sessions.some(row => row.sessionId.endsWith(':old-model')));
  await assert.rejects(sync({ fetcher: async () => new Response(null, { status: 404 }) }), /先升级 Hub/);
  assert.equal((await readSnapshot(remote)).time.length, 3);
  await assert.rejects(sync({ fetcher: async (...args) => {
    const response = await fetch(...args);
    if (args[1].method === 'PATCH') { await response.json(); throw new Error('删除响应丢失'); }
    return response;
  } }), /删除响应丢失/);
  await assertCorrected(remote);
  await sync();
  await assertCorrected(remote);
  assert.equal((await sync()).requests, 0);
  await sync({ url: hub.base + '/api/ingest?target=offline', resync: true });
  await assertCorrected(remote);
});

test('CLI collection, late usage, full preview, backup and replacement preserve amounts and scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'collect-flow-'));
  const sessions = join(root, 'sessions'); mkdirSync(sessions);
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ collectors: { pi: { roots: [sessions] } } }));
  const dbPath = join(root, 'usage.sqlite');
  const env = { PATH: process.env.PATH, AI_TOKEN_DASHBOARD_CONFIG: config, AI_TOKEN_DASHBOARD_CACHE_DIR: join(root, 'cache'), DISPLAY_TZ: 'UTC' };
  const run = (...args) => spawnSync(process.execPath, [collector, '--db', dbPath, '--device', 'test-device', '--source', 'Pi Agent', ...args], { cwd: root, env, encoding: 'utf8' });
  const message = (id, day) => ({ type: 'message', id, timestamp: `${day}T12:00:00.000Z`, message: { role: 'assistant', model: 'test-model', usage: { input: 100, output: 10, cost: { total: 0.25 } } } });
  const save = rows => writeFileSync(join(sessions, 's.jsonl'), [{ type: 'session', version: 3, id: 's', cwd: '/project/A' }, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n');
  const query = sql => { const db = new DatabaseSync(dbPath, { readOnly: true }); try { return db.prepare(sql).all().map(row => ({ ...row })); } finally { db.close(); } };
  try {
    save([message('old', '2025-01-01')]);
    let result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(query('SELECT COUNT(*) n FROM time_usage')[0].n, 1, 'old events must not silently expire at collection');
    save([message('old', '2025-01-01'), message('late', '2025-01-01'), message('other-day', '2025-01-02')]);
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(query("SELECT cost_usd FROM daily_usage WHERE usage_date='2025-01-01'")[0].cost_usd, 0.5);
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(query('SELECT SUM(cost_usd) cost FROM daily_usage')[0].cost, 0.75);
    save([message('other-day', '2025-01-02')]);
    result = run('--full'); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /preview/);
    assert.equal(query('SELECT COUNT(*) n FROM daily_usage')[0].n, 2, 'preview must leave the database untouched');
    result = run('--full', '--apply'); assert.equal(result.status, 0, result.stderr);
    assert.equal(query('SELECT COUNT(*) n FROM daily_usage')[0].n, 1);
    assert.equal(query('SELECT SUM(cost_usd) cost FROM daily_usage')[0].cost, 0.25);
    const files = readdirSync(join(root, 'data', 'backups'));
    assert.equal(files.length, 1);
    const backup = JSON.parse(readFileSync(join(root, 'data', 'backups', files[0]), 'utf8'));
    assert.equal(backup.daily.length, 2); assert.equal(backup.time.length, 3);
    save([]);
    result = run('--full', '--apply'); assert.notEqual(result.status, 0); assert.match(result.stderr, /refusing to erase history/);
    assert.equal(query('SELECT COUNT(*) n FROM daily_usage')[0].n, 1);
    const restore = (...args) => spawnSync(process.execPath, [resolve('src/restore-usage.mjs'), '--db', dbPath, '--file', join(root, 'data', 'backups', files[0]), ...args], { cwd: root, env, encoding: 'utf8' });
    result = restore(); assert.equal(result.status, 0, result.stderr);
    assert.equal(query('SELECT COUNT(*) n FROM daily_usage')[0].n, 1, 'restore also defaults to preview');
    result = restore('--apply'); assert.equal(result.status, 0, result.stderr);
    assert.equal(query('SELECT COUNT(*) n FROM daily_usage')[0].n, 2);
    assert.equal(query('SELECT SUM(cost_usd) cost FROM daily_usage')[0].cost, 0.75);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
