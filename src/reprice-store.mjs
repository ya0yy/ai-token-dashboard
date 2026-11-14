import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withReadSnapshot } from './db.mjs';
import { fromStored, TABLES, tokenFields } from './db-batch.mjs';
import { collectionScopeKey, lockCollectionState } from './collection-state.mjs';
import { digest, exactColumn } from './sync-journal.mjs';
import { rowKey, writeSnapshot } from './usage-store.mjs';
import { backupSnapshotPages } from './usage-backup.mjs';
import { addProjectCostChanges, planReprice, updateLegacySessions } from './reprice-plan.mjs';

const dateColumn = 'usage_date';
const pageSize = 1000;

function usageFilter(db, options, scope) {
  const where = [`${dateColumn} >= ?`, `${dateColumn} <= ?`];
  const params = [options.start, options.end];
  for (const [key, value] of Object.entries({ device: scope?.device ?? options.device,
    source: scope?.source ?? options.source, model: options.model })) {
    if (!value) continue;
    where.push(`${exactColumn(db, key)} = ?`);
    params.push(value);
  }
  return { where: where.join(' AND '), params };
}

async function matchingScopes(db, options) {
  const { where, params } = usageFilter(db, options);
  return db.all(`SELECT DISTINCT ${exactColumn(db, 'device')} AS device, ${exactColumn(db, 'source')} AS source
    FROM daily_usage WHERE ${where}`, params);
}

// 兼容会话覆盖项目的历史用量，通过数据库汇总校验，避免读取范围外的每笔调用。
async function legacyProjectTotals(db, scope, paths) {
  const columns = TABLES.time.fields.filter(([, field]) => tokenFields.includes(field));
  const project = exactColumn(db, 'project_path');
  const model = exactColumn(db, 'model');
  const projects = new Map();
  for (let i = 0; i < paths.length; i += 200) {
    const batch = paths.slice(i, i + 200);
    const rows = await db.all(`SELECT ${project} AS project_path, ${model} AS model, SUM(cost_usd) AS cost_usd,
      ${columns.map(([column]) => `SUM(${column}) AS ${column}`).join(', ')}
      FROM time_usage WHERE ${exactColumn(db, 'device')} = ? AND ${exactColumn(db, 'source')} = ?
      AND ${project} IN (${batch.map(() => '?').join(', ')}) GROUP BY ${project}, ${model}`, [scope.device, scope.source, ...batch]);
    for (const row of rows) {
      const key = JSON.stringify([scope.device, scope.source, row.project_path]);
      if (!projects.has(key)) projects.set(key, []);
      projects.get(key).push({ model: row.model, costUSD: Number(row.cost_usd),
        ...Object.fromEntries(columns.map(([column, field]) => [field, Number(row[column])])) });
    }
  }
  return projects;
}

async function* backupPages(db, scopes, kind) {
  const { table, keys } = TABLES[kind];
  const key = db.driver === 'mysql' ? 'row_key' : keys.at(-1);
  const columns = kind === 'daily' && db.driver !== 'mysql' ? [dateColumn, key] : [key];
  const order = columns.join(', ');
  const after = columns.length === 1 ? `${key} > ?` : `(${order}) > (${columns.map(() => '?').join(', ')})`;
  for (const scope of scopes) {
    const where = `${exactColumn(db, 'device')} = ? AND ${exactColumn(db, 'source')} = ?`;
    let cursor = [];
    while (true) {
      const rows = await db.all(`SELECT * FROM ${table} WHERE ${where}${cursor.length ? ` AND ${after}` : ''}
        ORDER BY ${order} LIMIT ?`, [scope.device, scope.source, ...cursor, pageSize]);
      if (!rows.length) break;
      yield rows.map(row => fromStored(kind, row));
      if (rows.length < pageSize) break;
      cursor = columns.map(column => rows.at(-1)[column]);
    }
  }
}

