import { readRepositoryTextFile } from '../../source/primitives/repository-text.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import { existsSync } from 'node:fs';
import { SymbolRole } from '@c4312/scip';
import type { IndexedDefinition } from '../../domain/types.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import type { ScipDatabase } from '../../storage/db.js';
import { readScipArtifact } from '../../storage/scip-artifact.js';
import { getAllDefinitions } from '../definition-catalog.js';
import {
  chunkOccurrenceTargetsForFile,
  normalizeOccurrenceRange,
  sameOccurrenceRange,
  type OccurrenceSourceRange,
  indexStoresOccurrenceData,
  type FileOccurrenceTargets,
} from './scip-chunk-occurrences.js';

export interface ScipOccurrenceCallTarget {
  sourceLine: number;
  calleeLeaf: string;
  definition: IndexedDefinition;
}

export interface ScipOccurrenceDefinitionTarget {
  sourceLine: number;
  sourceRange?: OccurrenceSourceRange;
  definition: IndexedDefinition;
}

export interface ScipOccurrenceCallTargetsResult {
  available: boolean;
  targets: ScipOccurrenceCallTarget[];
  resolvedCallsites: number;
  unresolvedCallsites: number;
}

export interface ScipOccurrenceCallableReferencesResult {
  available: boolean;
  targets: ScipOccurrenceCallTarget[];
}

type IndexedOccurrenceCallTarget = ScipOccurrenceDefinitionTarget;

interface ScipOccurrenceCallTargetIndex {
  byFile: Map<string, IndexedOccurrenceCallTarget[]>;
  externalByFile: Map<string, OccurrenceSourceRange[]>;
}

const SCIP_OCCURRENCE_CALL_TARGET_INDEX = new WeakMap<ScipDatabase, ScipOccurrenceCallTargetIndex | null>();

/**
 * Compiler-resolved occurrence targets for one indexed file. The per-chunk
 * occurrence blobs in the SQLite index are the primary source; the whole
 * SCIP artifact is deserialized only for an index whose chunks carry no
 * occurrence data. Null means no occurrence evidence exists for the file.
 */
export function scipOccurrenceTargetsForFile(db: ScipDatabase, relativePath: string): FileOccurrenceTargets | null {
  if (readRepositoryTextFile(db, relativePath)?.freshness.semantic.state === 'stale') return null;
  const chunkLookup = chunkOccurrenceTargetsForFile(db, relativePath);
  if (chunkLookup.available) {
    return {
      targets: chunkLookup.targets,
      externalLeafKeys: chunkLookup.externalLeafKeys,
      externalRanges: chunkLookup.externalRanges,
      locals: chunkLookup.locals,
    };
  }
  if (chunkLookup.reason === 'no-document') return null;
  // An index that stores occurrence data never justifies deserializing the
  // whole artifact; a file whose blobs failed to decode simply has no
  // occurrence evidence. The artifact path exists for occurrence-less indexes.
  if (indexStoresOccurrenceData(db)) return { targets: [], externalLeafKeys: new Set(), locals: [] };
  const index = scipOccurrenceCallTargetIndex(db);
  if (!index) return null;
  return {
    targets: index.byFile.get(relativePath) ?? [],
    externalLeafKeys: new Set(),
    externalRanges: index.externalByFile.get(relativePath) ?? [],
    locals: [],
  };
}

/**
 * Recover compiler-resolved callees for a source range that has no callable
 * symbol of its own. A target is admitted only when the source parser and the
 * SCIP occurrence identify the same callee token range; unmatched calls
 * remain explicit coverage gaps.
 */
export function scipOccurrenceCallTargetsForRange(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): ScipOccurrenceCallTargetsResult {
  const facts = getSourceFacts(db, relativePath);
  const callsites = (facts?.callSites ?? []).filter((site) => site.line >= startLine && site.line <= endLine);
  if (!facts || callsites.length === 0) {
    return { available: Boolean(facts), targets: [], resolvedCallsites: 0, unresolvedCallsites: 0 };
  }

  const fileTargets = scipOccurrenceTargetsForFile(db, relativePath);
  if (!fileTargets) {
    return { available: false, targets: [], resolvedCallsites: 0, unresolvedCallsites: callsites.length };
  }
  const targets: ScipOccurrenceCallTarget[] = [];
  let resolvedCallsites = 0;
  for (const site of callsites) {
    const matches = fileTargets.targets.filter((target) => sameOccurrenceRange(target.sourceRange, site.targetRange));
    const unique = new Map(matches.map((target) => [target.definition.symbol, target]));
    if (unique.size !== 1) continue;
    const match = [...unique.values()][0]!;
    resolvedCallsites++;
    targets.push({ ...match, sourceLine: site.line, calleeLeaf: match.definition.leaf });
  }
  return {
    available: true,
    targets,
    resolvedCallsites,
    unresolvedCallsites: callsites.length - resolvedCallsites,
  };
}

/** Return compiler-resolved repository definitions referenced by one exact source range. */
export function scipOccurrenceDefinitionTargetsForRange(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): { available: boolean; targets: ScipOccurrenceDefinitionTarget[] } {
  const fileTargets = scipOccurrenceTargetsForFile(db, relativePath);
  if (!fileTargets) return { available: false, targets: [] };
  return {
    available: true,
    targets: fileTargets.targets.filter((target) => target.sourceLine >= startLine && target.sourceLine <= endLine),
  };
}

