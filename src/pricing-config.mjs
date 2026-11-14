import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { validDate } from './ingest-validation.mjs';
import { loadPricing, priceFields, pricingRuleModel } from './pricing.mjs';
import { deepSeekApiSchedule } from './deepseek-schedule.mjs';
import { normalizeModelForGrouping } from './collectors/utils.mjs';
import { resolveDisplayTz } from './timezone.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const policyPath = () => resolve('data', 'pricing-rules.json');
const emptyPolicy = () => ({ timeZone: resolveDisplayTz(), defaults: [], rules: [] });
async function readCatalog(name) {
  const path = resolve('data', `pricing-${name}.json`);
  try {
    const { data } = JSON.parse(await readFile(path, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('目录缺少 data 对象');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`读取内置价格失败，请检查 ${path} 或重新刷新价格目录`, { cause: error });
  }
}

function identifier(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || value.includes('\0')) {
    throw new Error(`请填写有效的${label}（最多 255 个字符）`);
  }
  return value.trim();
}

function rates(value) {
  if (!priceFields.every(key => Number.isFinite(value?.[key]) && value[key] >= 0)) {
    throw new Error('输入、输出、缓存读取和缓存写入价格均须为非负数字');
  }
  return Object.fromEntries(priceFields.map(key => [key, value[key]]));
}

export function validatePricingPolicy(value) {
  if (!Array.isArray(value?.defaults) || !Array.isArray(value?.rules)) throw new Error('价格规则格式无效');
  const timeZone = identifier(value.timeZone, '计价时区');
  try { new Intl.DateTimeFormat('en', { timeZone }); }
  catch { throw new Error('计价时区无效，请使用 Asia/Shanghai 等 IANA 时区'); }
  if (!/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(timeZone)) throw new Error('计价时区须为 IANA 时区');
  const defaults = value.defaults.map(row => ({
    model: identifier(row?.model, '模型 ID').toLowerCase(), rates: rates(row.rates)
  }));
  if (new Set(defaults.map(row => normalizeModelForGrouping(row.model))).size !== defaults.length) {
    throw new Error('同一模型只能设置一条默认价格（包括不同版本别名）');
  }
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
  const rules = value.rules.map(row => {
    const provider = identifier(row?.provider, 'Provider');
    const model = identifier(row.model, '模型 ID').toLowerCase();
    if (typeof row.enabled !== 'boolean') throw new Error('峰谷价开关无效');
    const { offPeakStart, offPeakEnd, effectiveFrom = null, schedule } = row;
    if (effectiveFrom !== null && !validDate(effectiveFrom)) throw new Error('生效日期无效');
    const price = { provider, model, enabled: row.enabled, peak: rates(row.peak), offPeak: rates(row.offPeak) };
    if (schedule === deepSeekApiSchedule) return { ...price, schedule, effectiveFrom };
    if (schedule != null) throw new Error('不支持的峰谷时段');
    if (typeof offPeakStart !== 'string' || typeof offPeakEnd !== 'string'
      || !clock.test(offPeakStart) || !clock.test(offPeakEnd) || offPeakStart === offPeakEnd) {
      throw new Error('请填写不同的谷时开始与结束时间（HH:mm）');
    }
    return { ...price, offPeakStart, offPeakEnd, effectiveFrom };
  });
  if (new Set(rules.map(row => JSON.stringify([row.provider, pricingRuleModel(row.model)]))).size !== rules.length) {
    throw new Error('同一 Provider 和模型只能配置一条峰谷规则');
  }
  return { timeZone, defaults, rules };
}

