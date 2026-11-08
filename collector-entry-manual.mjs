import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const root = dirname(fileURLToPath(import.meta.url));
  const settings = JSON.parse(readFileSync(join(root, 'client.json'), 'utf8'));
  const endpoint = new URL(settings.pushUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('pushUrl须为不含账号密码或查询串的HTTPS地址，采集令牌应单独填写在ingestToken。');
  }
  if (!settings.device || !settings.ingestToken) throw new Error('client.json中缺少device或ingestToken。');
  process.chdir(root);
  delete process.env.DATABASE_URL;
  process.env.DB_DRIVER = 'sqlite';
  process.env.DB_PATH = join(root, 'data', 'usage.sqlite');
  process.env.DISPLAY_TZ = settings.timezone || 'Asia/Shanghai';
  process.env.SUBSCRIPTION_QUOTA_ENABLED = 'false';
  // 配置在运行时读取，令牌不进入操作系统的命令行参数。
  process.argv = [process.execPath, 'src/collect.mjs', '--device', settings.device,
    '--push', endpoint.href, '--token', settings.ingestToken];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (!response.ok && String(args[0]) === endpoint.href) {
      console.error('[错误] 服务端拒绝推送，HTTP状态:', response.status,
        '服务端错误:', (await response.clone().text()).slice(0, 4000));
    }
    return response;
  };
  await import('./src/collect.mjs');
} catch (error) {
  console.error('[错误] 采集或公网推送失败，请检查HTTPS地址、采集令牌、网络和用量日志。', error);
  if (error.cause) console.error('[错误] 底层原因:', error.cause);
  process.exitCode = 1;
}
