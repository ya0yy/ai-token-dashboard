import './load-env.mjs';
import { createReadStream, existsSync, statSync, realpathSync } from 'node:fs';
import { pipeline } from 'node:stream';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createGzip } from 'node:zlib';
import { basename, extname, join, resolve, sep } from 'node:path';
import { URL } from 'node:url';
import {
  openDb,
  pruneCollectionRuns, recordRun, resolveDisplayTz
} from './db.mjs';
import { batchUpsertDaily, batchUpsertSession, batchUpsertTimeUsage } from './db-batch.mjs';
import { loadCollectorConfig } from './collector-config.mjs';
import { loadPricing, hasModelPricing, pricingSnapshotTime, defaultPriceTable, pricingRuleModel } from './pricing.mjs';
import { currentPricingSnapshot, readPricingPolicy, savePricingPolicy, validatePricingPolicy } from './pricing-config.mjs';
import { queryQuota } from './quota.mjs';
import { authorize, isLoopback, serverAccess, trustedRequest } from './http-security.mjs';
import { validDate, validateIngest } from './ingest-validation.mjs';
import { queryDaily, queryTime, queryTimeSummary, queryUsageMetadata, queryHourly, dateWhere } from './usage-query.mjs';
import { invalidateCollectionState } from './collection-state.mjs';
import { collectionNotifications } from './collection-notifications.mjs';
import { streamUsageCsv } from './usage-export.mjs';
import { listenError } from './listen-error.mjs';
import { resetUsageChanges, exactColumn } from './sync-journal.mjs';
import { requestCache } from './request-cache.mjs';
import { normalizeModelForGrouping } from './collectors/utils.mjs';
import { repriceUsage } from './reprice-store.mjs';
import { preserveHubRepricing, reconcileHubRepricing } from './hub-repriced-ingest.mjs';
import { prepareHubPricing, writeHubPricedDays } from './hub-ingest-pricing.mjs';

// Live subscription-window quota is the one feature that makes outbound calls
// (to the vendors' usage endpoints, using the OAuth token the CLIs stored
// locally). Opt-out with SUBSCRIPTION_QUOTA_ENABLED=false; cached briefly so a
// dashboard refresh doesn't hammer the upstream.
const quotaEnabled = String(process.env.SUBSCRIPTION_QUOTA_ENABLED ?? 'true').toLowerCase() !== 'false';
const QUOTA_TTL_MS = 60_000;       // cache a good result this long
const QUOTA_ERROR_TTL_MS = 10_000; // but recover quickly after a transient error
const quotaCache = requestCache({ maxEntries: 1, ttl: data => ['claude', 'codex'].some(k => {
  const quota = data[k];
  return quota && !quota.ok && quota.status !== 'no_credentials';
}) ? QUOTA_ERROR_TTL_MS : QUOTA_TTL_MS });
const hourlyCache = requestCache({ ttl: 10_000, cacheable: data => data.hourly.length <= 5000 });

const port = Number(process.env.PORT || 4173);
const access = serverAccess();
const staticDir = existsSync(resolve(process.cwd(), 'dist'))
  ? resolve(process.cwd(), 'dist')
  : resolve(process.cwd(), 'public');
const db = await openDb();
const as = (name) => db.driver === 'mysql' ? `\`${name}\`` : `"${name}"`;
// Pricing data for serve-time cache-savings estimation. Same bundled cache
// file the collector uses; savings silently degrade to 0 if it is missing.
const pricingData = await loadPricing(resolve(process.cwd(), 'data', 'pricing-litellm.json'));
let activeCollection = null;
let collectionState = {
  status: 'idle',
  message: '尚未启动采集',
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  stdout: '',
  stderr: ''
};
const collectionUpdates = collectionNotifications(() => collectionState, sendJson);

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) sendJson(res, { error: 'Internal server error' }, 500);
    else res.end();
  });
});

async function handleRequest(req, res) {
  if (!trustedRequest(req, access)) { sendJson(res, { error: 'Untrusted request origin' }, 403); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!authorize(req, res, access, ['/api/ingest', '/api/pricing/snapshot'].includes(url.pathname))) return;
  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, url, res);
    return;
  }
  serveStatic(req, url.pathname, res);
}

server.on('error', async error => {
  console.error(listenError(error, access.host, port));
  await db.close();
  process.exitCode = 1;
});
server.listen(port, access.host, () => {
  console.log(`AI Token Dashboard: http://localhost:${port}`);
  startScheduledCollect();
});

