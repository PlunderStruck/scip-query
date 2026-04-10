import type { ScipDatabase } from '../db.js';
import type { StatsResult } from '../types.js';

export function stats(db: ScipDatabase): StatsResult {
  const documents = db.get<{ c: number }>('SELECT COUNT(*) as c FROM documents')!.c;
  const symbols = db.get<{ c: number }>('SELECT COUNT(*) as c FROM global_symbols')!.c;
  const definitions = db.get<{ c: number }>(
    'SELECT COUNT(*) as c FROM mentions WHERE role = 1',
  )!.c;
  const references = db.get<{ c: number }>(
    'SELECT COUNT(*) as c FROM mentions WHERE role != 1',
  )!.c;

  return {
    documents,
    symbols,
    definitions,
    references,
    indexSizeBytes: db.sizeBytes(),
    lastBuilt: db.lastModified(),
  };
}
