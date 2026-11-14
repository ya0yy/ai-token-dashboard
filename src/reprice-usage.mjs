import './load-env.mjs';
import { openDb } from './db.mjs';
import { validDate } from './ingest-validation.mjs';
import { loadCollectionPricing } from './pricing-config.mjs';
import { repriceUsage } from './reprice-store.mjs';
import { syncDatabase } from './sync.mjs';

function readArgs(argv) {
  const options = {};
  const keys = ['start', 'end', 'device', 'source', 'model', 'db', 'push', 'token'];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--apply') {
      options.apply = true;
      continue;
    }
    const key = flag.slice(2);
    const value = argv[i + 1];
    if (!flag.startsWith('--') || !keys.includes(key) || !value?.trim() || value.startsWith('--')) {
      throw new Error(`参数无效或缺少值: ${flag}`);
    }
    options[key] = value;
    i++;
  }
  if (!validDate(options.start) || !validDate(options.end) || options.start > options.end) {
    throw new Error('请用 --start 和 --end 指定有效日期范围，格式为 YYYY-MM-DD');
  }
  if (options.token && !options.push) throw new Error('--token 需要与 --push 一起使用');
  return options;
}

async function run() {
  const options = readArgs(process.argv.slice(2));
  const pricing = await loadCollectionPricing({ ...options, requireFresh: true });
  if (!pricing?.version) throw new Error('没有可用的价格版本，请检查模型定价或服务端连接');

  const db = await openDb(options.db, { readOnly: !options.apply });
  try {
    const { scopes, counts, costBefore, costAfter, difference, backupPath, skipped } = await repriceUsage(db, pricing, options);
    console.log(`[费用重算] ${options.apply ? '执行' : '预览'}, 版本: ${pricing.version}, 日汇总: ${counts.daily}, 调用: ${counts.time}, 兼容会话汇总: ${counts.sessions}, 旧金额 USD: ${costBefore}, 新金额 USD: ${costAfter}, 差额 USD: ${difference}`);
    if (scopes.length) {
      console.log(`[费用重算] 跳过，明细不完整的天数: ${skipped.incompleteDetail}, 日费用与明细不符: ${skipped.costMismatch}, 已记录费用: ${skipped.recordedDay}, 无可更新调用: ${skipped.noEligibleEvents}, 无法核对的兼容会话汇总: ${skipped.incompleteSession}`);
    } else {
      console.log('[费用重算] 指定范围内没有日汇总，请检查日期、设备、来源和模型');
    }
    if (backupPath) console.log(`[费用重算] 本地提交成功，已更新调用: ${counts.time}，备份: ${backupPath}，可用 npm run db:restore 恢复`);
    if (options.apply && options.push) {
      for (const { device, source } of scopes) {
        try {
          const result = await syncDatabase({ db, url: options.push, token: options.token, device, source });
          console.log(`[费用重算] 同步完成，设备: ${device}, 来源: ${source}, 请求数: ${result.requests}`);
        } catch (error) {
          throw new Error(`本地数据已提交，设备 ${device} 的 ${source} 同步失败。请检查服务端连接后重试同步。`, { cause: error });
        }
      }
    }
  } finally {
    await db.close();
  }
}

try {
  await run();
} catch (error) {
  console.error('[费用重算] 执行失败。请检查参数、数据库及服务端连接。', error);
  process.exitCode = 1;
}
