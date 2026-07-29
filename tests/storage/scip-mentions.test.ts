import { describe, expect, it, vi } from 'vitest';
import type { ScipDatabase } from '../../src/storage/db.js';
import { mentionReferenceChunkRows, SQLITE_PARAM_BATCH_SIZE } from '../../src/storage/scip-mentions.js';

describe('SCIP mention batching', () => {
  it('retains every requested symbol across multiple SQLite parameter batches', () => {
    const all = vi.fn((_sql: string, ...symbolIds: number[]) =>
      symbolIds.map((symbolId) => ({
        symbol_id: symbolId,
        relative_path: `src/${symbolId}.ts`,
        document_id: symbolId,
        chunk_start: symbolId,
        chunk_end: symbolId,
      })),
    );
    const db = {
      all,
      pathExclusionsFor: () => '',
    } as unknown as ScipDatabase;
    const symbolIds = Array.from({ length: SQLITE_PARAM_BATCH_SIZE * 2 + 1 }, (_, index) => index + 1);

    const rows = mentionReferenceChunkRows(db, symbolIds);

    expect(all.mock.calls.map((call) => call.length - 1)).toEqual([
      SQLITE_PARAM_BATCH_SIZE,
      SQLITE_PARAM_BATCH_SIZE,
      1,
    ]);
    expect(rows.map((row) => row.symbol_id)).toEqual(symbolIds);
  });

  it('does not query SQLite for an empty symbol set', () => {
    const all = vi.fn();
    const db = {
      all,
      pathExclusionsFor: () => '',
    } as unknown as ScipDatabase;

    expect(mentionReferenceChunkRows(db, [])).toEqual([]);
    expect(all).not.toHaveBeenCalled();
  });
});
