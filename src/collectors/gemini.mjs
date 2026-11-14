/**
 * Gemini CLI data collector (pure JS).
 *
 * Scans ~/.gemini/tmp/ for session files in two layouts:
 *
 *   Legacy JSON    ~/.gemini/tmp/session-<id>.json
 *   Modern JSON    ~/.gemini/tmp/<project_hash>/chats/<file>.json
 *   Modern JSONL   ~/.gemini/tmp/<project_hash>/chats/<file>.jsonl
 *                  (also: root-level session-*.jsonl)
 *
 * Token-count normalisation:
 *   Gemini's "input" in session files is cache-inclusive, i.e. it already
 *   contains the cached portion. We separate them:
 *     net_input  = input − cached   (clamped to ≥ 0)
 *     cache_read = cached
 *
 * Cache normalization uses Gemini's own total fields where available,
 * including the "total" cross-check for session-format files.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, extname, basename, relative } from 'node:path';
import { calculateCost } from '../pricing.mjs';
import { configuredPath } from '../collector-config.mjs';
import { projectPath } from '../project-identity.mjs';
import { localDateFromTimestamp, normalizeModelForGrouping } from './utils.mjs';
import { cachedParse, flushCache } from './parse-cache.mjs';

export const CLIENT_KEY = 'gemini';
export const SOURCE_LABEL = 'Gemini CLI';
const CACHE_VERSION = 3;   // bump when parsed event shape changes

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function getTmpDir() {
  return configuredPath('gemini', 'tmpDir', join(homedir(), '.gemini', 'tmp'));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeReaddir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeReadFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function fileMtime(filePath) {
  try {
    const s = await stat(filePath);
    return s.mtimeMs;
  } catch {
    return Date.now();
  }
}

function pos(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function zero() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function addInto(agg, t) {
  agg.input     += t.input;
  agg.output    += t.output;
  agg.cacheRead  += t.cacheRead;
  agg.cacheWrite += t.cacheWrite;
  agg.reasoning  += t.reasoning;
}

// ---------------------------------------------------------------------------
// Cache normalisation
// ---------------------------------------------------------------------------

/**
 * "Headless" path (stats object): Gemini's promptTokenCount is cache-inclusive,
 * so subtract the cached portion from input.
 */
function normaliseHeadlessInputAndCache(input, cached) {
  const i = Math.max(0, input);
  const c = Math.max(0, cached);
  const cPortion = Math.min(c, i);
  return { netInput: i - cPortion, cacheRead: c };
}

/**
 * "Session" path (full session format):
 * Use the total field (when available) to determine whether input is already
 * net (exclusive) or still cache-inclusive.
 *
 * If total == input + output + reasoning + tool  (inclusive formula matches),
 * then input still contains cached, so subtract.
 *
 * If total == input + output + reasoning + tool + cached  (exclusive formula
 * matches), then input is already net — keep as-is.
 */
function normaliseSessionInputAndCache(input, cached, output, reasoning, tool, total) {
  const i  = Math.max(0, input);
  const c  = Math.max(0, cached);
  const o  = Math.max(0, output);
  const r  = Math.max(0, reasoning);
  const tk = Math.max(0, tool);

  if (total == null) {
    // No total hint — fall back to headless logic
    const cPortion = Math.min(c, i);
    return { netInput: i - cPortion, cacheRead: c };
  }

  const t = Math.max(0, total);
  const inclusiveTotal  = i + o + r + tk;          // cached still inside input
  const exclusiveTotal  = inclusiveTotal + c;       // cached separately added

  // If total matches the inclusive formula (and not exclusive), input is still
  // cache-inclusive → subtract.
  if (c > 0 && t === inclusiveTotal && t !== exclusiveTotal) {
    const cPortion = Math.min(c, i);
    return { netInput: i - cPortion, cacheRead: c };
  }

  // Otherwise treat input as already net
  return { netInput: i, cacheRead: c };
}

