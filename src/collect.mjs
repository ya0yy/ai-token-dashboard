import './load-env.mjs';
import { hostname } from 'node:os';
import { backupSnapshot } from './usage-backup.mjs';
import { openDb, recordRun } from './db.mjs';
import { readSnapshot, reconcileSnapshot, snapshotDiff, writeSnapshot } from './usage-store.mjs';
import { syncDatabase } from './sync.mjs';
import { applyCollectionDelta, collectionSignature } from './collection-delta.mjs';
import { zonedParts } from './timezone.mjs';
import { projectPath } from './project-identity.mjs';
import { dedupeEventKeys } from './incremental.mjs';
import { hasModelPricing } from './pricing.mjs';
import { loadCollectionPricing } from './pricing-config.mjs';
import { tokenTotal } from './collectors/utils.mjs';

const COLLECTORS = [
  { module: './collectors/claude-code.mjs', label: 'Claude Code' },
  { module: './collectors/hermes.mjs', label: 'Hermes Agent' },
  { module: './collectors/codex.mjs', label: 'Codex CLI' },
  { module: './collectors/opencode.mjs', label: 'OpenCode' },
  { module: './collectors/gemini.mjs', label: 'Gemini CLI' },
  { module: './collectors/openclaw.mjs', label: 'OpenClaw' },
  { module: './collectors/grok.mjs', label: 'Grok CLI' },
  { module: './collectors/dsh.mjs', label: 'DeepSeek Harness' },
  { module: './collectors/pi.mjs', label: 'Pi Agent' },
  { module: './collectors/omp.mjs', label: 'Oh My Pi' }
];

const args = parseArgs(process.argv.slice(2));
const device = args.device || hostname();
const preview = args.full && !args.apply || args.dryRun;
const pricingData = args.push ? null : await loadCollectionPricing(args);
const db = await openDb(args.db, { readOnly: Boolean(preview) });
// 上传和全量替换都保留可读取的全部调用明细。
if (args.full || args.push) process.env.TIME_USAGE_HISTORY_DAYS = 'Infinity';
const collection = { collectedAt: new Date().toISOString(), scopes: [] };

try {
  await collectLocal();
  if (args.push && !preview) {
    const result = await syncDatabase({ db, url: args.push, token: args.token, device, source: args.source,
      full: Boolean(args.full), resync: Boolean(args.resync), scopes: collection.scopes, hubPricing: true });
    console.log(`[用量上报] 由 Hub 入库计价，请求数: ${result.requests}，日汇总数: ${result.rows.daily}，调用数: ${result.rows.time}`);
  }
} finally { await db.close(); }

