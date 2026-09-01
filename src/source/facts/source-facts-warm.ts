import type { ScipDatabase } from '../../storage/db.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { collectNativeGarbage } from '../../platform/native-gc.js';
import { getSourceFactsResult } from './source-facts.js';

export interface SourceFactsWarmOptions {
  /** Files read between event-loop turns; default 64. */
  batchSize?: number;
  /** Forces a full collection before each yield; default: the process collector. */
  collectGarbage?: () => boolean;
  yieldToEventLoop?: () => Promise<void>;
  onBatch?: (progress: { files: number; total: number }) => void;
}

/**
 * Persists every indexed file's source-facts product in batches that end with
 * a full collection and one event-loop turn. A cold product parses its file,
 * and a parsed tree is native memory behind a wrapper V8 never weighs, so a
 * synchronous whole-project read (the health phases read facts per
 * definition) would hold every tree of a cold sweep at once. After this pass
 * those reads hit the persisted product and parse nothing.
 */
export async function warmSourceFactsProducts(
  db: ScipDatabase,
  options: SourceFactsWarmOptions = {},
): Promise<{ files: number; withFacts: number }> {
  const files = indexedDocumentPaths(db, { includeIgnored: false });
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 64));
  const collectGarbage = options.collectGarbage ?? collectNativeGarbage;
  let read = 0;
  let withFacts = 0;
  for (let start = 0; start < files.length; start += batchSize) {
    for (const relativePath of files.slice(start, start + batchSize)) {
      if (getSourceFactsResult(db, relativePath).facts) withFacts += 1;
      read += 1;
    }
    options.onBatch?.({ files: read, total: files.length });
    collectGarbage();
    await options.yieldToEventLoop?.();
  }
  return { files: read, withFacts };
}
