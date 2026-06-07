import type { ScipDatabase } from '../storage/db.js';
import { clearCallGraphEvidenceCaches } from './call-graph-evidence.js';
import { clearFileDepGraphCache } from './file-dep-graph.js';
import { clearGlobalLeafIndexCache } from './leaf-symbol-index.js';

export function clearSymbolEvidenceCaches(db: ScipDatabase): void {
  clearFileDepGraphCache(db);
  clearCallGraphEvidenceCaches(db);
  clearGlobalLeafIndexCache(db);
}