/**
 * Return every compiler-resolved reference to a callable definition in a
 * source range. Unlike {@link scipOccurrenceCallTargetsForRange}, this view
 * deliberately includes function values passed to higher-order operations,
 * registry entries, and other non-call references. Callers that also request
 * direct calls should deduplicate them by exact line-and-symbol identity.
 */
export function scipOccurrenceCallableReferencesForRange(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): ScipOccurrenceCallableReferencesResult {
  const fileTargets = scipOccurrenceTargetsForFile(db, relativePath);
  if (!fileTargets) return { available: false, targets: [] };
  return {
    available: true,
    targets: fileTargets.targets
      .filter(
        (target) =>
          target.sourceLine >= startLine &&
          target.sourceLine <= endLine &&
          scipDefinitionSourceConfirmsCallable(db, target.definition),
      )
      .map((target): ScipOccurrenceCallTarget => ({ ...target, calleeLeaf: target.definition.leaf })),
  };
}

function scipOccurrenceCallTargetIndex(db: ScipDatabase): ScipOccurrenceCallTargetIndex | null {
  if (SCIP_OCCURRENCE_CALL_TARGET_INDEX.has(db)) return SCIP_OCCURRENCE_CALL_TARGET_INDEX.get(db) ?? null;
  const index = loadScipOccurrenceCallTargetIndex(db);
  SCIP_OCCURRENCE_CALL_TARGET_INDEX.set(db, index);
  return index;
}

function loadScipOccurrenceCallTargetIndex(db: ScipDatabase): ScipOccurrenceCallTargetIndex | null {
  if (!db.generation.indexPath || !existsSync(db.generation.indexPath)) return null;
  try {
    // A direct call target is proven jointly by call syntax at the source
    // token and a SCIP occurrence at that exact token range. It
    // does not need a declaration hover signature, which may degrade to
    // `any` when a function factory's dependencies are unavailable. Bare
    // callable references are filtered separately above because they lack
    // that call-syntax proof.
    const definitions = getAllDefinitions(db);
    const definitionBySymbol = new Map(definitions.map((definition) => [definition.symbol, definition]));
    const scipIndex = readScipArtifact(db.generation.indexPath, 'SCIP source-range call-target index');
    const byFile = new Map<string, IndexedOccurrenceCallTarget[]>();
    const externalByFile = new Map<string, OccurrenceSourceRange[]>();
    for (const document of scipIndex.documents ?? []) {
      const relativePath = document.relativePath;
      if (!relativePath || db.isIgnored(relativePath)) continue;
      const { targets, externalRanges } = decodeScipDocumentTargets(db, relativePath, document, definitionBySymbol);
      byFile.set(relativePath, targets);
      externalByFile.set(relativePath, externalRanges);
    }
    return { byFile, externalByFile };
  } catch {
    return null;
  }
}

/** Artifact fallback excludes definition occurrences; chunk decoding separately retains local binding definitions. */
function decodeScipDocumentTargets(
  db: ScipDatabase,
  relativePath: string,
  document: { positionEncoding: number; occurrences: { symbol: string; symbolRoles: number; range: number[] }[] },
  definitionBySymbol: ReadonlyMap<string, IndexedDefinition>,
): { targets: IndexedOccurrenceCallTarget[]; externalRanges: OccurrenceSourceRange[] } {
  const targets: IndexedOccurrenceCallTarget[] = [];
  const externalRanges: OccurrenceSourceRange[] = [];
  const sourceLines = getSourceLines(db, relativePath);
  const encoding = ({ 1: 'UTF-8', 2: 'UTF-16', 3: 'UTF-32' } as Record<number, string>)[document.positionEncoding];
  for (const occurrence of document.occurrences ?? []) {
    if (!occurrence.symbol || (occurrence.symbolRoles & SymbolRole.Definition) !== 0) continue;
    const definition = definitionBySymbol.get(occurrence.symbol);
    const sourceLine = occurrence.range?.[0];
    if (!Number.isInteger(sourceLine)) continue;
    const sourceRange = normalizeOccurrenceRange(occurrence.range, encoding, sourceLines);
    if (!definition) {
      if (sourceRange) externalRanges.push(sourceRange);
      continue;
    }
    targets.push({ sourceLine, ...(sourceRange ? { sourceRange } : {}), definition });
  }
  return { targets, externalRanges };
}

export function scipDefinitionSourceConfirmsCallable(db: ScipDatabase, definition: IndexedDefinition): boolean {
  if (!definition.isFunctionLike) return false;
  const facts = getSourceFacts(db, definition.relativePath);
  if (!facts) return true;
  if (
    facts.callables.some(
      (callable) =>
        callable.name === definition.leaf &&
        callable.startLine === definition.startLine &&
        callable.endLine === definition.endLine,
    )
  ) {
    return true;
  }
  return compilerDocumentationConfirmsCallable(definition);
}

function compilerDocumentationConfirmsCallable(definition: IndexedDefinition): boolean {
  const documentation = definition.documentation;
  if (!documentation) return false;
  const leaf = definition.leaf.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return (
    new RegExp(`\\bfunction\\s+${leaf}\\s*(?:<[^>]*>)?\\s*\\(`, 'u').test(documentation) ||
    new RegExp(`\\b(?:const|let|var)\\s+${leaf}\\s*:\\s*(?:<[^>]*>\\s*)?\\([^\\n]*\\)\\s*=>`, 'u').test(documentation)
  );
}
