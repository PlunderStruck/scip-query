/**
 * reference-graph — compatibility facade for graph-shaped symbol evidence.
 *
 * Concrete responsibilities live in smaller modules:
 * - file-dep-graph: file-to-file dependency edges.
 * - call-graph-evidence: caller/callee rows and maps.
 * - leaf-symbol-index: global leaf-name lookup for AST call resolution.
 * - reference-sites: concrete reference-site resolution.
 */
import type { ScipDatabase } from '../storage/db.js';
import { clearCallGraphEvidenceCaches } from './call-graph-evidence.js';
import { clearFileDepGraphCache } from './file-dep-graph.js';
import { clearGlobalLeafIndexCache } from './leaf-symbol-index.js';

export type { ReferenceSite } from '../domain/types.js';
export type { CalleeRow, CallerRow } from './call-graph-evidence.js';
export type { GlobalLeafCandidate } from './leaf-symbol-index.js';
export {
  buildAstCalleeMap,
  buildCalleeMap,
  buildCallerRowsMap,
  buildChunkCalleeMap,
  getCalleeRowsForSymbol,
  getCallerRowsForSymbol,
} from './call-graph-evidence.js';
export { buildFileDepGraph } from './file-dep-graph.js';
export {
  getGlobalLeafIndex,
  pickAstCallCandidate,
  sameLanguageCandidates,
} from './leaf-symbol-index.js';
export {
  buildReferenceSites,
  getResolvedReferenceSites,
  resolvedCandidateLines,
  resolveReferencePrelude,
} from './reference-sites.js';

export function clearReferenceGraphCaches(db: ScipDatabase): void {
  clearFileDepGraphCache(db);
  clearCallGraphEvidenceCaches(db);
  clearGlobalLeafIndexCache(db);
}
