import type { IndexedDefinition, SymbolMatch } from '../domain/types.js';
import type { ScipDatabase } from '../storage/db.js';

export interface SymbolSemanticReference {
  file: string;
  line: number;
  column: number;
}

export interface SymbolSemanticCallee {
  symbol: string;
  file: string;
  line: number;
}

export interface SymbolSemanticEvidencePort {
  references(db: ScipDatabase, definition: IndexedDefinition): SymbolSemanticReference[];
  referenceMap(db: ScipDatabase, definitions: ReadonlyArray<IndexedDefinition>): Map<number, SymbolSemanticReference[]>;
  callerMap(db: ScipDatabase, definitions: ReadonlyArray<IndexedDefinition>): Map<number, Set<string>>;
  calleeMap(
    db: ScipDatabase,
    definitions: ReadonlyArray<IndexedDefinition | SymbolMatch>,
  ): Map<number, SymbolSemanticCallee[]>;
}
