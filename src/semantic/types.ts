import type { IndexedDefinition } from '../domain/types.js';

export type SemanticProviderLanguage = 'typescript' | 'rust';

export interface SemanticAvailability {
  available: boolean;
  dependencyAvailable?: boolean;
  reason?: string;
  tsconfigPath?: string;
  tsconfigPaths?: string[];
  resolvedBinary?: string;
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

export interface SemanticReferenceFragment {
  targetSymbol: string;
  location: SemanticReference;
}

export interface SemanticCallee {
  symbol: string;
  file: string;
  line: number;
}

export interface SemanticReferenceAndCalleeMaps {
  references: Map<number, SemanticReference[]>;
  callees: Map<number, SemanticCallee[]>;
}

export interface SemanticProvider {
  language: SemanticProviderLanguage;
  availability(): SemanticAvailability;
  dispose?(): void;
  importUsage(file: string): SemanticImportUsage[];
  referencesFor(definition: IndexedDefinition): SemanticReference[];
  referencesForDefinitions?(definitions: readonly IndexedDefinition[]): Map<number, SemanticReference[]>;
  referenceFragmentsForFiles?(files: readonly string[]): Map<string, SemanticReferenceFragment[]>;
  referencesAndCalleesForDefinitions?(
    referenceDefinitions: readonly IndexedDefinition[],
    calleeDefinitions: readonly IndexedDefinition[],
  ): SemanticReferenceAndCalleeMaps;
  calleesFor(definition: IndexedDefinition): SemanticCallee[];
  calleesForDefinitions?(definitions: readonly IndexedDefinition[]): Map<number, SemanticCallee[]>;
  signatureFor(definition: IndexedDefinition): string | null;
}
