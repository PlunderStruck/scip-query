import { existsSync } from 'node:fs';
import { deserializeSCIP, SymbolRole } from '@c4312/scip';
import type { IndexedDefinition } from '../../domain/types.js';
import { profileSpan } from '../../instrumentation/profile.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import { getAllDefinitions } from '../../symbols/definition-catalog.js';
import { isRustTraitImplMember } from '../../symbols/symbol-parser.js';
import type { SemanticCallee } from '../types.js';
import { readFileWithinLimit, SCIP_ARTIFACT_MAX_BYTES } from '../../platform/bounded-file.js';

interface RustScipOccurrenceCalleeIndex {
  occurrencesByFile: Map<string, RustScipOccurrenceCallee[]>;
}

interface RustScipOccurrenceCallee {
  line: number;
  leaf: string;
  traitImplMember: boolean;
  callee: SemanticCallee;
}

interface SourceCallSite {
  line: number;
  calleeLeaf: string;
}

const SCIP_OCCURRENCE_CALLEE_INDEX = new WeakMap<ScipDatabase, RustScipOccurrenceCalleeIndex | null>();

export function rustScipOccurrenceCalleeMap(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
): Map<number, SemanticCallee[]> {
  const candidates = definitions.filter(canUseRustScipOccurrenceCallees);
  if (candidates.length === 0) return new Map();

  let indexAvailable = false;
  let resolvedDefinitions = 0;
  let resolvedCallees = 0;
  return profileSpan(
    'rust.scip-occurrence.callees',
    () => {
      const index = scipOccurrenceCalleeIndex(db);
      indexAvailable = Boolean(index);
      if (!index) return new Map();

      const result = new Map<number, SemanticCallee[]>();
      for (const definition of candidates) {
        const callees = rustScipOccurrenceCalleesForDefinitionFromIndex(db, index, definition);
        if (callees === null) continue;
        result.set(definition.symbolId, callees);
        resolvedDefinitions += 1;
        resolvedCallees += callees.length;
      }
      return result;
    },
    () => ({
      definitions: definitions.length,
      candidates: candidates.length,
      indexAvailable,
      resolvedDefinitions,
      resolvedCallees,
    }),
  );
}

export function canUseRustScipOccurrenceCallees(definition: IndexedDefinition): boolean {
  if (!definition.symbol.startsWith('rust-analyzer ')) return false;
  if (!definition.relativePath.endsWith('.rs')) return false;
  if (!definition.isFunctionLike) return false;
  if (definition.leaf === 'main') return false;
  if (isRustTraitImplMember(definition.symbol)) return false;
  return true;
}

function rustScipOccurrenceCalleesForDefinitionFromIndex(
  db: ScipDatabase,
  index: RustScipOccurrenceCalleeIndex,
  definition: IndexedDefinition,
): SemanticCallee[] | null {
  const facts = getSourceFacts(db, definition.relativePath);
  if (!facts || facts.language !== 'rust') return null;
  const callable = facts.callables.find((entry) => {
    if (entry.startLine !== definition.startLine || entry.endLine !== definition.endLine) return false;
    return (
      entry.name === definition.leaf || definition.leaf.endsWith(entry.name) || entry.name.endsWith(definition.leaf)
    );
  });
  if (!callable) return null;

  const callSites = facts.callSites.filter((site) => site.line >= callable.startLine && site.line <= callable.endLine);
  if (callSites.length === 0) return null;

  const occurrences = (index.occurrencesByFile.get(definition.relativePath) ?? []).filter(
    (occurrence) =>
      occurrence.line >= callable.startLine &&
      occurrence.line <= callable.endLine &&
      occurrence.callee.symbol !== definition.symbol,
  );
  if (occurrences.some((occurrence) => occurrence.traitImplMember)) return null;
  if (!sameLineLeafMultiset(callSites, occurrences)) return null;

  const rows: SemanticCallee[] = [];
  const seen = new Set<string>();
  for (const occurrence of occurrences) {
    const key = `${occurrence.callee.symbol}\0${occurrence.callee.file}\0${occurrence.callee.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(occurrence.callee);
  }
  return rows;
}

function sameLineLeafMultiset(
  callSites: readonly SourceCallSite[],
  occurrences: readonly RustScipOccurrenceCallee[],
): boolean {
  const source = lineLeafCounts(callSites);
  const indexed = lineLeafCounts(occurrences);
  if (source.size !== indexed.size) return false;
  for (const [key, count] of source) {
    if (indexed.get(key) !== count) return false;
  }
  return true;
}

function lineLeafCounts(
  items: ReadonlyArray<{ line: number; calleeLeaf?: string; leaf?: string }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const leaf = item.calleeLeaf ?? item.leaf;
    if (!leaf) continue;
    const key = `${item.line}\0${leaf}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function scipOccurrenceCalleeIndex(db: ScipDatabase): RustScipOccurrenceCalleeIndex | null {
  if (SCIP_OCCURRENCE_CALLEE_INDEX.has(db)) return SCIP_OCCURRENCE_CALLEE_INDEX.get(db) ?? null;
  const index = loadScipOccurrenceCalleeIndex(db);
  SCIP_OCCURRENCE_CALLEE_INDEX.set(db, index);
  return index;
}

function loadScipOccurrenceCalleeIndex(db: ScipDatabase): RustScipOccurrenceCalleeIndex | null {
  if (!db.generation.indexPath || !existsSync(db.generation.indexPath)) return null;
  try {
    const callableDefinitions = getAllDefinitions(db).filter(
      (definition) =>
        definition.symbol.startsWith('rust-analyzer ') &&
        definition.relativePath.endsWith('.rs') &&
        definition.isFunctionLike,
    );
    const definitionBySymbol = new Map(callableDefinitions.map((definition) => [definition.symbol, definition]));
    const scipIndex = deserializeSCIP(
      readFileWithinLimit(db.generation.indexPath, {
        inputKind: 'SCIP occurrence-callee index',
        maxBytes: SCIP_ARTIFACT_MAX_BYTES,
      }),
    );
    const occurrencesByFile = new Map<string, RustScipOccurrenceCallee[]>();
    for (const document of scipIndex.documents ?? []) {
      const relativePath = document.relativePath;
      if (!relativePath || !relativePath.endsWith('.rs') || db.isIgnored(relativePath)) continue;
      const rows: RustScipOccurrenceCallee[] = [];
      for (const occurrence of document.occurrences ?? []) {
        if (!occurrence.symbol || (occurrence.symbolRoles & SymbolRole.Definition) !== 0) continue;
        const calleeDefinition = definitionBySymbol.get(occurrence.symbol);
        if (!calleeDefinition) continue;
        const line = occurrence.range?.[0];
        if (!Number.isInteger(line)) continue;
        rows.push({
          line,
          leaf: calleeDefinition.leaf,
          traitImplMember: isRustTraitImplMember(calleeDefinition.symbol),
          callee: {
            symbol: calleeDefinition.symbol,
            file: calleeDefinition.relativePath,
            line: calleeDefinition.startLine,
            callsiteLine: line,
          },
        });
      }
      occurrencesByFile.set(relativePath, rows);
    }
    return { occurrencesByFile };
  } catch {
    return null;
  }
}
