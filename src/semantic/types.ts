import type { IndexedDefinition } from '../domain/types.js';

export type SemanticProviderLanguage = 'typescript' | 'rust';

export type SemanticAvailabilityState = { available: true; reason?: never } | { available: false; reason: string };

export type SemanticAvailability = SemanticAvailabilityState & {
  dependencyAvailable?: boolean;
  tsconfigPath?: string;
  tsconfigPaths?: string[];
  resolvedBinary?: string;
  /** Positive capability detail; failure explanations belong in `reason`. */
  note?: string;
};

export function decodeSemanticAvailability(input: unknown): SemanticAvailability | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    typeof value['available'] !== 'boolean' ||
    (value['dependencyAvailable'] !== undefined && typeof value['dependencyAvailable'] !== 'boolean') ||
    (value['tsconfigPath'] !== undefined && typeof value['tsconfigPath'] !== 'string') ||
    (value['tsconfigPaths'] !== undefined &&
      (!Array.isArray(value['tsconfigPaths']) ||
        !value['tsconfigPaths'].every((path): path is string => typeof path === 'string'))) ||
    (value['resolvedBinary'] !== undefined && typeof value['resolvedBinary'] !== 'string') ||
    (value['note'] !== undefined && typeof value['note'] !== 'string')
  ) {
    return null;
  }
  if (value['available'] === true) {
    if (value['reason'] !== undefined) return null;
  } else if (typeof value['reason'] !== 'string' || value['reason'].length === 0) {
    return null;
  }
  return value as unknown as SemanticAvailability;
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
  /** Zero-based definition line of the resolved target. */
  line: number;
  /** Zero-based source line of the call expression when the provider retains it. */
  callsiteLine?: number;
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
  referencesForDefinitions?(
    definitions: readonly IndexedDefinition[],
    opts?: { exact?: boolean },
  ): Map<number, SemanticReference[]>;
  referenceFragmentsForFiles?(files: readonly string[]): Map<string, SemanticReferenceFragment[]>;
  referencesAndCalleesForDefinitions?(
    referenceDefinitions: readonly IndexedDefinition[],
    calleeDefinitions: readonly IndexedDefinition[],
  ): SemanticReferenceAndCalleeMaps;
  calleesFor(definition: IndexedDefinition): SemanticCallee[];
  calleesForDefinitions?(definitions: readonly IndexedDefinition[]): Map<number, SemanticCallee[]>;
  signatureFor(definition: IndexedDefinition): string | null;
}
