import type { ScipDatabase } from '../storage/db.js';
import type { IndexedDefinition } from '../domain/types.js';
import { collectNativeGarbage } from '../domain/native-gc.js';
import { getDefinitionsForFile } from '../symbols/definition-catalog.js';
import { getReExports, readSourceImportsUncached } from '../language-parsers/index.js';
import { getSourceFactsResult } from '../source/facts/source-facts.js';

export interface FileProductWarmOptions {
  /** Files processed between event-loop turns; default 64. */
  batchSize?: number;
  /** Forces a full collection before each yield; default: the process collector. */
  collectGarbage?: () => boolean;
  yieldToEventLoop?: () => Promise<void>;
  onBatch?: (progress: { files: number; total: number; definitions: number }) => void;
}

export interface FileProductWarmResult {
  files: number;
  definitions: IndexedDefinition[];
}

/**
 * Persists every per-file product the health phases read (definitions,
 * imports, re-exports, source facts) with one parse per file: the products
 * are computed back to back while the file's syntax tree is still in the
 * bounded tree cache, instead of in separate sweeps that each parse the
 * repository again. Batches end with a full collection and one event-loop
 * turn, which is when a parsed tree's native memory is actually freed.
 */
export async function warmFileProducts(
  db: ScipDatabase,
  files: readonly string[],
  options: FileProductWarmOptions = {},
): Promise<FileProductWarmResult> {
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 64));
  const collectGarbage = options.collectGarbage ?? collectNativeGarbage;
  const definitions: IndexedDefinition[] = [];
  let processed = 0;
  for (let start = 0; start < files.length; start += batchSize) {
    for (const relativePath of files.slice(start, start + batchSize)) {
      for (const row of getDefinitionsForFile(db, relativePath)) {
        if (!db.isIgnored(row.relativePath)) definitions.push(row);
      }
      readSourceImportsUncached(db, relativePath);
      getReExports(db, relativePath);
      getSourceFactsResult(db, relativePath);
      processed += 1;
    }
    options.onBatch?.({ files: processed, total: files.length, definitions: definitions.length });
    collectGarbage();
    await options.yieldToEventLoop?.();
  }
  return { files: processed, definitions };
}
