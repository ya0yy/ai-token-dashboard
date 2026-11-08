import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const displayTime = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
console.log('[信息]', displayTime(), '开始采集本机用量并向中心服务推送。');
const child = spawn(process.execPath, [join(root, 'collector-entry-manual.mjs')], {
  cwd: root, stdio: 'inherit', timeout: 900_000,
});
// 超时后先由spawn发送SIGTERM；必要时再强制结束，避免任务无限等待。
const hardLimit = setTimeout(() => {
  console.error('[错误] 采集超过15分钟，请检查日志规模和网络；本轮将被强制结束。');
  child.kill('SIGKILL');
}, 905_000);
hardLimit.unref();
child.on('error', error => {
  console.error('[错误] 无法启动采集器，请检查Node路径和文件权限。', error);
  process.exitCode = 1;
});
child.on('close', (code, signal) => {
  clearTimeout(hardLimit);
  if (code === 0) console.log('[信息]', displayTime(), '本轮采集与推送完成。');
  else console.error('[错误] 采集未完成，退出码:', code, '信号:', signal,
    '；请查看前面的错误，超时可在下一轮重试。');
  process.exitCode = code ?? 1;
});