async function collectLocal() {
  let anyError = false;

  if (args.source && !COLLECTORS.some(c => c.label === args.source)) throw new Error('Unknown --source; use the exact source label from the dashboard');
  for (const { module, label } of COLLECTORS) {
    if (args.source && args.source !== label) continue;
    let graphJson;
    let modelsJson;
    let eventsJson;

    try {
      const { collect } = await import(module);
      ({ graphJson, modelsJson, eventsJson } = await collect(pricingData));
    } catch (error) {
      const run = {
        device,
        source: label,
        status: 'error',
        message: error.message,
        collectedAt: collection.collectedAt,
        command: `js-collector:${module}`
      };
      if (!preview) await recordRun(db, run);
      console.warn(`[${label}] ${error.message}`);
      anyError = true;
      continue;
    }

    const dailyRows = normalizeDailyRows(graphJson, device);
    const sessionRows = normalizeSessionRows(modelsJson, device);
    // 在完整批次上生成稳定 key，避免重复键编号随增量范围变化
    const timeRows = dedupeEventKeys(normalizeTimeRows(eventsJson, device));

    const scope = { device, source: label };
    const incoming = { daily: dailyRows, time: timeRows, sessions: sessionRows };
    const delta = !args.full && !preview ? await applyCollectionDelta(db, scope, incoming, { pricingData }) : null;
    if (delta?.unchanged) {
      const message = `daily=${dailyRows.length}, time=${timeRows.length}, workspace_model=${sessionRows.length}, unchanged`;
      collection.scopes.push(scope);
      await recordRun(db, { ...scope, status: dailyRows.length || sessionRows.length ? 'ok' : 'empty',
        message, collectedAt: collection.collectedAt, command: `js-collector:${module}` });
      console.log(`[${label}] ${message}`);
      continue;
    }
    const previous = delta?.previous || await readSnapshot(db, device, label);
    if (args.full && previous.daily.length && !dailyRows.length && !args.allowEmpty) {
      throw new Error(`${label}: no source records found; refusing to erase history. Verify the log paths, or explicitly use --source and --allow-empty.`);
    }
    const next = delta?.next || reconcileSnapshot(previous, incoming, { pricingData, full: Boolean(args.full) });
    if (preview) {
      console.log(`[preview] ${label} ${JSON.stringify(snapshotDiff(previous, next))}`);
      continue;
    }
    if (args.full) {
      console.log(`[backup] ${backupSnapshot(previous, [scope])}`);
    }
    if (!delta) await writeSnapshot(db, next, { previous, full: Boolean(args.full), scopes: [scope],
      checkpoint: { scope, signature: collectionSignature(incoming) } });
    collection.scopes.push(scope);
    const message = `daily=${dailyRows.length}, time=${timeRows.length}, workspace_model=${sessionRows.length}${args.full ? ', full' : delta?.dates ? `, reconciled_dates=${delta.dates.length}` : ''}`;
    const run = {
      device,
      source: label,
      status: dailyRows.length || sessionRows.length ? 'ok' : 'empty',
      message,
      collectedAt: collection.collectedAt,
      command: `js-collector:${module}`
    };
    await recordRun(db, run);
    console.log(`[${label}] ${message}`);
  }

  if (anyError) process.exitCode = 1;
}

function normalizeTimeRows(json, deviceName) {
  const events = Array.isArray(json?.events) ? json.events : [];
  return events.map((entry) => {
    const tokens = normalizeTokens(entry.tokens);
    const totalTokens = tokenTotal(tokens, entry.client);
    const eventTime = normalizeEventTime(entry.eventTime || entry.timestamp);
    const usageDate = eventTime ? zonedParts(eventTime)?.date : '';
    const source = sourceLabel(entry.client);
    const model = entry.modelId || entry.model || entry.model_id || 'unknown';
    const provider = typeof entry.provider === 'string' ? entry.provider.trim().slice(0, 255) || null : null;
    // 没有实际调用时间的汇总记录可保留展示时间，计价时间显式留空。
    const pricingTime = entry.pricingTime === undefined ? eventTime : normalizeEventTime(entry.pricingTime);
    return {
      device: deviceName,
      source,
      eventKey: entry.eventKey || [
        entry.client || 'unknown',
        eventTime,
        entry.sessionId || entry.workspaceKey || '',
        model,
        totalTokens
      ].join(':'),
      eventTime,
      usageDate,
      model,
      provider,
      pricingTime: pricingTime || null,
      projectPath: projectPath(entry.projectPath || entry.workspaceLabel || entry.workspaceKey),
      sessionId: entry.sessionId || null,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheCreationTokens: tokens.cacheWrite,
      cacheReadTokens: tokens.cacheRead,
      reasoningOutputTokens: tokens.reasoning,
      totalTokens,
      costUSD: entry.cost || 0,
      billedCostUSD: entry.billedCostUSD ?? null,
      costBasis: entry.costBasis || (hasModelPricing(model, pricingData, provider, { eventTime: pricingTime || null }) ? 'estimated' : 'unknown'),
      pricingVersion: entry.costBasis === 'recorded' || entry.pricingVersion === null ? null : pricingData?.version ?? null,
      ...(entry.logEstimateUSD != null ? { logEstimateUSD: entry.logEstimateUSD } : {})
    };
  }).filter(row => row.eventTime && row.usageDate && (row.totalTokens > 0 || row.billedCostUSD > 0));
}

