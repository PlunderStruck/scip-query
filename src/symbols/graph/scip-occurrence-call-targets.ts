import { existsSync } from 'node:fs';
import { SymbolRole } from '@c4312/scip';
import type { IndexedDefinition } from '../../domain/types.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import type { ScipDatabase } from '../../storage/db.js';
import { readScipArtifact } from '../../storage/scip-artifact.js';
import { getAllDefinitions } from '../definition-catalog.js';

export interface ScipOccurrenceCallTarget {
  sourceLine: number;
  calleeLeaf: string;
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

type IndexedOccurrenceCallTarget = ScipOccurrenceCallTarget;

interface ScipOccurrenceCallTargetIndex {
  byFile: Map<string, IndexedOccurrenceCallTarget[]>;
}

const SCIP_OCCURRENCE_CALL_TARGET_INDEX = new WeakMap<ScipDatabase, ScipOccurrenceCallTargetIndex | null>();

/**
 * Recover compiler-resolved callees for a source range that has no callable
 * symbol of its own. A target is admitted only when the source parser and the
 * SCIP occurrence artifact report the same number of calls for that exact
 * line-and-leaf key; unmatched calls remain explicit coverage gaps.
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

  const index = scipOccurrenceCallTargetIndex(db);
  if (!index) {
    return { available: false, targets: [], resolvedCallsites: 0, unresolvedCallsites: callsites.length };
  }
  const occurrences = (index.byFile.get(relativePath) ?? []).filter(
    (target) => target.sourceLine >= startLine && target.sourceLine <= endLine,
  );
  const sourceCounts = lineLeafCounts(callsites.map((site) => ({ line: site.line, leaf: site.calleeLeaf })));
  const occurrenceCounts = lineLeafCounts(
    occurrences.map((occurrence) => ({ line: occurrence.sourceLine, leaf: occurrence.calleeLeaf })),
  );
  const resolvedKeys = new Set(
    [...sourceCounts].flatMap(([key, count]) => (occurrenceCounts.get(key) === count ? [key] : [])),
  );
  const targets = occurrences.filter((occurrence) =>
    resolvedKeys.has(lineLeafKey(occurrence.sourceLine, occurrence.calleeLeaf)),
  );
  const resolvedCallsites = [...resolvedKeys].reduce((total, key) => total + (sourceCounts.get(key) ?? 0), 0);
  return {
    available: true,
    targets,
    resolvedCallsites,
    unresolvedCallsites: Math.max(0, callsites.length - resolvedCallsites),
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
  const index = scipOccurrenceCallTargetIndex(db);
  if (!index) return { available: false, targets: [] };
  return {
    available: true,
    targets: (index.byFile.get(relativePath) ?? []).filter(
      (target) =>
        target.sourceLine >= startLine && target.sourceLine <= endLine && sourceConfirmsCallable(db, target.definition),
    ),
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
    // line and a SCIP occurrence with the same line-and-leaf cardinality. It
    // does not need a declaration hover signature, which may degrade to
    // `any` when a function factory's dependencies are unavailable. Bare
    // callable references are filtered separately above because they lack
    // that call-syntax proof.
    const definitions = getAllDefinitions(db).filter((definition) => definition.isFunctionLike);
    const definitionBySymbol = new Map(definitions.map((definition) => [definition.symbol, definition]));
    const scipIndex = readScipArtifact(db.generation.indexPath, 'SCIP source-range call-target index');
    const byFile = new Map<string, IndexedOccurrenceCallTarget[]>();
    for (const document of scipIndex.documents ?? []) {
      const relativePath = document.relativePath;
      if (!relativePath || db.isIgnored(relativePath)) continue;
      const targets: IndexedOccurrenceCallTarget[] = [];
      for (const occurrence of document.occurrences ?? []) {
        if (!occurrence.symbol || (occurrence.symbolRoles & SymbolRole.Definition) !== 0) continue;
        const definition = definitionBySymbol.get(occurrence.symbol);
        const sourceLine = occurrence.range?.[0];
        if (!definition || !Number.isInteger(sourceLine)) continue;
        targets.push({ sourceLine, calleeLeaf: definition.leaf, definition });
      }
      byFile.set(relativePath, targets);
    }
    return { byFile };
  } catch {
    return null;
  }
}

function sourceConfirmsCallable(db: ScipDatabase, definition: IndexedDefinition): boolean {
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

function lineLeafCounts(items: readonly { line: number; leaf: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = lineLeafKey(item.line, item.leaf);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function lineLeafKey(line: number, leaf: string): string {
  return `${line}\0${leaf}`;
}