export async function repriceUsage(db, pricing, options) {
  const { apply = false, protect = false, previewId } = options;
  const directory = apply ? await mkdtemp(join(tmpdir(), 'dashboard-reprice-')) : null;
  let file;
  try {
    if (directory) file = await open(join(directory, 'updates.jsonl'), 'w+', 0o600);
    const work = async tx => {
      const scopes = await matchingScopes(tx, options);
      const ordered = scopes.sort((a, b) => collectionScopeKey(a).localeCompare(collectionScopeKey(b)));
      if (apply) for (const scope of ordered) await lockCollectionState(tx, scope);
      const changedScopes = [];
      const counts = { daily: 0, time: 0, sessions: 0 };
      const signatures = createHash('sha256');
      const skipped = { incompleteDetail: 0, costMismatch: 0, recordedDay: 0, noEligibleEvents: 0, incompleteSession: 0 };
      let costBefore = 0;
      let costAfter = 0;

      // 预览只保留统计和摘要，执行时把待写回的记录分批暂存到磁盘。
      async function recordChanges(kind, rows, original) {
        if (!rows.length) return;
        counts[kind] += rows.length;
        rows.sort((a, b) => rowKey(kind, a).localeCompare(rowKey(kind, b)));
        for (let i = 0; i < rows.length; i += pageSize) {
          const page = rows.slice(i, i + pageSize);
          signatures.update(JSON.stringify([kind, page.map(row => [row, original.get(rowKey(kind, row)).costUSD])]));
          if (file) {
            const changes = protect && kind !== 'sessions' ? page.map(row => ({ ...row, hubRepriced: 1 })) : page;
            await file.writeFile(JSON.stringify([kind, changes]) + '\n');
          }
        }
      }

      for (const scope of ordered) {
        const { where, params } = usageFilter(tx, options, scope);
        const daily = (await tx.all(`SELECT * FROM daily_usage WHERE ${where} ORDER BY usage_date, model`, params))
          .map(row => fromStored('daily', row));
        const changedProjects = new Map();
        const initial = counts.daily;
        // 按日处理，避免读入设备或整个日期范围的全部调用。
        for (const date of new Set(daily.map(row => row.usageDate))) {
          const time = (await tx.all(`SELECT * FROM time_usage WHERE ${dateColumn} = ? AND ${where}
            ORDER BY ${exactColumn(tx, 'event_key')}`, [date, ...params]))
            .map(row => fromStored('time', row));
          const days = daily.filter(row => row.usageDate === date);
          const plan = planReprice({ daily: days, time, sessions: [] }, pricing, options);
          costBefore += plan.costBefore;
          costAfter += plan.costAfter;
          for (const key of Object.keys(skipped)) skipped[key] += plan.skipped[key];
          if (!plan.next.daily.length) continue;
          const oldEvents = new Map(time.map(row => [rowKey('time', row), row]));
          addProjectCostChanges(changedProjects, plan.next.time, oldEvents);
          await recordChanges('daily', plan.next.daily, new Map(days.map(row => [rowKey('daily', row), row])));
          await recordChanges('time', plan.next.time, oldEvents);
        }
        if (counts.daily === initial) continue;
        changedScopes.push(scope);
        if (!changedProjects.size) continue;
        const sessions = (await tx.all(`SELECT * FROM session_usage WHERE ${exactColumn(tx, 'device')} = ?
          AND ${exactColumn(tx, 'source')} = ? AND project_path IS NOT NULL AND session_id LIKE 'local:%'`, [scope.device, scope.source]))
          .map(row => fromStored('sessions', row))
          .filter(row => changedProjects.has(JSON.stringify([scope.device, scope.source, row.projectPath])));
        if (sessions.length) {
          const projects = await legacyProjectTotals(tx, scope, [...new Set(sessions.map(row => row.projectPath))]);
          const changes = updateLegacySessions(sessions, projects, changedProjects, skipped);
          await recordChanges('sessions', changes, new Map(sessions.map(row => [rowKey('sessions', row), row])));
        }
      }

      const id = digest([pricing.version, options.start, options.end, options.model, options.recoverLegacyPiZero, options.fallbackProvider,
        skipped, costBefore, costAfter, signatures.digest('hex')]);
      if (previewId && id !== previewId) {
        throw Object.assign(new Error('价格或用量已变化，请重新预览后再执行'), { status: 409 });
      }
      let backupPath = null;
      if (file && changedScopes.length) {
        backupPath = await backupSnapshotPages(changedScopes, kind => backupPages(tx, changedScopes, kind));
        for await (const line of file.readLines({ start: 0 })) {
          const [kind, rows] = JSON.parse(line);
          await writeSnapshot(tx, { daily: [], time: [], sessions: [], [kind]: rows });
        }
      }
      return { version: pricing.version, previewId: id, applied: apply, scopes, skipped, costBefore, costAfter,
        difference: costAfter - costBefore, backupPath, counts };
    };
    return apply ? await db.transaction(work) : await withReadSnapshot(db, work);
  } finally {
    await file?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