export async function readPricingPolicy() {
  try { return validatePricingPolicy(JSON.parse(await readFile(policyPath(), 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return emptyPolicy();
    throw new Error(`读取价格规则失败，请检查 ${policyPath()}`, { cause: error });
  }
}

// 整份规则和内置目录共同决定版本，目录更新后也能区分计价依据。
export async function currentPricingSnapshot({ legacySchedulesOnly = false } = {}) {
  const [policy, litellm, openrouter] = await Promise.all([
    readPricingPolicy(), readCatalog('litellm'), readCatalog('openrouter')
  ]);
  // 旧采集器只能解析每日单段谷时。兼容快照的版本基于实际发送的规则。
  const compatiblePolicy = legacySchedulesOnly ? { ...policy, rules: policy.rules.filter(rule => !rule.schedule) } : policy;
  const snapshot = { policy: compatiblePolicy, litellm, openrouter };
  return { ...snapshot, version: hash(JSON.stringify(snapshot)) };
}

async function loadLocalPricing() {
  // 保持显式刷新入口。服务端读取已发布的文件，普通采集只加载一次快照。
  if (['1', 'true'].includes(process.env.PRICING_REFRESH)) await loadPricing(resolve('data', 'pricing-litellm.json'));
  const snapshot = await currentPricingSnapshot();
  if (!snapshot.litellm && !snapshot.openrouter && !snapshot.policy.defaults.length) {
    console.warn('[模型定价] 缺少内置价格目录，可运行 npm run pricing:update 或在定价页添加模型默认价。');
  }
  return snapshot;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function savePricingPolicy(policy) {
  await writeJson(policyPath(), policy);
}

function validateSnapshot(value) {
  const policy = validatePricingPolicy(value?.policy);
  const { litellm, openrouter, version } = value;
  for (const dataset of [litellm, openrouter]) {
    if (dataset !== null && (!dataset || typeof dataset !== 'object' || Array.isArray(dataset))) {
      throw new Error('价格目录格式无效');
    }
  }
  const snapshot = { policy, litellm, openrouter };
  if (version !== hash(JSON.stringify(snapshot))) throw new Error('价格规则与版本不匹配');
  return { ...snapshot, version };
}

export async function loadCollectionPricing({ push, token, requireFresh = false } = {}) {
  const configuredEndpoint = process.env.PRICING_SNAPSHOT_URL?.trim();
  if (!push && !configuredEndpoint) return loadLocalPricing();
  const target = new URL(push || configuredEndpoint);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('请使用 HTTP(S) 上报地址和 --token');
  }
  const endpoint = push ? new URL('pricing/snapshot', target) : target;
  endpoint.searchParams.set('schedules', 'extended');
  const pricingToken = token || process.env.PRICING_SNAPSHOT_TOKEN;
  const cachePath = resolve('data', 'pricing-cache', `${hash(endpoint.href)}.json`);
  let cached = null;
  try { cached = validateSnapshot(JSON.parse(await readFile(cachePath, 'utf8'))); }
  catch { /* 首次采集或缓存失效时重新下载完整目录。 */ }
  try {
    const response = await fetch(endpoint, {
      headers: {
        ...(pricingToken ? { authorization: `Bearer ${pricingToken}` } : {}),
        ...(cached ? { 'if-none-match': `"${cached.version}"` } : {})
      },
      redirect: 'error', signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 304 && cached) return cached;
    if (response.status === 404 && push && !requireFresh) {
      // 旧 Hub 可继续接收增量；已经使用集中定价的客户端优先保留上次发布的规则。
      if (cached) return cached;
      console.warn('[模型定价] 服务端未提供价格规则接口，使用本地默认价。升级服务端后可同步规则。');
      return loadLocalPricing();
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = validateSnapshot(await response.json());
    try { await writeJson(cachePath, snapshot); }
    catch (error) { console.warn('[模型定价] 无法缓存价格规则，请检查 data/pricing-cache 写入权限。', error.message); }
    console.log(`[模型定价] 已同步服务端价格规则，版本: ${snapshot.version}`);
    return snapshot;
  } catch (error) {
    if (cached && !requireFresh) {
      console.warn(`[模型定价] 拉取规则失败，使用上次缓存，版本: ${cached.version}。请检查服务端连接或令牌。 ${error.message}`);
      return cached;
    }
    throw new Error('无法获取服务端价格规则，请检查上报地址、令牌和服务端版本', { cause: error });
  }
}
