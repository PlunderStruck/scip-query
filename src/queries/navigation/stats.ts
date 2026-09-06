import { statSync } from 'node:fs';
import type { ScipDatabase } from '../../storage/db.js';

export interface StatsResult {
  documents: number;
  symbols: number;
  definitions: number;
  references: number;
  indexSizeBytes: number;
  /** Database file modification time; legacy name, not evidence of source freshness. */
  lastBuilt: Date | null;
}

export function stats(db: ScipDatabase): StatsResult {
  const documents = db.get<{ c: number }>('SELECT COUNT(*) as c FROM documents')!.c;
  const symbols = db.get<{ c: number }>('SELECT COUNT(*) as c FROM global_symbols')!.c;
  const definitions = db.get<{ c: number }>('SELECT COUNT(*) as c FROM mentions WHERE role = 1')!.c;
  const references = db.get<{ c: number }>('SELECT COUNT(*) as c FROM mentions WHERE role != 1')!.c;

  return {
    documents,
    symbols,
    definitions,
    references,
    ...readDbFileStats(db.generation.databasePath),
  };
}

function readDbFileStats(dbPath: string): Pick<StatsResult, 'indexSizeBytes' | 'lastBuilt'> {
  try {
    const stat = statSync(dbPath);
    return { indexSizeBytes: stat.size, lastBuilt: stat.mtime };
  } catch {
    return { indexSizeBytes: 0, lastBuilt: null };
  }
}
