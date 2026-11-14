import { mkdirSync, writeFileSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

function newBackupPath() {
  const directory = resolve(process.cwd(), 'data', 'backups');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return resolve(directory, `usage-${Date.now()}-${randomUUID()}.json`);
}

export function backupSnapshot(snapshot, scopes) {
  const path = newBackupPath();
  writeFileSync(path, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), scopes, ...snapshot }), { mode: 0o600, flag: 'wx' });
  return path;
}

// 保留与 db:restore 兼容的完整范围备份，每次只序列化一页。
export async function backupSnapshotPages(scopes, readPages) {
  const path = newBackupPath();
  const file = await open(path, 'wx', 0o600);
  try {
    const header = JSON.stringify({ version: 1, createdAt: new Date().toISOString(), scopes });
    await file.writeFile(header.slice(0, -1));
    for (const kind of ['daily', 'time', 'sessions']) {
      await file.writeFile(`,${JSON.stringify(kind)}:[`);
      let separator = '';
      for await (const rows of readPages(kind)) {
        if (!rows.length) continue;
        await file.writeFile(separator + JSON.stringify(rows).slice(1, -1));
        separator = ',';
      }
      await file.writeFile(']');
    }
    await file.writeFile('}');
    await file.close();
    return path;
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
}
