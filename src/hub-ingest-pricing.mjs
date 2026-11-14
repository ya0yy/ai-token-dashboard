import { batchUpsertDaily, fromStored, TABLES, tokenFields } from './db-batch.mjs';
import { mysqlRowKey } from './db.mjs';
import { isLegacyPiZero, priceUsageEvent } from './reprice-plan.mjs';
import { exactColumn } from './sync-journal.mjs';
import { rowKey } from './usage-store.mjs';

const dayKey = row => rowKey('daily', row);
const eventKey = row => rowKey('time', row);
const tokenColumns = TABLES.time.fields.filter(([, name]) => tokenFields.includes(name));
const sameTokens = (a, b) => tokenFields.every(field => Number(a[field] ?? 0) === Number(b[field] ?? 0));
const coversTokens = (a, b) => tokenFields.every(field => Number(a[field] ?? 0) >= Number(b[field] ?? 0));
const zeroCost = { costUSD: 0, costBasis: 'unknown', pricingVersion: null };
const emptyDay = { events: 0, tokens: {}, cost: zeroCost };

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

// 一个上传批次可能触及大量历史调用。让数据库汇总，只把每天每个模型的结果返回给 Node。
export async function readUsageDayTotals(db, days) {
  const totals = new Map();
  const fields = dayColumns.map(column => exactColumn(db, column));
  for (let offset = 0; offset < days.length; offset += 200) {
    const params = days.slice(offset, offset + 200).flatMap(key => JSON.parse(key));
    const predicates = Array(params.length / fields.length).fill(`(${fields.map(field => `${field} = ?`).join(' AND ')})`);
    const rows = await db.all(`SELECT ${fields.map((field, i) => `${field} AS ${dayColumns[i]}`).join(', ')},
      ${tokenColumns.map(([column]) => `SUM(${column}) AS ${column}`).join(', ')},
      COUNT(*) AS events, SUM(cost_usd) AS cost_usd, MIN(cost_basis) AS min_basis, MAX(cost_basis) AS max_basis,
      MAX(CASE WHEN cost_basis = 'legacy_unknown' THEN 1 ELSE 0 END) AS has_legacy,
      MAX(CASE WHEN cost_basis = 'unknown' THEN 1 ELSE 0 END) AS has_unknown,
      COUNT(pricing_version) AS versions, MIN(pricing_version) AS min_version, MAX(pricing_version) AS max_version
      FROM time_usage WHERE ${predicates.join(' OR ')} GROUP BY ${fields.join(', ')}`, params);
    for (const row of rows) {
      const events = Number(row.events);
      const costBasis = Number(row.has_legacy) ? 'legacy_unknown' : Number(row.has_unknown) ? 'unknown'
        : row.min_basis === row.max_basis ? row.min_basis : 'mixed';
      const pricingVersion = Number(row.versions) === events && row.min_version === row.max_version ? row.min_version : null;
      const key = JSON.stringify(dayColumns.map(column => row[column]));
      totals.set(key, { events, cost: { costUSD: Number(row.cost_usd), costBasis, pricingVersion },
        tokens: Object.fromEntries(tokenColumns.map(([column, field]) => [field, Number(row[column])])) });
    }
  }
  return totals;
}

export async function readReportedEvents(db, time) {
  return matchingRows(db, 'time', 'time_usage', ['device', 'source', 'event_key'],
    time.map(row => [row.device, row.source, row.eventKey]), { primary: true });
}

export async function prepareHubPricing(db, time, pricingData, daily) {
  const events = [...new Map(time.map(row => [eventKey(row), row])).values()];
  const declared = new Map(daily.map(row => [dayKey(row), row]));
  const oldEvents = new Map((await readReportedEvents(db, events)).map(row => [eventKey(row), row]));
  const days = [...new Set([...declared.keys(), ...events.map(dayKey), ...[...oldEvents.values()].map(dayKey)])];
  const oldDays = new Map((await matchingRows(db, 'daily', 'daily_usage', dayColumns, days.map(key => JSON.parse(key)), { primary: true }))
    .map(row => [dayKey(row), row]));
  const before = await readUsageDayTotals(db, [...oldDays.keys()]);
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
  return { days, declared, oldDays, before, time: updates };
}

export async function writeHubPricedDays(db, plan, full) {
  const { days, declared, oldDays, before } = plan;
  const after = await readUsageDayTotals(db, days);
  const rows = [];
  for (const key of days) {
    const old = oldDays.get(key);
    const reported = declared.get(key);
    const current = after.get(key) ?? emptyDay;
    if (!reported && !current.events && (full || !old)) continue;
    const previous = before.get(key) ?? emptyDay;
    const measured = current.tokens;
    const wasComplete = old && sameTokens(old, previous.tokens);
    // 日汇总是用量快照。它已经包含同一日的逐笔记录，不能与明细相加。
    let tokens = reported && coversTokens(reported, measured) ? reported : measured;
    if (!full && old && !wasComplete && !coversTokens(tokens, old)) tokens = old;
    const complete = sameTokens(tokens, measured) && current.events > 0;
    const measuredCost = current.cost;
    let cost = complete ? measuredCost : { ...zeroCost, costUSD: measuredCost.costUSD };

    // 补传历史明细可能与旧日费用不一致。保留已记录的金额，避免隐式重算。
    const preserve = old && (!full || sameTokens(old, tokens));
    if (preserve && (old.costUSD > 0 || old.costBasis === 'recorded')) {
      const previousCost = previous.cost.costUSD;
      const differs = Math.abs(previousCost - old.costUSD) > 1e-8;
      const hasHistoricalCost = differs || previous.events === 0 && old.costBasis === 'recorded';
      if (hasHistoricalCost && (!wasComplete || ['legacy_unknown', 'recorded'].includes(old.costBasis))) {
        const delta = wasComplete ? Math.max(0, measuredCost.costUSD - previousCost) : 0;
        const costBasis = old.costUSD === 0 && delta === 0 && old.costBasis === 'recorded' ? 'recorded' : 'legacy_unknown';
        cost = { costUSD: old.costUSD + delta, costBasis, pricingVersion: old.pricingVersion };
      }
    }
    const [device, source, usageDate, model] = JSON.parse(key);
    rows.push({ device, source, usageDate, model,
      ...Object.fromEntries(tokenFields.map(field => [field, tokens[field] ?? 0])), ...cost,
      pricingLockedAt: old?.pricingLockedAt, hubRepriced: 1 });
  }
  await batchUpsertDaily(db, rows);
  return rows.length;
}