// ---------------------------------------------------------------------------
// Session-format JSON parser  (full GeminiSession structure)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Headless JSON parser  (stats object)
// ---------------------------------------------------------------------------

function parseHeadlessStats(stats, modelHint, date, sessionId) {
  const events = [];

  // Try per-model breakdown first
  const models = stats.models;
  if (models && typeof models === 'object') {
    for (const [modelName, data] of Object.entries(models)) {
      const t = data.tokens || {};
      const input     = pos(t.prompt   ?? t.input        ?? t.input_tokens);
      const output    = pos(t.candidates ?? t.output      ?? t.output_tokens);
      const cached    = pos(t.cached   ?? t.cached_tokens);
      const reasoning = pos(t.thoughts ?? t.reasoning);

      if (input === 0 && output === 0 && cached === 0 && reasoning === 0) continue;

      const { netInput, cacheRead } = normaliseHeadlessInputAndCache(input, cached);
      events.push({
        sessionId,
        date,
        model: normalizeModelForGrouping(modelName),
        tokens: { input: netInput, output, cacheRead, cacheWrite: 0, reasoning }
      });
    }
    if (events.length > 0) return events;
  }

  // Flat stats fallback
  const input     = pos(stats.input_tokens  ?? stats.prompt_tokens);
  const output    = pos(stats.output_tokens ?? stats.candidates_tokens);
  const cached    = pos(stats.cached_tokens);
  const reasoning = pos(stats.thoughts_tokens ?? stats.reasoning_tokens);

  if (input === 0 && output === 0 && cached === 0 && reasoning === 0) return [];

  const { netInput, cacheRead } = normaliseHeadlessInputAndCache(input, cached);
  events.push({
    sessionId,
    date,
    model: normalizeModelForGrouping(modelHint || 'unknown'),
    tokens: { input: netInput, output, cacheRead, cacheWrite: 0, reasoning }
  });

  return events;
}

// ---------------------------------------------------------------------------
// JSON file parser  (handles both full-session and headless formats)
// ---------------------------------------------------------------------------

async function parseJsonFile(filePath, fallbackDate, fileSessionId) {
  const text = await safeReadFile(filePath);
  if (!text) return [];

  let obj;
  try { obj = JSON.parse(text); } catch { return []; }
  if (!obj || typeof obj !== 'object') return [];
  const sessionId = obj.sessionId || obj.session_id || fileSessionId;

  // Full session format
  if (Array.isArray(obj.messages)) {
    return obj.messages.flatMap((message, index) => message?.type === 'gemini'
      ? parseSingleGeminiEvent(message, sessionId, fallbackDate, index) : []);
  }

  // Direct gemini event
  if (obj.type === 'gemini') {
    return parseSingleGeminiEvent(obj, sessionId, fallbackDate, 0);
  }

  // Headless: stats object
  const stats = obj.stats ?? obj.result?.stats;
  if (stats) {
    const date = extractDateFromValue(obj) ?? fallbackDate;
    const modelHint = typeof obj.model === 'string' ? obj.model : null;
    return parseHeadlessStats(stats, modelHint, date, sessionId);
  }

  return [];
}

function parseSingleGeminiEvent(obj, sessionId, fallbackDate, index) {
  const model = typeof obj.model === 'string' ? obj.model : null;
  const tokens = obj.tokens;
  if (!model || !tokens) return [];

  const eventTime = obj.timestamp ?? obj.created_at;
  const eventDate = localDateFromTimestamp(eventTime, null);

  const input     = pos(tokens.input);
  const output    = pos(tokens.output);
  const cached    = pos(tokens.cached);
  const reasoning = pos(tokens.thoughts);
  const tool      = pos(tokens.tool);
  const total     = tokens.total != null ? pos(tokens.total) : null;

  const { netInput, cacheRead } = normaliseSessionInputAndCache(
    input, cached, output, reasoning, tool, total
  );

  return [{
    sessionId,
    date: eventDate ?? fallbackDate,
    eventTime: eventDate ? eventTime : null,
    messageId: typeof obj.id === 'string' && obj.id ? obj.id : null,
    index,
    model: normalizeModelForGrouping(model),
    tokens: { input: netInput + tool, output, cacheRead, cacheWrite: 0, reasoning }
  }];
}

