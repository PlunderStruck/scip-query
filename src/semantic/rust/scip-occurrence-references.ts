import { existsSync } from 'node:fs';
import { deserializeSCIP, SymbolRole } from '@c4312/scip';
import type { IndexedDefinition, ScipSymbol } from '../../domain/types.js';
import type { ScipDatabase } from '../../storage/db.js';
import type { SemanticReference } from '../types.js';
import { dedupeSemanticReferences } from './reference-mapping.js';
import { isRustTraitImplMember, leafSuffix, parseSymbol } from '../../symbols/symbol-parser.js';
import { readFileWithinLimit, SCIP_ARTIFACT_MAX_BYTES } from '../../platform/bounded-file.js';

interface ScipOccurrenceReferenceIndex {
  referencesBySymbol: Map<string, SemanticReference[]>;
}

export type RustScipOccurrenceReferenceMode = 'safe' | 'all';

const SCIP_OCCURRENCE_REFERENCE_INDEX = new WeakMap<ScipDatabase, ScipOccurrenceReferenceIndex | null>();
const RUST_SCIP_OCCURRENCE_REFERENCE_MODE_ENV = 'SCIP_RUST_SCIP_OCCURRENCE_REFERENCE_MODE';

export function rustScipOccurrenceReferenceMap(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
): Map<number, SemanticReference[]> {
  const result = new Map<number, SemanticReference[]>();
  const mode = rustScipOccurrenceReferenceMode();
  const candidates = definitions.filter((definition) => canUseRustScipOccurrenceReferences(definition, mode));
  if (candidates.length === 0) return result;

  const index = scipOccurrenceReferenceIndex(db);
  if (!index) return result;

  for (const definition of candidates) {
    const references = rustScipOccurrenceReferencesForDefinitionFromIndex(index, definition);
    if (references !== null) result.set(definition.symbolId, references);
  }
  return result;
}

// scip-query: ignore-wrapper — public targeted lookup used independently by
// accuracy tests and semantic fallback composition.
export function rustScipOccurrenceReferencesForDefinition(
  db: ScipDatabase,
  definition: IndexedDefinition,
): SemanticReference[] | null {
  if (!canUseRustScipOccurrenceReferences(definition, rustScipOccurrenceReferenceMode())) return null;
  const index = scipOccurrenceReferenceIndex(db);
  if (!index) return null;
  return rustScipOccurrenceReferencesForDefinitionFromIndex(index, definition);
}

function rustScipOccurrenceReferencesForDefinitionFromIndex(
  index: ScipOccurrenceReferenceIndex,
  definition: IndexedDefinition,
): SemanticReference[] | null {
  return index.referencesBySymbol.get(definition.symbol) ?? [];
}

export function canUseRustScipOccurrenceReferences(
  definition: IndexedDefinition,
  mode: RustScipOccurrenceReferenceMode = 'safe',
): boolean {
  if (!definition.symbol.startsWith('rust-analyzer ')) return false;
  if (!definition.relativePath.endsWith('.rs')) return false;
  if (isRustTraitImplMember(definition.symbol)) return false;
  if (/impl#\[[^\]]+\]\[Default\]default\(\)\.$/.test(definition.symbol)) return false;
  if (mode === 'all') return true;

  const suffix = leafSuffix(definition.symbol);
  if (suffix === 'method') return true;
  if (suffix !== 'term') return false;

  const parsed = parseSymbol(definition.symbol);
  if ('kind' in parsed) return false;
  return !hasEnclosingTypeDescriptor(parsed);
}

function hasEnclosingTypeDescriptor(parsed: ScipSymbol): boolean {
  for (let index = 0; index < parsed.descriptors.length - 1; index += 1) {
    if (parsed.descriptors[index]?.suffix === 'type') return true;
  }
  return false;
}

function scipOccurrenceReferenceIndex(db: ScipDatabase): ScipOccurrenceReferenceIndex | null {
  if (SCIP_OCCURRENCE_REFERENCE_INDEX.has(db)) return SCIP_OCCURRENCE_REFERENCE_INDEX.get(db) ?? null;
  const index = loadScipOccurrenceReferenceIndex(db);
  SCIP_OCCURRENCE_REFERENCE_INDEX.set(db, index);
  return index;
}

function loadScipOccurrenceReferenceIndex(db: ScipDatabase): ScipOccurrenceReferenceIndex | null {
  if (!db.generation.indexPath || !existsSync(db.generation.indexPath)) return null;
  try {
    const scipIndex = deserializeSCIP(
      readFileWithinLimit(db.generation.indexPath, {
        inputKind: 'SCIP occurrence-reference index',
        maxBytes: SCIP_ARTIFACT_MAX_BYTES,
      }),
    );
    const referencesBySymbol = new Map<string, SemanticReference[]>();
    for (const document of scipIndex.documents ?? []) {
      const relativePath = document.relativePath;
      if (!relativePath || db.isIgnored(relativePath)) continue;
      for (const occurrence of document.occurrences ?? []) {
        if (!occurrence.symbol || (occurrence.symbolRoles & SymbolRole.Definition) !== 0) continue;
        const reference = referenceFromOccurrence(relativePath, occurrence.range);
        if (!reference) continue;
        const bucket = referencesBySymbol.get(occurrence.symbol) ?? [];
        bucket.push(reference);
        referencesBySymbol.set(occurrence.symbol, bucket);
      }
    }
    for (const [symbol, references] of referencesBySymbol) {
      referencesBySymbol.set(symbol, dedupeSemanticReferences(references));
    }
    return { referencesBySymbol };
  } catch {
    return null;
  }
}

function referenceFromOccurrence(relativePath: string, range: readonly number[]): SemanticReference | null {
  if (range.length < 3) return null;
  const line = range[0];
  const column = range[1];
  if (!Number.isInteger(line) || !Number.isInteger(column)) return null;
  return { file: relativePath, line, column };
}

export function rustScipOccurrenceReferenceMode(): RustScipOccurrenceReferenceMode {
  return process.env[RUST_SCIP_OCCURRENCE_REFERENCE_MODE_ENV] === 'all' ? 'all' : 'safe';
}
