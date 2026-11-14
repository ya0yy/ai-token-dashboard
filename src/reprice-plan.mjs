import { tokenFields } from './db-batch.mjs';
import { calculateCost, hasModelPricing } from './pricing.mjs';

const dayKey = row => JSON.stringify([row.device, row.source, row.usageDate, row.model]);
const projectKey = row => JSON.stringify([row.device, row.source, row.projectPath]);
const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
const sameAmount = (a, b) => Math.abs(a - b) <= 1e-8 + 1e-10 * Math.max(Math.abs(a), Math.abs(b));

function group(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function fullTokens(summary, events) {
  return events.length > 0 && tokenFields.every(field => sum(events, field) === Number(summary[field] || 0));
}

export function summarizeEventCosts(events) {
  const bases = new Set(events.map(event => event.costBasis));
  const versions = new Set(events.map(event => event.pricingVersion ?? null));
  const costBasis = bases.has('legacy_unknown') ? 'legacy_unknown'
    : bases.has('unknown') ? 'unknown' : bases.size === 1 ? events[0].costBasis : 'mixed';
  return { costUSD: sum(events, 'costUSD'), costBasis,
    pricingVersion: versions.size === 1 ? versions.values().next().value : null };
}

function repriceEvent(row, pricingData) {
  if (row.costBasis !== 'estimated' && !(row.costBasis === 'unknown' && Number(row.costUSD) === 0)) return null;

  // 旧 OpenClaw 时间可能来自文件，会话起点也无法用于 Hermes 逐笔计价。
  // 旧 OpenCode 和 Claude Code 的估算标记无法排除工具原有费用。
  if (row.source === 'Hermes Agent') return null;
  const needsPricingTime = ['OpenClaw', 'OpenCode', 'Claude Code'].includes(row.source);
  const eventTime = row.pricingTime ?? (needsPricingTime ? null : row.eventTime);
  if (!eventTime || !Number.isFinite(Date.parse(eventTime))) return null;

  const tokens = {
    input: Number(row.inputTokens), output: Number(row.outputTokens),
    cacheRead: Number(row.cacheReadTokens), cacheWrite: Number(row.cacheCreationTokens),
    reasoning: /^Codex CLI(?: \(JS\))?$/.test(row.source) ? 0 : Number(row.reasoningOutputTokens)
  };
  if (Object.values(tokens).reduce((a, b) => a + b, 0) !== Number(row.totalTokens)) return null;
  const options = { eventTime, tiered: row.source !== 'Grok CLI' };
  if (!hasModelPricing(row.model, pricingData, row.provider, options)) return null;
  const costUSD = calculateCost(row.model, tokens, pricingData, row.provider, options);
  if (!Number.isFinite(costUSD) || costUSD < 0) return null;
  const pricingVersion = pricingData.version ?? null;
  if (row.costBasis === 'estimated' && Number(row.costUSD) === costUSD && row.pricingVersion === pricingVersion) return null;
  return { ...row, costUSD, costBasis: 'estimated', pricingVersion };
}

function updateLegacySessions(sessions, events, changed, skipped) {
  const projects = group(events, projectKey);
  const candidates = [];
  for (const row of sessions) {
    // 兼容表的 sessionId 实际按工作区和模型聚合，不能用调用的 sessionId 关联。
    if (!row.projectPath || !row.sessionId.startsWith('local:')) continue;
    const project = projects.get(projectKey(row)) || [];
    const models = [...new Set(project.map(event => event.model).filter(model => row.sessionId.endsWith(`:${model}`)))];
    const detail = models.length === 1 ? project.filter(event => event.model === models[0]) : [];
    if (detail.some(event => changed.has(event))) candidates.push({ row, detail });
  }

  const owners = new Map();
  for (const { detail } of candidates) for (const event of detail) owners.set(event, (owners.get(event) || 0) + 1);
  return candidates.flatMap(({ row, detail }) => {
    if (detail.some(event => owners.get(event) > 1) || !fullTokens(row, detail)
      || !sameAmount(Number(row.costUSD), sum(detail, 'costUSD'))) {
      skipped.incompleteSession++;
      return [];
    }
    const costUSD = sum(detail.map(event => changed.get(event) || event), 'costUSD');
    return costUSD === Number(row.costUSD) ? [] : [{ ...row, costUSD }];
  });
}

/** 以完整日汇总为单位重算，让调用明细与看板总额一起提交。 */
export function planReprice(previous, pricingData, { start, end, model } = {}) {
  const buckets = group(previous.time, dayKey);
  const changed = new Map();
  const daily = [];
  const skipped = { incompleteDetail: 0, costMismatch: 0, recordedDay: 0, noEligibleEvents: 0, incompleteSession: 0 };
  let costBefore = 0;
  let costAfter = 0;

  for (const row of previous.daily) {
    if ((start && row.usageDate < start) || (end && row.usageDate > end) || (model && row.model !== model)) continue;
    const detail = buckets.get(dayKey(row)) || [];
    if (!fullTokens(row, detail)) { skipped.incompleteDetail++; continue; }
    if (!sameAmount(Number(row.costUSD), sum(detail, 'costUSD'))) { skipped.costMismatch++; continue; }
    if (row.costBasis === 'recorded') { skipped.recordedDay++; continue; }
    for (const event of detail) {
      const next = repriceEvent(event, pricingData);
      if (next) changed.set(event, next);
    }
    if (!detail.some(event => changed.has(event))) { skipped.noEligibleEvents++; continue; }

    const updated = detail.map(event => changed.get(event) || event);
    const costs = summarizeEventCosts(updated);
    daily.push({ ...row, ...costs });
    costBefore += Number(row.costUSD);
    costAfter += costs.costUSD;
  }

  const sessions = changed.size ? updateLegacySessions(previous.sessions, previous.time, changed, skipped) : [];
  return { next: { daily, time: [...changed.values()], sessions }, skipped, costBefore, costAfter };
}