// ---------------------------------------------------------------------------
// JSONL file parser  (streaming format)
// ---------------------------------------------------------------------------

async function parseJsonlFile(filePath, fallbackDate) {
  const text = await safeReadFile(filePath);
  if (!text) return [];

  let sessionId = basename(filePath, extname(filePath));
  let currentModel = null;
  const events = [];
  const summaries = new Map();

  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;

    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    const type = obj.type;

    // ── init ──
    if (type === 'init') {
      if (typeof obj.model === 'string') currentModel = obj.model;
      const id = obj.session_id ?? obj.sessionId;
      if (typeof id === 'string') sessionId = id;
      continue;
    }

    // Update session ID from any line that carries it
    const lineSessionId = obj.session_id ?? obj.sessionId;
    if (typeof lineSessionId === 'string') sessionId = lineSessionId;

    // ── gemini turn (direct token object) ──
    if (type === 'gemini') {
      if (typeof obj.model === 'string') currentModel = obj.model;

      events.push(...parseSingleGeminiEvent(obj, sessionId, fallbackDate, index));
      continue;
    }

    // ── result / any line with stats ──
    const stats = obj.stats ?? obj.result?.stats;
    if (stats) {
      const date      = extractDateFromValue(obj) ?? fallbackDate;
      const modelHint = currentModel;
      for (const row of parseHeadlessStats(stats, modelHint, date, sessionId)) {
        summaries.set(JSON.stringify([row.sessionId, row.model]), row);
      }
    }
  }

  // JSONL 的结果统计是本次会话的汇总，同一模型有调用日志时以调用为准。
  for (const row of events) summaries.delete(JSON.stringify([row.sessionId, row.model]));
  return [...events, ...summaries.values()];
}

/**
 * Parse one Gemini session file (json or jsonl). The fallback date and session
 * id are derived from the path + mtime, so this is a pure function of the file
 * and safe to memoize by fingerprint.
 */
async function parseGeminiFile(filePath) {
  const fallbackDate = localDateFromTimestamp(await fileMtime(filePath));
  const sessionId = basename(filePath, extname(filePath));
  const ext = extname(filePath).toLowerCase();
  return ext === '.jsonl'
    ? parseJsonlFile(filePath, fallbackDate)
    : parseJsonFile(filePath, fallbackDate, sessionId);
}

// ---------------------------------------------------------------------------
// Date extractor
// ---------------------------------------------------------------------------

function extractDateFromValue(obj) {
  const raw = obj.timestamp ?? obj.created_at;
  if (!raw) return null;
  return localDateFromTimestamp(raw, null);
}

// ---------------------------------------------------------------------------
// Directory scanner
// ---------------------------------------------------------------------------

/**
 * Decide whether a given relative path under ~/.gemini/tmp/ is a valid
 * Gemini session file we should parse.
 *
 * Accepted patterns:
 *   session-<anything>.json[l]              (legacy, directly in tmp/)
 *   <hash>/chats/<filename>.json[l]         (modern layout)
 */
