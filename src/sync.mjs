import { randomUUID } from 'node:crypto';
import { readSnapshot } from './usage-store.mjs';
import { collectionScopeKey, lockCollectionState } from './collection-state.mjs';
import { digest, exactColumn } from './sync-journal.mjs';

const LEASE_MS = 120_000; // Each HTTP request times out after 60 seconds.
const HUB_USAGE_PROTOCOL = 2; // Transmits daily snapshots in addition to call details.
const emptySnapshot = () => ({ daily: [], time: [], sessions: [] });

function usageOnly({ costUSD, costBasis, pricingVersion, pricingLockedAt, hubRepriced, billedCostUSD, ...row }) {
  return billedCostUSD == null ? row : { ...row, billedCostUSD };
}

async function claim(db, targetKey, scopeKey, owner) {
  await db.run(`INSERT INTO sync_targets (target_key, scope_key) VALUES (?, ?)
    ${db.driver === 'mysql' ? 'ON DUPLICATE KEY UPDATE target_key = VALUES(target_key)' : 'ON CONFLICT(target_key) DO NOTHING'}`,
  [targetKey, scopeKey]);
  await db.run('UPDATE sync_targets SET lease_owner = ?, lease_until = ? WHERE target_key = ? AND lease_until <= ?',
    [owner, Date.now() + LEASE_MS, targetKey, Date.now()]);
  const target = await db.get('SELECT acknowledged_revision, usage_protocol, lease_owner FROM sync_targets WHERE target_key = ?', [targetKey]);
  if (target.lease_owner !== owner) throw new Error('Sync already running for this target, device and source; retry after it finishes (or after two minutes following a crash)');
  const revision = target.acknowledged_revision == null ? null : Number(target.acknowledged_revision);
  return { revision, protocol: Number(target.usage_protocol) };
}

async function renew(db, targetKey, owner) {
  await db.run('UPDATE sync_targets SET lease_until = ? WHERE target_key = ? AND lease_owner = ? AND lease_until > ?',
    [Date.now() + LEASE_MS, targetKey, owner, Date.now()]);
  const lease = await db.get('SELECT lease_owner, lease_until FROM sync_targets WHERE target_key = ?', [targetKey]);
  if (lease.lease_owner !== owner || Number(lease.lease_until) <= Date.now()) throw new Error('Sync lease expired; retry without advancing progress');
}

async function capture(db, scope, after, full, resync) {
  return db.transaction(async tx => {
    await lockCollectionState(tx, scope);
    const key = collectionScopeKey(scope);
    const state = await tx.get('SELECT revision, reset_revision FROM sync_scopes WHERE scope_key = ?', [key]);
    const revision = Number(state.revision);
    const replacement = full || Number(state.reset_revision) > (after ?? 0);
    if (after != null && after > revision && !full) throw new Error('Sync progress is ahead of source history; restore the complete database or use --full --apply');
    if (!replacement && !resync && after === revision) return { revision, snapshot: emptySnapshot(), mode: 'incremental' };
    if (replacement) return { revision, mode: 'full', snapshot: await readSnapshot(tx, scope.device, scope.source) };
    const baseline = after == null || resync;
    const snapshot = baseline ? await readSnapshot(tx, scope.device, scope.source) : emptySnapshot();
    const changes = await tx.all(`SELECT kind, payload_json FROM sync_changes WHERE scope_key = ? AND revision > ? AND revision <= ?
      ${baseline ? "AND kind = 'time-delete'" : ''} ORDER BY revision, row_key`,
      [key, after ?? 0, revision]);
    for (const row of changes) {
      if (row.kind === 'time-delete') (snapshot.removeTime ??= []).push(JSON.parse(row.payload_json));
      else if (!baseline) snapshot[row.kind].push(JSON.parse(row.payload_json));
    }
    return { revision, snapshot, mode: 'incremental' };
  });
}

async function acknowledge(db, targetKey, scopeKey, owner, revision, protocol) {
  await db.transaction(async tx => {
    await renew(tx, targetKey, owner);
    await tx.run('UPDATE sync_targets SET acknowledged_revision = ?, usage_protocol = ? WHERE target_key = ? AND lease_owner = ?',
      [revision, protocol, targetKey, owner]);
    // Offline targets retain their progress. New targets always get a baseline,
    // so pruning acknowledged records cannot strand either kind of receiver.
    const { floor } = await tx.get('SELECT MIN(COALESCE(acknowledged_revision, 0)) AS floor FROM sync_targets WHERE scope_key = ?', [scopeKey]);
    await tx.run('DELETE FROM sync_changes WHERE scope_key = ? AND revision <= ?', [scopeKey, Number(floor)]);
  });
}