function normalizeEventTime(value) {
  if (!value) return '';
  if (typeof value === 'number') {
    const ms = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  const text = String(value).trim();
  if (!text) return '';
  const normalized = text.includes('T') ? text : text.replace(' ', 'T');
  const date = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function normalizeDailyRows(json, deviceName) {
  const days = Array.isArray(json.contributions) ? json.contributions : [];
  return days.flatMap((day) => {
    const clients = Array.isArray(day.clients) ? day.clients : [];
    return clients.map((entry) => {
      const tokens = normalizeTokens(entry.tokens);
      return {
        device: deviceName,
        source: sourceLabel(entry.client),
        usageDate: day.date,
        model: entry.modelId || entry.model_id || 'unknown',
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cacheCreationTokens: tokens.cacheWrite,
        cacheReadTokens: tokens.cacheRead,
        reasoningOutputTokens: tokens.reasoning,
        totalTokens: tokenTotal(tokens, entry.client),
        costUSD: entry.cost || 0,
        costBasis: 'unknown',
        pricingVersion: pricingData?.version ?? null
      };
    });
  });
}

function normalizeSessionRows(json, deviceName) {
  const entries = Array.isArray(json.entries) ? json.entries : [];
  return entries.map((entry) => {
    const tokens = {
      input: positiveNumber(entry.input),
      output: positiveNumber(entry.output),
      cacheRead: positiveNumber(entry.cacheRead),
      cacheWrite: positiveNumber(entry.cacheWrite),
      reasoning: positiveNumber(entry.reasoning),
      unclassified: positiveNumber(entry.unclassified)
    };
    const source = sourceLabel(entry.client);
    const workspace = entry.workspaceLabel || entry.workspaceKey || '';
    const model = entry.model || 'unknown';
    return {
      device: deviceName,
      source,
      sessionId: ['local', entry.client || 'unknown', workspace || 'no-workspace', model].join(':'),
      lastActivity: null,
      projectPath: projectPath(workspace),
      model,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheCreationTokens: tokens.cacheWrite,
      cacheReadTokens: tokens.cacheRead,
      reasoningOutputTokens: tokens.reasoning,
      totalTokens: tokenTotal(tokens, entry.client),
      costUSD: entry.cost || 0
    };
  });
}

function normalizeTokens(tokens = {}) {
  return {
    input: positiveNumber(tokens.input),
    output: positiveNumber(tokens.output),
    cacheRead: positiveNumber(tokens.cacheRead ?? tokens.cache_read),
    cacheWrite: positiveNumber(tokens.cacheWrite ?? tokens.cache_write),
    reasoning: positiveNumber(tokens.reasoning),
    unclassified: positiveNumber(tokens.unclassified)
  };
}

function positiveNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function sourceLabel(client) {
  const labels = {
    claude: 'Claude Code',
    codex: 'Codex CLI',
    opencode: 'OpenCode',
    gemini: 'Gemini CLI',
    openclaw: 'OpenClaw',
    hermes: 'Hermes Agent',
    grok: 'Grok CLI',
    dsh: 'DeepSeek Harness',
    pi: 'Pi Agent',
    omp: 'Oh My Pi'
  };
  return labels[client] || client || 'unknown';
}

// ---------------------------------------------------------------------------
// CLI argument parser
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--device') {
      parsed.device = argv[++i];
    } else if (arg === '--db') {
      parsed.db = argv[++i];
    } else if (arg === '--push') {
      parsed.push = argv[++i];
    } else if (arg === '--token') {
      parsed.token = argv[++i];
    } else if (arg === '--full') {
      parsed.full = true;
    } else if (arg === '--resync') { parsed.resync = true;
    } else if (arg === '--apply') { parsed.apply = true;
    } else if (arg === '--dry-run') { parsed.dryRun = true;
    } else if (arg === '--source') { parsed.source = argv[++i];
    } else if (arg === '--allow-empty') { parsed.allowEmpty = true;
    } else { throw new Error(`Unknown argument: ${arg}`); }
  }
  if (parsed.apply && !parsed.full) throw new Error('--apply requires --full');
  if (parsed.resync && !parsed.push) throw new Error('--resync requires --push');
  for (const key of ['device', 'db', 'push', 'token', 'source']) {
    if (Object.hasOwn(parsed, key) && (!parsed[key] || parsed[key].startsWith('--'))) throw new Error(`Missing value for --${key}`);
  }
  if (parsed.allowEmpty && (!parsed.full || !parsed.source)) throw new Error('--allow-empty requires --full and --source');
  return parsed;
}