function isAcceptedFile(entry, parentName) {
  const name = entry.name;
  const ext  = extname(name).toLowerCase();
  if (ext !== '.json' && ext !== '.jsonl') return false;

  // Legacy: filename starts with "session-"
  if (name.startsWith('session-')) return true;

  // Modern: parent directory is "chats"
  if (parentName === 'chats') return true;

  return false;
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

export async function collect(pricingData = null) {
  const tmpDir = getTmpDir();
  const topEntries = await safeReaddir(tmpDir);

  const dailyMap = new Map();
  const wmMap    = new Map();
  const parsed = new Map();
  const timeEvents = [];
  const cutoff = Date.now() - Number(process.env.TIME_USAGE_HISTORY_DAYS || Infinity) * 86_400_000;

  async function readEvents(filePath, workspace = null) {
    const fileKey = relative(tmpDir, filePath).replaceAll('\\', '/');
    for (const row of await cachedParse(CLIENT_KEY, CACHE_VERSION, filePath, parseGeminiFile)) {
      const identity = row.messageId ? [row.sessionId, 'message', row.messageId]
        : [fileKey, row.index ?? 'summary', row.index == null ? row.model : null];
      const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      const previous = parsed.get(key);
      const event = previous?.eventTime && !row.eventTime ? previous : row;
      parsed.set(key, { ...event, workspace: workspace ?? previous?.workspace ?? null });
    }
  }

  for (const entry of topEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = join(tmpDir, entry.name);

    if (entry.isFile() && isAcceptedFile(entry, /* parentName */ '')) {
      // Legacy root-level session file
      await readEvents(entryPath);
      continue;
    }

    if (entry.isDirectory()) {
      // Modern layout: <hash>/chats/
      const chatsDir     = join(entryPath, 'chats');
      const chatsEntries = await safeReaddir(chatsDir);
      if (!chatsEntries.length) continue;
      const marker = await safeReadFile(join(entryPath, '.project_root'));
      const workspace = projectPath(marker?.trim());

      for (const chatEntry of chatsEntries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!chatEntry.isFile() || !isAcceptedFile(chatEntry, 'chats')) continue;

        const filePath = join(chatsDir, chatEntry.name);
        await readEvents(filePath, workspace);
      }
    }
  }

  for (const [eventKey, { sessionId, date, model, tokens, eventTime, workspace }] of parsed) {
    const cost = calculateCost(model, tokens, pricingData, null, { eventTime, tiered: Boolean(eventTime) });
    const ms = typeof eventTime === 'number' ? eventTime < 10_000_000_000 ? eventTime * 1000 : eventTime : Date.parse(eventTime);
    if (ms >= cutoff) timeEvents.push({ client: CLIENT_KEY, eventKey, eventTime: new Date(ms).toISOString(),
      sessionId, model, projectPath: workspace, tokens, cost });
    const dk = `${date}::${model}`;
    if (!dailyMap.has(dk)) dailyMap.set(dk, { date, model, ...zero(), cost: 0 });
    addInto(dailyMap.get(dk), tokens);
    dailyMap.get(dk).cost += cost;

    const project = workspace ?? sessionId;
    const wmk = `${project}::${model}`;
    if (!wmMap.has(wmk)) wmMap.set(wmk, { workspace: project, model, ...zero(), cost: 0 });
    addInto(wmMap.get(wmk), tokens);
    wmMap.get(wmk).cost += cost;
  }

  await flushCache(CLIENT_KEY);
  return { ...buildOutput(dailyMap, wmMap), eventsJson: { events: timeEvents } };
}

// ---------------------------------------------------------------------------
// Convert to common collector JSON
// ---------------------------------------------------------------------------

function buildOutput(dailyMap, wmMap) {
  const byDate = new Map();
  for (const row of dailyMap.values()) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const contributions = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => ({
      date,
      clients: rows.map(row => {
        const tokens = {
          input:     row.input,
          output:    row.output,
          cacheRead:  row.cacheRead,
          cacheWrite: row.cacheWrite,
          reasoning:  row.reasoning,
        };
        return {
          client:  CLIENT_KEY,
          modelId: row.model,
          tokens,
          cost: row.cost,
        };
      })
    }));

  const entries = [...wmMap.values()].map(wm => {
    const tokens = {
      input:     wm.input,
      output:    wm.output,
      cacheRead:  wm.cacheRead,
      cacheWrite: wm.cacheWrite,
      reasoning:  wm.reasoning,
    };
    return {
      client:         CLIENT_KEY,
      workspaceKey:   wm.workspace,
      workspaceLabel: wm.workspace,
      model:          wm.model,
      ...tokens,
      cost: wm.cost,
    };
  });

  return { graphJson: { contributions }, modelsJson: { entries } };
}
