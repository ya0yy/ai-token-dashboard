import { batchUpsertDaily, fromStored, tokenFields } from './db-batch.mjs';
import { readReportedEvents, readUsageDayTotals } from './hub-ingest-pricing.mjs';
import { exactColumn } from './sync-journal.mjs';
import { rowKey } from './usage-store.mjs';

function sameTokens(a, b) {
  return tokenFields.every(field => Number(a[field] ?? 0) === Number(b[field] ?? 0));
}

function preservedCost(row, old) {
  return { ...row, costUSD: old.costUSD, costBasis: old.costBasis,
    pricingVersion: old.pricingVersion, billedCostUSD: old.billedCostUSD, hubRepriced: 1 };
}

// 调用方先锁定上报涉及的范围。全量替换前也要读取旧记录，以便识别重复上报。
export async function preserveHubRepricing(db, scopes, daily, time) {
  const oldDays = new Map();
  const oldEvents = new Map();
  const scopeKey = row => JSON.stringify([row.device, row.source]);
  const protectedScopes = new Set();
  for (const scope of scopes) {
    const where = `${exactColumn(db, 'device')} = ? AND ${exactColumn(db, 'source')} = ? AND hub_repriced = 1`;
    const params = [scope.device, scope.source];
    const storedDays = await db.all(`SELECT * FROM daily_usage WHERE ${where}`, params);
    if (storedDays.length) protectedScopes.add(scopeKey(scope));
    for (const row of storedDays) {
      const day = fromStored('daily', row);
      oldDays.set(rowKey('daily', day), day);
    }
  }
  for (const event of await readReportedEvents(db, time.filter(row => protectedScopes.has(scopeKey(row))))) {
    if (event.hubRepriced) oldEvents.set(rowKey('time', event), event);
  }

  const affected = new Set();
  const days = daily.map(row => {
    const key = rowKey('daily', row);
    const old = oldDays.get(key);
    if (!old) return row;
    affected.add(key);
    return preservedCost(row, old);
  });
  const events = time.map(row => {
    const day = rowKey('daily', row);
    if (oldDays.has(day)) affected.add(day);
    const old = oldEvents.get(rowKey('time', row));
    if (!old) return row;
    const previousDay = rowKey('daily', old);
    if (oldDays.has(previousDay)) affected.add(previousDay);
    if (old.model !== row.model || !sameTokens(old, row)) return row;
    return preservedCost({ ...row, provider: row.provider ?? old.provider, pricingTime: row.pricingTime ?? old.pricingTime }, old);
  });
  return { daily: days, time: events, affected: [...affected].map(key => oldDays.get(key)) };
}

export async function reconcileHubRepricing(db, affected) {
  const updates = [];
  const totals = await readUsageDayTotals(db, affected.map(day => rowKey('daily', day)));
  for (const day of affected) {
    const where = ['device', 'source', 'usage_date', 'model'].map(column => `${exactColumn(db, column)} = ?`).join(' AND ');
    const params = [day.device, day.source, day.usageDate, day.model];
    const stored = await db.get(`SELECT * FROM daily_usage WHERE ${where}`, params);
    if (!stored) continue;
    const summary = fromStored('daily', stored);
    const detail = totals.get(rowKey('daily', day));
    if (!detail) continue;
    // 同步可能先写日汇总、再分批写明细。明细到齐前保留旧金额。
    if (sameTokens(detail.tokens, summary)) updates.push({ ...summary, ...detail.cost });
  }
  await batchUpsertDaily(db, updates);
}
