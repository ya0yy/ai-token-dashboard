import { tokenFields } from './db-batch.mjs';
import { calculateCost, hasModelPricing } from './pricing.mjs';
import { rowKey } from './usage-store.mjs';

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

// 旧版 Pi 把日志估价写成了 recorded，且没有保存实际账单字段。
export function isLegacyPiZero(row) {
  return row.source === 'Pi Agent' && row.costBasis === 'recorded' && Number(row.costUSD) === 0
    && row.billedCostUSD == null && row.pricingVersion == null && row.pricingTime == null;
}

export function priceUsageEvent(row, pricingData, eventTime, provider = row.provider) {
  const tokens = {
    input: Number(row.inputTokens ?? 0), output: Number(row.outputTokens ?? 0),
    cacheRead: Number(row.cacheReadTokens ?? 0), cacheWrite: Number(row.cacheCreationTokens ?? 0),
    reasoning: /^Codex CLI(?: \(JS\))?$/.test(row.source) ? 0 : Number(row.reasoningOutputTokens ?? 0)
  };
  if (Object.values(tokens).reduce((a, b) => a + b, 0) !== Number(row.totalTokens)) return null;
  const options = { eventTime, tiered: row.source !== 'Grok CLI' && eventTime != null };
  if (!hasModelPricing(row.model, pricingData, provider, options)) return null;
  const costUSD = calculateCost(row.model, tokens, pricingData, provider, options);
  if (!Number.isFinite(costUSD) || costUSD < 0) return null;
  return { costUSD, costBasis: 'estimated', pricingVersion: pricingData.version ?? null };
}

function repriceEvent(row, pricingData, recoverLegacyPiZero, fallbackProvider) {
  const recover = recoverLegacyPiZero && isLegacyPiZero(row);
  if (recoverLegacyPiZero && !(recover || row.source === 'Pi Agent' && row.costBasis === 'estimated'
    && Number(row.costUSD) === 0 && row.pricingVersion == null)) return null;
  if (row.billedCostUSD != null || !recover && row.costBasis !== 'estimated'
    && !(row.costBasis === 'unknown' && Number(row.costUSD) === 0)) return null;

  // 旧 OpenClaw 时间可能来自文件，会话起点也无法用于 Hermes 逐笔计价。
  // 旧 OpenCode 和 Claude Code 的估算标记无法排除工具原有费用。
  if (row.source === 'Hermes Agent') return null;
  const needsPricingTime = ['OpenClaw', 'OpenCode', 'Claude Code'].includes(row.source);
  const eventTime = row.pricingTime ?? (needsPricingTime ? null : row.eventTime);
  if (!eventTime || !Number.isFinite(Date.parse(eventTime))) return null;

  const provider = row.provider?.trim() || fallbackProvider;
  // 参考价只用于算金额，不能把选中的渠道写成调用的供应商。
  const price = priceUsageEvent(row, pricingData, eventTime, provider);
  if (!price || row.costBasis === 'estimated' && Number(row.costUSD) === price.costUSD
    && row.pricingVersion === price.pricingVersion) return null;
  return { ...row, ...price };
}

export function updateLegacySessions(sessions, projectModels, changedProjects, skipped) {
  const candidates = [];
  for (const row of sessions) {
    // 兼容表的 sessionId 实际按工作区和模型聚合，不能用调用的 sessionId 关联。
    if (!row.projectPath || !row.sessionId.startsWith('local:')) continue;
    const project = projectKey(row);
    const models = projectModels.get(project)?.filter(item => row.sessionId.endsWith(`:${item.model}`)) ?? [];
    if (models.length !== 1) continue;
    const [detail] = models;
    const delta = changedProjects.get(project)?.get(detail.model);
    if (delta !== undefined) candidates.push({ row, detail, delta });
  }

  const owners = new Map();
  for (const { detail } of candidates) owners.set(detail, (owners.get(detail) || 0) + 1);
  return candidates.flatMap(({ row, detail, delta }) => {
    if (owners.get(detail) > 1 || !fullTokens(row, [detail]) || !sameAmount(Number(row.costUSD), detail.costUSD)) {
      skipped.incompleteSession++;
      return [];
    }
    const costUSD = detail.costUSD + delta;
    return costUSD === Number(row.costUSD) ? [] : [{ ...row, costUSD }];
  });
}

export function addProjectCostChanges(projects, changes, original) {
  for (const row of changes) {
    if (!row.projectPath) continue;
    const key = projectKey(row);
    if (!projects.has(key)) projects.set(key, new Map());
    const models = projects.get(key);
    const delta = row.costUSD - original.get(rowKey('time', row)).costUSD;
    models.set(row.model, (models.get(row.model) ?? 0) + delta);
  }
}

function planLegacySessions(previous, changes, skipped) {
  if (!previous.sessions.length || !changes.length) return [];
  const byProject = group(previous.time, projectKey);
  const summaries = new Map([...byProject].map(([key, rows]) => [key, [...group(rows, row => row.model)]
    .map(([model, events]) => ({ model, costUSD: sum(events, 'costUSD'),
      ...Object.fromEntries(tokenFields.map(field => [field, sum(events, field)])) }))]));
  const projects = new Map();
  addProjectCostChanges(projects, changes, new Map(previous.time.map(row => [rowKey('time', row), row])));
  return updateLegacySessions(previous.sessions, summaries, projects, skipped);
}

/** 以完整日汇总为单位重算，让调用明细与看板总额一起提交。 */
export function planReprice(previous, pricingData, { start, end, model, recoverLegacyPiZero = false, fallbackProvider } = {}) {
  const buckets = group(previous.time, dayKey);
  const changed = new Map();
  const daily = [];
  const skipped = { incompleteDetail: 0, costMismatch: 0, recordedDay: 0, noEligibleEvents: 0, incompleteSession: 0 };
  let costBefore = 0;
  let costAfter = 0;

  for (const row of previous.daily) {
    if ((start && row.usageDate < start) || (end && row.usageDate > end) || (model && row.model !== model)) continue;
    if (recoverLegacyPiZero && row.source !== 'Pi Agent') continue;
    const detail = buckets.get(dayKey(row)) || [];
    if (!fullTokens(row, detail)) { skipped.incompleteDetail++; continue; }
    if (!sameAmount(Number(row.costUSD), sum(detail, 'costUSD'))) { skipped.costMismatch++; continue; }
    if (row.costBasis === 'recorded' && !(recoverLegacyPiZero && detail.some(isLegacyPiZero))) {
      skipped.recordedDay++; continue;
    }
    for (const event of detail) {
      const next = repriceEvent(event, pricingData, recoverLegacyPiZero, fallbackProvider);
      if (next) changed.set(event, next);
    }
    if (!detail.some(event => changed.has(event))) { skipped.noEligibleEvents++; continue; }

    const updated = detail.map(event => changed.get(event) || event);
    const costs = summarizeEventCosts(updated);
    daily.push({ ...row, ...costs });
    costBefore += Number(row.costUSD);
    costAfter += costs.costUSD;
  }

  const time = [...changed.values()];
  const sessions = planLegacySessions(previous, time, skipped);
  return { next: { daily, time, sessions }, skipped, costBefore, costAfter };
}
