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
  /**
   * `file-closure` when a compiler project could not be loaded whole: per-file
   * answers stay exact, project-wide answers (references, hierarchies) are
   * unavailable.
   */
  projectScope?: 'project' | 'file-closure';
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
  /** `jsx-render` when the compiler resolved a rendered component element rather than a call. */
  kind?: 'jsx-render';
}

/**
 * How completely the compiler could account for one definition's call and
 * render sites. A definition with no unresolved site has a complete callee
 * oracle: every call either landed on an indexed definition or on a symbol
 * outside the repository.
 */
export interface SemanticCalleeCoverage {
  callSites: number;
  resolvedInRepository: number;
  resolvedExternal: number;
  unresolved: number;
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
  /** Per-definition accounting of call sites the compiler resolved, resolved externally, or could not resolve. */
  calleeCoverageForDefinitions?(definitions: readonly IndexedDefinition[]): Map<number, SemanticCalleeCoverage>;
  signatureFor(definition: IndexedDefinition): string | null;
}
