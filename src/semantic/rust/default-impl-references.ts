import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { escapeRegex } from '../../core/regex-utils.js';
import type { IndexedDefinition } from '../../domain/types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { mentionReferenceChunkRows } from '../../storage/scip-mentions.js';
import type { SemanticReference } from '../types.js';
import { dedupeSemanticReferences } from './reference-mapping.js';

interface SourceTextCache {
  get(relativePath: string): string | null | undefined;
  has(relativePath: string): boolean;
  set(relativePath: string, source: string | null): void;
}

const RUST_SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TRAIT_CALL = /\bDefault::default\b/g;
const STRUCT_UPDATE_DEFAULT_CALL = /^\.\.\s*Default::default\b/;

export function rustDefaultImplReferenceMap(
  db: ScipDatabase,
  definitions: readonly IndexedDefinition[],
): Map<number, SemanticReference[]> {
  const result = new Map<number, SemanticReference[]>();
  const sourceTextCache = new Map<string, string | null>();
  for (const definition of definitions) {
    const references = rustDefaultImplReferencesForDefinition(db, definition, sourceTextCache);
    if (references !== null) result.set(definition.symbolId, references);
  }
  return result;
}

export function rustDefaultImplReferencesForDefinition(
  db: ScipDatabase,
  definition: IndexedDefinition,
  sourceTextCache: SourceTextCache = new Map<string, string | null>(),
): SemanticReference[] | null {
  const owner = rustDefaultImplOwner(definition.symbol);
  if (!owner) return null;

  const chunks = mentionReferenceChunkRows(db, [definition.symbolId]);
  if (chunks.length === 0) return null;

  const ownerDefaultCall = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(owner)}::default\\b`, 'g');
  const ownerLiteralBeforeBrace = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(owner)}\\s*$`);
  const canUseStructUpdateDefault = hasDefinitionMention(db, definition.symbolId);
  const references: SemanticReference[] = [];
  for (const chunk of chunks) {
    const source = sourceText(db, chunk.relative_path, sourceTextCache);
    if (source === null) return null;

    const lines = source.split(/\r?\n/);
    let braceDepth = 0;
    const ownerLiteralDepths: number[] = [];
    let chunkReferences = 0;
    for (
      let lineNumber = chunk.chunk_start;
      lineNumber <= chunk.chunk_end && lineNumber < lines.length;
      lineNumber += 1
    ) {
      const line = lines[lineNumber] ?? '';
      const codeLine = line;
      const defaultTraitReferenceColumns = new Set<number>();
      ownerDefaultCall.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = ownerDefaultCall.exec(codeLine))) {
        references.push({
          file: chunk.relative_path,
          line: lineNumber,
          column: match.index + match[1]!.length + owner.length + '::'.length,
        });
        chunkReferences += 1;
      }

      for (let column = 0; column < codeLine.length; column += 1) {
        const structUpdateDefault = STRUCT_UPDATE_DEFAULT_CALL.exec(codeLine.slice(column));
        if (structUpdateDefault) {
          if (canUseStructUpdateDefault && ownerLiteralDepths.includes(braceDepth)) {
            const methodColumn = column + structUpdateDefault[0].lastIndexOf('default');
            references.push({
              file: chunk.relative_path,
              line: lineNumber,
              column: methodColumn,
            });
            defaultTraitReferenceColumns.add(methodColumn);
            chunkReferences += 1;
          }
          column += structUpdateDefault[0].length - 1;
          continue;
        }

        const char = codeLine[column];
        if (char === '{') {
          const opensOwnerLiteral = ownerLiteralBeforeBrace.test(codeLine.slice(0, column));
          braceDepth += 1;
          if (opensOwnerLiteral) ownerLiteralDepths.push(braceDepth);
          continue;
        }
        if (char === '}') {
          braceDepth = Math.max(0, braceDepth - 1);
          while (ownerLiteralDepths.length > 0 && ownerLiteralDepths[ownerLiteralDepths.length - 1]! > braceDepth) {
            ownerLiteralDepths.pop();
          }
        }
      }

      DEFAULT_TRAIT_CALL.lastIndex = 0;
      while ((match = DEFAULT_TRAIT_CALL.exec(codeLine))) {
        const methodColumn = match.index + 'Default::'.length;
        if (!defaultTraitReferenceColumns.has(methodColumn)) return null;
      }
    }
    if (chunkReferences === 0) return null;
  }

  return dedupeSemanticReferences(references);
}

function hasDefinitionMention(db: ScipDatabase, symbolId: number): boolean {
  const row = db.get<{ present: 1 }>(
    'SELECT 1 AS present FROM mentions WHERE symbol_id = ? AND role = 1 LIMIT 1',
    symbolId,
  );
  return row?.present === 1;
}

function rustDefaultImplOwner(symbol: string): string | null {
  const owner = /impl#\[([^\]]+)\]\[Default\]default\(\)\./.exec(symbol)?.[1] ?? null;
  if (!owner || !RUST_SIMPLE_IDENTIFIER.test(owner)) return null;
  return owner;
}

function sourceText(db: ScipDatabase, relativePath: string, cache: SourceTextCache): string | null {
  if (cache.has(relativePath)) return cache.get(relativePath) ?? null;
  const row = db.get<{ text: string | null }>('SELECT text FROM documents WHERE relative_path = ?', relativePath);
  const source = typeof row?.text === 'string' ? row.text : sourceTextFromDisk(db, relativePath);
  cache.set(relativePath, source);
  return source;
}

function sourceTextFromDisk(db: ScipDatabase, relativePath: string): string | null {
  const fullPath = resolve(db.config.projectRoot, relativePath);
  if (!existsSync(fullPath)) return null;
  try {
    return readFileSync(fullPath, 'utf8');
  } catch {
    return null;
  }
}
