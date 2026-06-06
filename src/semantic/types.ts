import type { IndexedDefinition } from '../domain/types.js';

export interface SemanticAvailability {
  available: boolean;
  reason?: string;
  tsconfigPath?: string;
}

export interface SemanticLocation {
  file: string;
  line: number;
  column: number;
}

export interface SemanticImportUsage {
  importer: string;
  sourcePath: string | null;
  importedName: string;
  localName: string | null;
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
  isTypeOnly: boolean;
  isUsed: boolean;
  isTypeUsed: boolean;
  isValueUsed: boolean;
  references: SemanticLocation[];
}

export interface SemanticReference {
  file: string;
  line: number;
  column: number;
}

export interface SemanticCallee {
  symbol: string;
  file: string;
  line: number;
}

export interface SemanticProvider {
  language: 'typescript';
  availability(): SemanticAvailability;
  importUsage(file: string): SemanticImportUsage[];
  referencesFor(definition: IndexedDefinition): SemanticReference[];
  calleesFor(definition: IndexedDefinition): SemanticCallee[];
  signatureFor(definition: IndexedDefinition): string | null;
}
