import { fromBinary } from '@bufbuild/protobuf';
import { DocumentSchema, SymbolRole } from '@c4312/scip';
import { zstdDecompressSync } from 'node:zlib';
import type { IndexedDefinition } from '../../domain/types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { createPerDbCache, createPerDbValue } from '../../storage/per-db-cache.js';
import { getAllDefinitions } from '../definition-catalog.js';
import { leafName } from '../symbol-parser.js';

/** One compiler-resolved reference to an indexed definition on a source line. */
export interface ChunkOccurrenceTarget {
  sourceLine: number;
  definition: IndexedDefinition;
}

/** One occurrence of a `local N` symbol: a parameter, local variable, or other function-scoped binding. */
export interface LocalOccurrence {
  symbol: string;
  line: number;
  startChar: number;
  endLine: number;
  endChar: number;
  /** True at the binding's declaration; false at every read or write of it. */
  definition: boolean;
  /** True where the indexer marked the occurrence as a write to the binding. */
  write: boolean;
}

export interface FileOccurrenceTargets {
  /** References the indexer resolved to definitions inside the indexed repository. */
  targets: ChunkOccurrenceTarget[];
  /**
   * `line\0leaf` keys of references the indexer resolved to a symbol outside
   * the indexed repository (library, ambient, or workspace-external). A call
   * at such a key must not be guessed onto a same-named repository symbol.
   */
  externalLeafKeys: Set<string>;
  /** Function-scoped bindings the indexer emitted, in document order; empty when the indexer emits none. */
  locals: LocalOccurrence[];
}

export type ChunkOccurrenceLookup =
  | ({ available: true } & FileOccurrenceTargets)
  | { available: false; reason: 'no-document' | 'no-occurrence-data' };

/**
 * Decoded occurrences are re-derivable from the index in milliseconds, but a
 * large file holds thousands of them; a whole-project pass must not keep
 * every file's decode resident, so the cache is bounded by recency.
 */
const FILE_OCCURRENCE_LOOKUP = createPerDbCache<string, ChunkOccurrenceLookup>('scip-chunk-occurrence-targets', {
  clearGroups: ['whole-project', 'definition-catalog', 'source-file'],
  maxEntries: 256,
});

const DEFINITION_BY_SYMBOL = createPerDbValue<Map<string, IndexedDefinition>>('scip-chunk-occurrence-definitions', {
  clearGroups: ['whole-project', 'definition-catalog'],
});

/** A stored chunk blob shorter than this cannot be a zstd frame; fixtures store a one-byte placeholder. */
const OCCURRENCE_BLOB_PLACEHOLDER_MAX_BYTES = 1;

const INDEX_STORES_OCCURRENCE_DATA = createPerDbValue<boolean>('scip-chunk-occurrence-data-present', {
  clearGroups: ['whole-project'],
});

/**
 * Whether this index's chunk blobs carry occurrence data at all. A converter
 * writes a zstd frame for every chunk, so one placeholder-sized blob (or no
 * chunk rows) means the index was built without occurrences and the SCIP
 * artifact is the only occurrence source.
 */
export function indexStoresOccurrenceData(db: ScipDatabase): boolean {
  return INDEX_STORES_OCCURRENCE_DATA.get(db, () => {
    const probe = db.get<{ size: number | null }>('SELECT length(occurrences) AS size FROM chunks LIMIT 1');
    return probe !== undefined && (probe.size ?? 0) > OCCURRENCE_BLOB_PLACEHOLDER_MAX_BYTES;
  });
}

/**
 * Decode the compiler-resolved occurrences the index stores for one file.
 *
 * Every SCIP-to-SQLite converter keeps each chunk's occurrences as a
 * zstd-compressed `Document{occurrences}` blob, so the exact symbol the
 * indexer bound at each source line is recoverable per file without loading
 * the whole SCIP artifact. The result is cached per database and file.
 */
export function chunkOccurrenceTargetsForFile(db: ScipDatabase, relativePath: string): ChunkOccurrenceLookup {
  return FILE_OCCURRENCE_LOOKUP.get(db, relativePath, () => decodeFileOccurrences(db, relativePath));
}

export function occurrenceLeafKey(line: number, leaf: string): string {
  return `${line}\0${leaf}`;
}

function decodeFileOccurrences(db: ScipDatabase, relativePath: string): ChunkOccurrenceLookup {
  const document = db.get<{ id: number }>('SELECT id FROM documents WHERE relative_path = ?', relativePath);
  if (!document) return { available: false, reason: 'no-document' };
  const rows = db.all<{ occurrences: Uint8Array | null }>(
    'SELECT occurrences FROM chunks WHERE document_id = ? ORDER BY chunk_index',
    document.id,
  );
  if (rows.length === 0) {
    return indexStoresOccurrenceData(db)
      ? { available: true, targets: [], externalLeafKeys: new Set(), locals: [] }
      : { available: false, reason: 'no-occurrence-data' };
  }
  const definitions = DEFINITION_BY_SYMBOL.get(
    db,
    () => new Map(getAllDefinitions(db).map((definition) => [definition.symbol, definition])),
  );
  const targets: ChunkOccurrenceTarget[] = [];
  const externalLeafKeys = new Set<string>();
  const locals: LocalOccurrence[] = [];
  try {
    for (const row of rows) {
      const blob = row.occurrences;
      if (!blob || blob.length <= OCCURRENCE_BLOB_PLACEHOLDER_MAX_BYTES) {
        return { available: false, reason: 'no-occurrence-data' };
      }
      const decoded = fromBinary(DocumentSchema, new Uint8Array(zstdDecompressSync(blob)));
      for (const occurrence of decoded.occurrences) {
        if (!occurrence.symbol) continue;
        const sourceLine = occurrence.range[0];
        if (!Number.isInteger(sourceLine)) continue;
        if (occurrence.symbol.startsWith('local ')) {
          locals.push(localOccurrence(occurrence.symbol, occurrence.range, occurrence.symbolRoles));
          continue;
        }
        if ((occurrence.symbolRoles & SymbolRole.Definition) !== 0) continue;
        const definition = definitions.get(occurrence.symbol);
        if (definition) {
          targets.push({ sourceLine: sourceLine!, definition });
          continue;
        }
        const leaf = externalSymbolLeaf(occurrence.symbol);
        if (leaf) externalLeafKeys.add(occurrenceLeafKey(sourceLine!, leaf));
      }
    }
  } catch {
    return { available: false, reason: 'no-occurrence-data' };
  }
  return { available: true, targets, externalLeafKeys, locals };
}

/** SCIP ranges are `[line, start, end]` on one line or `[startLine, start, endLine, end]` across lines. */
function localOccurrence(symbol: string, range: readonly number[], roles: number): LocalOccurrence {
  const multiLine = range.length === 4;
  return {
    symbol,
    line: range[0]!,
    startChar: range[1] ?? 0,
    endLine: multiLine ? range[2]! : range[0]!,
    endChar: multiLine ? (range[3] ?? 0) : (range[2] ?? 0),
    definition: (roles & SymbolRole.Definition) !== 0,
    write: (roles & SymbolRole.WriteAccess) !== 0,
  };
}

/** Leaf identifier of a non-local external symbol, or null when the symbol carries no usable name. */
function externalSymbolLeaf(symbol: string): string | null {
  if (symbol.startsWith('local ')) return null;
  try {
    const leaf = leafName(symbol);
    return leaf.length > 0 ? leaf : null;
  } catch {
    return null;
  }
}
