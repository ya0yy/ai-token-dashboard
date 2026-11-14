import { homedir } from 'node:os';
import { join } from 'node:path';
import { configuredPaths, expandPath } from '../collector-config.mjs';
import { collectSessions } from './pi.mjs';

export const CLIENT_KEY = 'omp';
export const SOURCE_LABEL = 'Oh My Pi';

export function sessionRoots() {
  const sessionDir = expandPath(process.env.OMP_SESSION_DIR);
  return sessionDir ? [sessionDir] : configuredPaths(CLIENT_KEY, 'roots', [join(homedir(), '.omp', 'agent', 'sessions')]);
}

// OMP 与 Pi 都使用树状 JSONL 会话，分别扫描各自的路径并使用独立缓存。
export function collect(pricingData = null) {
  return collectSessions(pricingData, { roots: sessionRoots(), client: CLIENT_KEY, omp: true });
}
