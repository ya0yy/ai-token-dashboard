import { batchUpsertDaily, batchUpsertSession, fromStored, tokenFields } from './db-batch.mjs';
import { collectionScopeKey } from './collection-state.mjs';
import { digest, exactColumn, recordTimeDeletions } from './sync-journal.mjs';

const scopeWhere = db => `${exactColumn(db, 'device')} = ? AND ${exactColumn(db, 'source')} = ?`;

async function subtractSummary(db, kind, table, keyWhere, params, event, write) {
  const where = `${scopeWhere(db)} AND ${keyWhere}`;
  const stored = await db.get(`SELECT * FROM ${table} WHERE ${where}`, params);
  if (!stored) return;
  const row = fromStored(kind, stored);
  // 只扣除已核实事件的贡献，保留日汇总中没有逐笔明细的历史用量。
  for (const field of tokenFields) row[field] = Math.max(0, row[field] - event[field]);
  row.costUSD = Math.max(0, row.costUSD - event.costUSD);
  if (row.totalTokens || row.costUSD > 1e-8) {
    await write(db, [row]);
  } else {
    await db.run(`DELETE FROM ${table} WHERE ${where}`, params);
    // 离线目标可能仍有这条旧汇总等待上报，清除它的待发送值。
    await db.run('DELETE FROM sync_changes WHERE scope_key = ? AND row_key = ?',
      [collectionScopeKey(row), digest([kind, ...params])]);
  }
}

// 调用方在设备和来源锁下执行，事件、汇总及同步日志一起提交。
export async function deleteCoveredPiSummaries(db, rows) {
  const removed = [];
  for (const { device, source, eventKey } of rows) {
    if (source !== 'Pi Agent') throw new Error('只允许移除已核实的 Pi Agent 子代理汇总');
    const scope = [device, source];
    const where = `${scopeWhere(db)} AND ${exactColumn(db, 'event_key')} = ?`;
    const stored = await db.get(`SELECT * FROM time_usage WHERE ${where}`, [...scope, eventKey]);
    if (!stored) continue;
    const event = fromStored('time', stored);
    if (event.billedCostUSD != null) throw new Error('子代理汇总含已确认的供应商账单，请核查事件');
    await db.run(`DELETE FROM time_usage WHERE ${where}`, [...scope, eventKey]);
    await subtractSummary(db, 'daily', 'daily_usage', `usage_date = ? AND ${exactColumn(db, 'model')} = ?`,
      [...scope, event.usageDate, event.model], event, batchUpsertDaily);
    const workspace = event.projectPath || event.sessionId;
    await subtractSummary(db, 'sessions', 'session_usage', `${exactColumn(db, 'session_id')} = ?`,
      [...scope, ['local', 'pi', workspace || 'no-workspace', event.model].join(':')], event, batchUpsertSession);
    removed.push(event);
  }
  if (removed.length) await recordTimeDeletions(db, removed);
  return removed.length;
}
