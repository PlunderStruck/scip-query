import { getHeapStatistics } from 'node:v8';
import type { ScipDatabase } from '../storage/db.js';
import { clearLanguageParserCaches } from '../language-parsers/index.js';
import { clearSemanticProviderCache } from '../semantic/index.js';
import { clearAstCache } from '../source/ast.js';
import { clearSourceStripperCache } from '../source/source-stripper.js';
import { clearSourceTextCache } from '../source/source-text.js';
import { clearIdentifierIndexCache } from '../symbols/identifier-index.js';
import { clearSymbolEvidenceCaches } from '../symbols/symbol-evidence-cache.js';

const GC_HEADROOM_BYTES = 64 * 1024 * 1024;

/**
 * Drop source-derived caches after one-shot whole-repo health phases.
 * Interactive commands benefit from retaining these caches, but composite
 * health runs can otherwise keep parsed trees, source strings, ts-morph
 * projects, and identifier maps alive after the phase that needed them.
 */
export function clearHealthAnalysisCaches(
  db: ScipDatabase,
  opts: { semanticProvider?: boolean } = {},
): void {
  clearSymbolEvidenceCaches(db);
  if (opts.semanticProvider === true) clearSemanticProviderCache(db);
  clearIdentifierIndexCache(db);
  clearLanguageParserCaches(db);
  clearSourceStripperCache(db);
  clearAstCache(db);
  clearSourceTextCache(db);
}

export function requestGarbageCollection(): void {
  const maybeGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!maybeGc) return;

  const heap = getHeapStatistics();
  if (heap.heap_size_limit - heap.used_heap_size < GC_HEADROOM_BYTES) return;

  maybeGc();
}