/** First connection captures a baseline. Later runs read only transactional
 * changes; old event timestamps, repeated payloads and lost responses are safe.
 * No database transaction is held open across a network request. */
export async function syncDatabase({ db, url, token, device, source, full = false, resync = false,
  scopes, hubPricing = false, fetcher = fetch }) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Use an HTTP(S) ingest URL and --token');
  target.hash = '';
  const selected = full && scopes ? scopes : await db.all(`SELECT device, source FROM sync_scopes WHERE ${exactColumn(db, 'device')} = ?${source ? ` AND ${exactColumn(db, 'source')} = ?` : ''} ORDER BY scope_key`,
    [device, ...(source ? [source] : [])]);
  const result = { requests: 0, rows: { daily: 0, time: 0, sessions: 0 } };
  for (const scope of selected) {
    const scopeKey = collectionScopeKey(scope), targetKey = digest([target.href, scope.device, scope.source]);
    const owner = randomUUID();
    const { revision: after, protocol: previousProtocol } = await claim(db, targetKey, scopeKey, owner);
    const protocol = hubPricing ? HUB_USAGE_PROTOCOL : previousProtocol;
    const upgrade = protocol !== previousProtocol;
    try {
      // 新协议补传之前跳过的日汇总，首次使用时重发本机基线。
      const plan = await capture(db, scope, after, full, resync || upgrade);
      const send = async (payload, correction = false) => {
        if (hubPricing) payload = { mode: payload.mode, scopes: payload.scopes, pricing: 'hub',
          daily: payload.daily.map(usageOnly), time: payload.time.map(usageOnly), removeTime: payload.removeTime };
        const body = JSON.stringify(payload);
        if (Buffer.byteLength(body) > 48 * 1024 * 1024) throw new Error('Replacement exceeds 48 MiB; rebuild one source at a time with --source');
        await renew(db, targetKey, owner);
        const response = await fetcher(target.href, {
          // 旧 Hub 会拒绝 PATCH，采集器因此保留待发送的删除记录。
          method: correction ? 'PATCH' : hubPricing ? 'PUT' : 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body, signal: AbortSignal.timeout(60_000)
        });
        if (!response.ok) {
          if (correction && [404, 405].includes(response.status)) throw new Error('上报失败：请先升级 Hub 以同步 Pi Agent 重复汇总删除。');
          if (hubPricing && [404, 405].includes(response.status)) throw new Error('上报失败：请先升级 Hub 以支持服务端入库计价。');
          const error = await response.json().catch(() => null);
          if (hubPricing && error?.error === 'Hub 计价上报仅接受调用明细') {
            throw new Error('上报失败：请先升级 Hub 以接收日汇总。');
          }
          throw new Error(`上报失败（HTTP ${response.status}），请检查 Hub 日志。`);
        }
        if ((await response.json()).ok !== true) throw new Error('Hub did not acknowledge upload');
        result.requests++;
      };
      if (plan.mode === 'full') await send({ mode: 'full', scopes: [scope], ...plan.snapshot });
      else {
        const { daily, time, sessions, removeTime = [] } = plan.snapshot;
        const correction = removeTime.length > 0;
        const count = Math.max(daily.length, time.length, hubPricing ? 0 : sessions.length, Number(correction));
        for (let i = 0; i < count; i += 1000) {
          // 明细分批时先同步前面的批次，最后一次把剩余明细与删除放在同一事务。
          await send({ mode: 'incremental', daily: daily.slice(i, i + 1000), time: time.slice(i, i + 1000),
            sessions: sessions.slice(i, i + 1000), ...(correction && i + 1000 >= count ? { removeTime } : {}) }, correction);
        }
      }
      if (after !== plan.revision || upgrade || plan.mode === 'full') await acknowledge(db, targetKey, scopeKey, owner, plan.revision, protocol);
      for (const kind of hubPricing ? ['daily', 'time'] : Object.keys(result.rows)) result.rows[kind] += plan.snapshot[kind].length;
    } finally {
      await db.run('UPDATE sync_targets SET lease_owner = NULL, lease_until = 0 WHERE target_key = ? AND lease_owner = ?', [targetKey, owner]);
    }
  }
  return result;
}
