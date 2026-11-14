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
const coversTokens = (a, b) => tokenFields.every(field => Number(a[field] ?? 0) >= Number(b[field] ?? 0));
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

export async function prepareHubPricing(db, time, pricingData, daily) {
  const events = [...new Map(time.map(row => [eventKey(row), row])).values()];
  const declared = new Map(daily.map(row => [dayKey(row), row]));
  const oldEvents = new Map((await matchingRows(db, 'time', 'time_usage',
    ['device', 'source', 'event_key'], events.map(row => [row.device, row.source, row.eventKey]), { primary: true }))
    .map(row => [eventKey(row), row]));
  const days = [...new Set([...declared.keys(), ...events.map(dayKey), ...[...oldEvents.values()].map(dayKey)])];
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
  return { days, declared, oldDays, oldEvents, time: updates };
}

export async function writeHubPricedDays(db, plan, full) {
  const { days, declared, oldDays, oldEvents, time } = plan;
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
    const old = oldDays.get(key);
    const reported = declared.get(key);
    const summary = reported || events[0] || (!full && old);
    if (!summary) continue;
    const measured = sumTokens(events);
    const previousEvents = before.get(key);
    const wasComplete = old && sameTokens(old, sumTokens(previousEvents));
    // 日汇总是用量快照。它已经包含同一日的逐笔记录，不能与明细相加。
    let tokens = reported && coversTokens(reported, measured) ? reported : measured;
    if (!full && old && !wasComplete && !coversTokens(tokens, old)) tokens = old;
    const complete = sameTokens(tokens, measured) && events.length > 0;
    const measuredCost = events.length ? summarizeEventCosts(events) : zeroCost;
    let cost = complete ? measuredCost : { ...zeroCost, costUSD: measuredCost.costUSD };

    // 补传历史明细可能与旧日费用不一致。保留已记录的金额，避免隐式重算。
    const preserve = old && (!full || sameTokens(old, tokens));
    if (preserve && (old.costUSD > 0 || old.costBasis === 'recorded')) {
      const previousCost = summarizeEventCosts(previousEvents).costUSD;
      const differs = Math.abs(previousCost - old.costUSD) > 1e-8;
      const hasHistoricalCost = differs || previousEvents.length === 0 && old.costBasis === 'recorded';
      if (hasHistoricalCost && (!wasComplete || ['legacy_unknown', 'recorded'].includes(old.costBasis))) {
        const delta = wasComplete ? Math.max(0, measuredCost.costUSD - previousCost) : 0;
        const costBasis = old.costUSD === 0 && delta === 0 && old.costBasis === 'recorded' ? 'recorded' : 'legacy_unknown';
        cost = { costUSD: old.costUSD + delta, costBasis, pricingVersion: old.pricingVersion };
      }
    }
    rows.push({ device: summary.device, source: summary.source, usageDate: summary.usageDate, model: summary.model,
      ...Object.fromEntries(tokenFields.map(field => [field, tokens[field] ?? 0])), ...cost,
      pricingLockedAt: old?.pricingLockedAt, hubRepriced: 1 });
  }
  await batchUpsertDaily(db, rows);
  return rows.length;
}
