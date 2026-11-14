import { withReadSnapshot } from './db.mjs';
import { collectionScopeKey, lockCollectionState } from './collection-state.mjs';
import { digest, exactColumn } from './sync-journal.mjs';
import { readSnapshot, rowKey, writeSnapshot } from './usage-store.mjs';
import { backupSnapshot } from './usage-backup.mjs';
import { planReprice } from './reprice-plan.mjs';

async function matchingScopes(db, options) {
  const where = ['usage_date >= ?', 'usage_date <= ?'];
  const params = [options.start, options.end];
  for (const key of ['device', 'source', 'model']) {
    if (options[key]) {
      where.push(`${exactColumn(db, key)} = ?`);
      params.push(options[key]);
    }
  }
  return db.all(`SELECT DISTINCT ${exactColumn(db, 'device')} AS device, ${exactColumn(db, 'source')} AS source
    FROM daily_usage WHERE ${where.join(' AND ')}`, params);
}

export async function repriceUsage(db, pricing, options) {
  const { apply = false, protect = false, previewId } = options;
  const work = async tx => {
    const scopes = await matchingScopes(tx, options);
    const ordered = scopes.sort((a, b) => collectionScopeKey(a).localeCompare(collectionScopeKey(b)));
    const backup = { daily: [], time: [], sessions: [] };
    const updated = { daily: [], time: [], sessions: [] };
    const changedScopes = [];
    const changes = [];
    const skipped = { incompleteDetail: 0, costMismatch: 0, recordedDay: 0, noEligibleEvents: 0, incompleteSession: 0 };
    let costBefore = 0;
    let costAfter = 0;

    for (const scope of ordered) {
      if (apply) await lockCollectionState(tx, scope);
      const previous = await readSnapshot(tx, scope.device, scope.source);
      const plan = planReprice(previous, pricing, options);
      costBefore += plan.costBefore;
      costAfter += plan.costAfter;
      for (const key of Object.keys(skipped)) skipped[key] += plan.skipped[key];
      if (!plan.next.daily.length) continue;
      changedScopes.push(scope);
      for (const kind of Object.keys(updated)) {
        const originalCosts = new Map(previous[kind].map(row => [rowKey(kind, row), row.costUSD]));
        const rows = plan.next[kind].sort((a, b) => rowKey(kind, a).localeCompare(rowKey(kind, b)));
        changes.push(digest(rows.map(row => [row, originalCosts.get(rowKey(kind, row))])));
        for (const row of rows) updated[kind].push(protect && kind !== 'sessions' ? { ...row, hubRepriced: 1 } : row);
        if (apply) for (const row of previous[kind]) backup[kind].push(row);
      }
    }

    // 执行时重新核对这次预览的范围、价格版本和金额，价格或用量变化时提示重新预览。
    const id = digest([pricing.version, options.start, options.end, options.model, options.recoverLegacyPiZero,
      skipped, costBefore, costAfter, changes]);
    if (previewId && id !== previewId) {
      throw Object.assign(new Error('价格或用量已变化，请重新预览后再执行'), { status: 409 });
    }
    let backupPath = null;
    if (apply && changedScopes.length) {
      backupPath = backupSnapshot(backup, changedScopes);
      await writeSnapshot(tx, updated);
    }
    return {
      version: pricing.version, previewId: id, applied: apply, scopes, skipped, costBefore, costAfter,
      difference: costAfter - costBefore, backupPath,
      counts: Object.fromEntries(Object.entries(updated).map(([kind, rows]) => [kind, rows.length]))
    };
  };
  return apply ? db.transaction(work) : withReadSnapshot(db, work);
}