async function handleApi(req, url, res) {
  if (url.pathname === '/api/pricing/snapshot' && req.method === 'GET') {
    const snapshot = await currentPricingSnapshot({ legacySchedulesOnly: url.searchParams.get('schedules') !== 'extended' });
    const etag = `"${snapshot.version}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'private, no-cache' });
      res.end();
      return;
    }
    res.setHeader('etag', etag);
    sendJson(res, snapshot);
    return;
  }
  if (url.pathname === '/api/pricing') {
    await handlePricing(req, res);
    return;
  }
  if (url.pathname === '/api/pricing/reprice') {
    await handleReprice(req, res);
    return;
  }
  if (url.pathname === '/api/config') {
    sendJson(res, { displayTimeZone: resolveDisplayTz() });
    return;
  }
  if (url.pathname === '/api/export.csv') {
    if (req.method !== 'GET') { sendJson(res, { error: 'Method not allowed' }, 405); return; }
    try { await streamUsageCsv(db, url.searchParams, res, pricingData); }
    catch (error) {
      if (res.headersSent) res.destroy(error);
      else sendJson(res, { error: error.message }, error.status || 500);
    }
    return;
  }
  if (url.pathname === '/api/data') {
    const rawRuns = await all(`
      SELECT id, device, source, status, message,
        collected_at AS ${as('collectedAt')}
      FROM collection_runs
      ORDER BY id DESC
      LIMIT 500
    `);
    let usage;
    try { usage = await queryDaily(db, url.searchParams, pricingData); }
    catch (error) { sendJson(res, { error: error.message }, 400); return; }
    const rawDaily = usage.daily;
    const policy = await readPricingPolicy();
    const configuredModels = new Set([...policy.defaults, ...policy.rules.filter(rule => rule.enabled)]
      .map(rule => normalizeModelForGrouping(rule.model)));

    sendJson(res, {
      ...await queryUsageMetadata(db),
      pricing: {
        primarySnapshotAt: pricingSnapshotTime(),
        models: Object.fromEntries([...new Set(rawDaily.map(d => d.model))]
          .map(model => [model, configuredModels.has(normalizeModelForGrouping(model)) || hasModelPricing(model, pricingData)]))
      },
      ...usage,
      sessions: [], // Legacy lifetime workspace totals are not dated sessions.
      // Normalize runs: strip newlines from messages, shorten device names
      runs: rawRuns.map(r => ({
        ...r,
        message: r.message ? r.message.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() : '',
        device: r.device
      }))
    });
    return;
  }
  if (url.pathname === '/api/time/summary') {
    try { sendJson(res, await queryTimeSummary(db, url.searchParams, pricingData)); }
    catch (error) { sendJson(res, { error: error.message }, 400); }
    return;
  }
  if (url.pathname === '/api/time') {
    try { sendJson(res, await queryTime(db, url.searchParams, pricingData)); }
    catch (error) { sendJson(res, { error: error.message }, 400); }
    return;
  }
  if (url.pathname === '/api/hourly') {
    try {
      dateWhere(url.searchParams);
      const versions = await db.all('SELECT scope_key, revision FROM sync_scopes ORDER BY scope_key');
      const key = JSON.stringify([resolveDisplayTz(), url.searchParams.get('startDate'), url.searchParams.get('endDate'), versions]);
      sendJson(res, await hourlyCache.get(key, () => queryHourly(db, url.searchParams)));
    }
    catch (error) { sendJson(res, { error: error.message }, 400); }
    return;
  }
  if (url.pathname === '/api/quota') {
    await handleQuota(res);
    return;
  }
  if (url.pathname === '/api/ingest' && ['POST', 'PUT'].includes(req.method)) {
    await handleIngest(req, res);
    return;
  }
  if (url.pathname === '/api/collect' && req.method === 'POST') {
    handleCollect(req, res);
    return;
  }
  if (url.pathname === '/api/collect/status') {
    if (url.searchParams.get('wait') === '1') collectionUpdates.wait(res);
    else sendJson(res, collectionState);
    return;
  }
  sendJson(res, { error: 'Not found' }, 404);
}

function handleCollect(req, res) {
  // The socket must be loopback AND the request must not have transited a proxy.
  // Behind a reverse proxy every request's socket is loopback, so the proxy
  // headers are what actually reveal a remote origin — reject if any are present.
  const proxied = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded']
    .some(header => req.headers[header]);
  if (!isLoopback(req.socket.remoteAddress) || proxied) {
    sendJson(res, { error: '采集接口仅允许本机访问' }, 403);
    return;
  }

  startCollection({ reason: 'manual' });
  sendJson(res, collectionState, 202);
}

function startCollection({ reason = 'manual' } = {}) {
  if (activeCollection) {
    return false;
  }

  const args = ['src/collect.mjs'];
  const device = collectionDevice();
  if (device) args.push('--device', device);
  if (process.env.DB_PATH && !process.env.DATABASE_URL) args.push('--db', process.env.DB_PATH);

  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true
  });

  activeCollection = child;
  let stdout = '';
  let stderr = '';
  const startedAt = new Date().toISOString();
  collectionState = {
    status: 'running',
    message: reason === 'scheduled' ? '正在定时采集本机用量' : '正在采集本机用量',
    startedAt,
    finishedAt: null,
    exitCode: null,
    stdout: '',
    stderr: ''
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  child.on('error', error => {
    activeCollection = null;
    collectionState = {
      ...collectionState,
      status: 'error',
      message: error.message,
      finishedAt: new Date().toISOString(),
      stderr: error.message
    };
    collectionUpdates.publish();
  });

  child.on('close', code => {
    activeCollection = null;
    collectionState = {
      status: code === 0 ? 'ok' : 'error',
      message: code === 0 ? '采集完成' : '采集失败',
      exitCode: code,
      startedAt,
      finishedAt: new Date().toISOString(),
      stdout: trimOutput(stdout),
      stderr: trimOutput(stderr)
    };
    collectionUpdates.publish();
  });

  return true;
}

function startScheduledCollect() {
  const schedule = scheduledCollectConfig();
  if (!schedule.enabled) return;

  console.log(`[collect:schedule] enabled interval=${schedule.intervalSeconds}s runOnStart=${schedule.runOnStart}`);

  const run = () => {
    const started = startCollection({ reason: 'scheduled' });
    if (!started) console.log('[collect:schedule] skipped because a collection is already running');
  };

  if (schedule.runOnStart) {
    setTimeout(run, 1000);
  }

  setInterval(run, schedule.intervalSeconds * 1000);
}

function scheduledCollectConfig() {
  const config = loadCollectorConfig().scheduledCollect || {};
  const enabled = envBool('SCHEDULED_COLLECT_ENABLED', config.enabled ?? false);
  const intervalSeconds = Math.max(
    10,
    envNumber('SCHEDULED_COLLECT_INTERVAL_SECONDS',
      envNumber('COLLECT_INTERVAL_SECONDS', config.intervalSeconds ?? 300))
  );
  const runOnStart = envBool('SCHEDULED_COLLECT_RUN_ON_START', config.runOnStart ?? false);
  return { enabled, intervalSeconds, runOnStart };
}

function collectionDevice() {
  const config = loadCollectorConfig().scheduledCollect || {};
  return process.env.COLLECT_DEVICE || process.env.SCHEDULED_COLLECT_DEVICE || config.device || null;
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return Boolean(fallback);
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : Number(fallback);
}

async function handleQuota(res) {
  if (!quotaEnabled) {
    sendJson(res, { disabled: true });
    return;
  }
  try {
    sendJson(res, await quotaCache.get('quota', queryQuota));
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
}

async function handleIngest(req, res) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    sendJson(res, { error: 'Content-Type must be application/json' }, 415); return;
  }

  try {
    const payload = validateIngest(await readJson(req));
    if (req.method === 'PUT' && payload.pricing !== 'hub') throw new Error('新版用量上报缺少 Hub 计价标记');
    const dailyRows = Array.isArray(payload.daily) ? payload.daily : [];
    const timeRows = Array.isArray(payload.time) ? payload.time : [];
    const sessionRows = Array.isArray(payload.sessions) ? payload.sessions : [];
    const runRows = Array.isArray(payload.runs) ? payload.runs : [];

    const fullRebuild = payload.mode === 'full';
    const pricing = payload.pricing === 'hub' ? await currentPricingSnapshot() : null;

    // 全量 push 携带设备完整时间窗,按 (device, source) 整体替换;
    // 增量 push 只含新事件,只做 upsert,绝不删表。
    const timePairs = new Map();
    if (fullRebuild) {
      for (const row of payload.scopes) {
        if (row.device && row.source) timePairs.set(JSON.stringify([row.device, row.source]), row);
      }
    }

    const writtenDaily = await db.transaction(async (tx) => {
      const scopes = [...new Map([...payload.scopes, ...dailyRows, ...timeRows, ...sessionRows]
        .map(({ device, source }) => [JSON.stringify([device, source]), { device, source }])).values()];
      await invalidateCollectionState(tx, scopes);
      const priced = pricing ? await prepareHubPricing(tx, timeRows, pricing) : null;
      const reconciled = priced ? null : await preserveHubRepricing(tx, scopes, dailyRows, timeRows);
      for (const row of timePairs.values()) {
        for (const table of ['daily_usage', 'time_usage', 'session_usage']) {
          await tx.run(`DELETE FROM ${table} WHERE ${exactColumn(tx, 'device')} = ? AND ${exactColumn(tx, 'source')} = ?`, [row.device, row.source]);
        }
      }
      if (fullRebuild) await resetUsageChanges(tx, payload.scopes);
      let dayCount = dailyRows.length;
      if (priced) {
        await batchUpsertTimeUsage(tx, priced.time);
        dayCount = await writeHubPricedDays(tx, priced, fullRebuild);
      } else {
        await batchUpsertDaily(tx, reconciled.daily);
        await batchUpsertTimeUsage(tx, reconciled.time);
        await reconcileHubRepricing(tx, reconciled.affected);
      }
      await batchUpsertSession(tx, sessionRows);
      for (const row of runRows) await recordRun(tx, row);
      return dayCount;
    });

    // The hub stays up across many ingests; keep collection_runs bounded.
    if (runRows.length) await pruneCollectionRuns(db);

    if (pricing) {
      console.log(`[用量入库] Hub 已计价，调用数: ${timeRows.length}，日汇总数: ${writtenDaily}，价格版本: ${pricing.version}`);
    }
    sendJson(res, { ok: true, mode: fullRebuild ? 'full' : 'incremental', daily: writtenDaily, time: timeRows.length, sessions: sessionRows.length, runs: runRows.length });
  } catch (error) {
    console.warn('[用量入库] 上报失败，请检查上报数据、价格规则和数据库。', error);
    sendJson(res, { error: error.message }, 400);
  }
}

function serveStatic(req, pathname, res) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  const filePath = ['/', '/review', '/pricing'].includes(decoded)
    ? join(staticDir, 'index.html')
    : join(staticDir, decoded);
  // Require the resolved path to live under staticDir. The trailing separator
  // stops sibling dirs like `dist-foo` from matching the `dist` prefix.
  const inRoot = filePath === staticDir || filePath.startsWith(staticDir + sep);
  if (decoded.includes('\0') || !inRoot || !existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  let realPath, info;
  try {
    realPath = realpathSync(filePath);
    info = statSync(realPath);
    if (!info.isFile() || !realPath.startsWith(realpathSync(staticDir) + sep)) {
      res.writeHead(404); res.end('Not found'); return;
    }
  } catch { res.writeHead(404); res.end('Not found'); return; }
  const type = contentType(filePath);
  const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
  const encodings = new Map(String(req.headers['accept-encoding'] || '').split(',').map(entry => {
    const [name, ...params] = entry.trim().split(';');
    const quality = params.find(value => /^\s*q=/i.test(value));
    return [name.trim().toLowerCase(), quality ? Number(quality.split('=')[1]) : 1];
  }));
  const gzip = info.size >= 1024 && /^(text\/|application\/(javascript|json)|image\/svg)/.test(type)
    && (encodings.get('gzip') ?? encodings.get('*') ?? 0) > 0;
  const headers = { 'content-type': type, 'x-content-type-options': 'nosniff', etag,
    'cache-control': /^\/assets\/.+-[\w-]{8,}\.[\w]+$/.test(decoded) ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    vary: 'Accept-Encoding', ...(gzip ? { 'content-encoding': 'gzip' } : {}) };
  if (String(req.headers['if-none-match'] || '').split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag.slice(2))) {
    res.writeHead(304, headers); res.end(); return;
  }
  res.writeHead(200, { ...headers, ...(!gzip ? { 'content-length': info.size } : {}) });
  if (req.method === 'HEAD') { res.end(); return; }
  pipeline(createReadStream(realPath), ...(gzip ? [createGzip()] : []), res, () => { /* handles disconnects and read errors */ });
}

function all(sql, params) {
  return db.all(sql, params);
}

async function handlePricing(req, res) {
  if (req.method === 'PUT') {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
      sendJson(res, { error: '请使用 application/json 提交价格规则' }, 415);
      return;
    }
    let policy;
    try { policy = validatePricingPolicy(await readJson(req)); }
    catch (error) {
      sendJson(res, { error: error.message }, 400);
      return;
    }
    await savePricingPolicy(policy);
    console.log(`[模型定价] 已保存，默认价: ${policy.defaults.length}，峰谷规则: ${policy.rules.length}，时区: ${policy.timeZone}`);
  } else if (req.method !== 'GET') {
    sendJson(res, { error: '请求方法不受支持' }, 405);
    return;
  }
  const { version, policy, ...catalog } = await currentPricingSnapshot();
  sendJson(res, { version, policy, models: defaultPriceTable(catalog) });
}

async function handleReprice(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, { error: '请求方法不受支持' }, 405);
    return;
  }
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    sendJson(res, { error: '请使用 application/json 提交重算范围' }, 415);
    return;
  }
  let options;
  try {
    const { start, end, previewId, model, recoverLegacyPiZero = false, fallbackProvider } = await readJson(req);
    if (!validDate(start) || !validDate(end) || start > end) throw new Error('请选择有效的开始和结束日期');
    if (model != null && (typeof model !== 'string' || !model.trim() || model.length > 255 || model.includes('\0'))) {
      throw new Error('请输入有效的完整模型 ID');
    }
    if (typeof recoverLegacyPiZero !== 'boolean' || recoverLegacyPiZero && !model?.trim()) {
      throw new Error('补算旧版 Pi Agent 零金额时，请填写完整模型 ID');
    }
    if (fallbackProvider !== undefined && (!recoverLegacyPiZero || typeof fallbackProvider !== 'string'
      || !fallbackProvider.trim() || fallbackProvider.length > 255 || fallbackProvider.includes('\0'))) {
      throw new Error('仅补算旧版 Pi Agent 零金额时可为缺少供应商的调用选择参考规则');
    }
    if (previewId !== undefined && (typeof previewId !== 'string' || !/^[a-f0-9]{64}$/.test(previewId))) {
      throw new Error('请先预览这段日期的费用差额');
    }
    options = { start, end, model: model?.trim(), recoverLegacyPiZero, fallbackProvider: fallbackProvider?.trim(),
      source: recoverLegacyPiZero ? 'Pi Agent' : undefined,
      previewId, apply: previewId !== undefined, protect: true };
  } catch (error) {
    sendJson(res, { error: error.message }, 400);
    return;
  }
  try {
    const pricing = await currentPricingSnapshot();
    if (options.fallbackProvider && !pricing.policy.rules.some(rule => rule.enabled && rule.provider === options.fallbackProvider
      && pricingRuleModel(rule.model) === pricingRuleModel(options.model))) {
      sendJson(res, { error: '该模型没有匹配的已启用渠道规则，请重新选择参考 Provider' }, 400);
      return;
    }
    const { scopes, backupPath, ...result } = await repriceUsage(db, pricing, options);
    console.log(`[费用重算] ${options.apply ? '执行' : '预览'}，开始: ${options.start}，结束: ${options.end}，模型: ${options.model || '全部'}，补算旧 Pi 零金额: ${options.recoverLegacyPiZero}，参考 Provider: ${options.fallbackProvider || '默认'}，范围: ${scopes.length}，调用: ${result.counts.time}，差额 USD: ${result.difference}，价格版本: ${pricing.version}`);
    if (backupPath) console.log(`[费用重算] 服务端备份: ${backupPath}`);
    sendJson(res, { ...result, backupFile: backupPath ? basename(backupPath) : null });
  } catch (error) {
    if (error.status === 409) {
      sendJson(res, { error: error.message }, 409);
      return;
    }
    console.error('[费用重算] 处理失败，请检查价格规则、数据库和备份目录权限。', error);
    sendJson(res, { error: '费用重算失败，请查看服务端日志' }, 500);
  }
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function trimOutput(value) {
  const text = String(value || '').trim();
  return text.length > 12000 ? `${text.slice(-12000)}` : text;
}

function readJson(req) {
  return new Promise((resolveRequest, rejectRequest) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        rejectRequest(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolveRequest(JSON.parse(body || '{}'));
      } catch (error) {
        rejectRequest(error);
      }
    });
    req.on('error', rejectRequest);
  });
}

function contentType(filePath) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.jsx': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  };
  return types[extname(filePath)] || 'application/octet-stream';
}
