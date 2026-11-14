import { batchUpsertDaily, fromStored, tokenFields } from './db-batch.mjs';
import { mysqlRowKey } from './db.mjs';
import { isLegacyPiZero, priceUsageEvent, summarizeEventCosts } from './reprice-plan.mjs';
import { exactColumn } from './sync-journal.mjs';
import { rowKey } from './usage-store.mjs';

const dayKey = row => rowKey('daily', row);
const eventKey = row => rowKey('time', row);
const sumTokens = rows => Object.fromEntries(tokenFields.map(field =>
  [field, rows.reduce((sum, row) => sum + Number(row[field] ?? 0), 0)]));
const sameTokens = (a, b) => tokenFields.every(field => Number(a[field] ?? 0) === Number(b[field] ?? 0));
const zeroCost = { costUSD: 0, costBasis: 'unknown', pricingVersion: null };

// 限定查询到本次上报的键，避免每次增量都加载该设备的全部历史。
async function matchingRows(db, kind, table, columns, tuples, { primary = false } = {}) {
  const rows = [];
  for (let offset = 0; offset < tuples.length; offset += 200) {
    const batch = tuples.slice(offset, offset + 200);
    const primaryKey = db.driver === 'mysql' && primary;
    const fields = primaryKey ? ['row_key'] : columns.map(column => exactColumn(db, column));
    const keys = primaryKey ? batch.map(parts => [mysqlRowKey(...parts)]) : batch;
    const placeholders = keys.map(values => `(${values.map(() => '?').join(', ')})`).join(', ');
    const stored = await db.all(`SELECT * FROM ${table} WHERE (${fields.join(', ')}) IN (${placeholders})`, keys.flat());
    for (const row of stored) rows.push(fromStored(kind, row));
  }
  return rows;
}

const dayColumns = ['device', 'source', 'usage_date', 'model'];

export async function prepareHubPricing(db, time, pricingData) {
  const events = [...new Map(time.map(row => [eventKey(row), row])).values()];
  const oldEvents = new Map((await matchingRows(db, 'time', 'time_usage',
    ['device', 'source', 'event_key'], events.map(row => [row.device, row.source, row.eventKey]), { primary: true }))
    .map(row => [eventKey(row), row]));
  const days = [...new Set([...events.map(dayKey), ...[...oldEvents.values()].map(dayKey)])];
  const oldDays = new Map((await matchingRows(db, 'daily', 'daily_usage', dayColumns, days.map(key => JSON.parse(key)), { primary: true }))
    .map(row => [dayKey(row), row]));
  const updates = events.map(row => {
    const old = oldEvents.get(eventKey(row));
    const billedCostUSD = row.billedCostUSD ?? old?.billedCostUSD ?? null;
    if (billedCostUSD != null) {
      return { ...row, billedCostUSD, costUSD: billedCostUSD, costBasis: 'recorded', pricingVersion: null, hubRepriced: 1 };
    }
    if (old && (row.model ?? '') === old.model && sameTokens(row, old)) {
      // 旧 Pi 零估价保留金额，供定价页预览后补算。新版上报可补上渠道和调用时间。
      return { ...row, provider: row.provider ?? old.provider, pricingTime: row.pricingTime ?? old.pricingTime,
        billedCostUSD: null, costUSD: old.costUSD, costBasis: row.pricingTime && isLegacyPiZero(old) ? 'estimated' : old.costBasis,
        pricingVersion: old.pricingVersion, hubRepriced: 1 };
    }
    // 缺少可靠调用时间的记录只用模型默认价，并按聚合用量计价。
    const price = priceUsageEvent(row, pricingData, row.pricingTime);
    return { ...row, billedCostUSD: null, ...(price ?? zeroCost), hubRepriced: 1 };
  });
  return { days, oldDays, oldEvents, time: updates };
}

export async function writeHubPricedDays(db, plan, full) {
  const { days, oldDays, oldEvents, time } = plan;
  const stored = await matchingRows(db, 'time', 'time_usage', dayColumns, days.map(key => JSON.parse(key)));
  const byDay = new Map(days.map(key => [key, []]));
  for (const event of stored) byDay.get(dayKey(event)).push(event);

  // 多批上报期间保留尚未收到全部明细的旧日汇总。
  const changed = new Set(time.map(eventKey));
  const before = new Map(days.map(key => [key, []]));
  for (const event of [...stored.filter(row => !changed.has(eventKey(row))), ...oldEvents.values()]) {
    before.get(dayKey(event)).push(event);
  }
  const rows = [];
  for (const [key, events] of byDay) {
    const old = full ? null : oldDays.get(key);
    const summary = old || events[0];
    if (!summary) continue;
    const tokens = sumTokens(events);
    const complete = !old || sameTokens(old, tokens) || sameTokens(old, sumTokens(before.get(key)));
    if (!complete) continue;
    const cost = events.length ? summarizeEventCosts(events) : zeroCost;
    rows.push({ device: summary.device, source: summary.source, usageDate: summary.usageDate, model: summary.model,
      ...tokens, ...cost, hubRepriced: 1 });
  }
  await batchUpsertDaily(db, rows);
  return rows.length;
}
