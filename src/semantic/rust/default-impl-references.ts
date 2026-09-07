import { escapeRegex } from '../../source/primitives/regex-utils.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { isMissingProjectFileError, readProjectFileText } from '../../platform/project-files.js';
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

// scip-query: ignore-wrapper — bulk Default-reference resolution shares one
// source-text cache across definitions and is the batch counterpart to the
// public per-definition resolver.
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

// scip-query: ignore-extract — reviewed E1 workflow owner; trait resolution and default-implementation reference policy stay together.
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
  const policy = { owner, ownerDefaultCall, ownerLiteralBeforeBrace, canUseStructUpdateDefault };
  const references: SemanticReference[] = [];
  for (const chunk of chunks) {
    const source = sourceText(db, chunk.relative_path, sourceTextCache);
    if (source === null) return null;
    const found = rustDefaultChunkReferences(chunk, source, policy);
    if (found === null) return null;
    for (const reference of found) references.push(reference);
  }
  return dedupeSemanticReferences(references);
}

interface RustDefaultReferencePolicy {
  owner: string;
  ownerDefaultCall: RegExp;
  ownerLiteralBeforeBrace: RegExp;
  canUseStructUpdateDefault: boolean;
}

interface RustOwnerLiteralScope {
  braceDepth: number;
  ownerLiteralDepths: number[];
}

function rustDefaultChunkReferences(
  chunk: ReturnType<typeof mentionReferenceChunkRows>[number],
  source: string,
  policy: RustDefaultReferencePolicy,
): SemanticReference[] | null {
  const lines = source.split(/\r?\n/);
  const scope: RustOwnerLiteralScope = { braceDepth: 0, ownerLiteralDepths: [] };
  const references: SemanticReference[] = [];
  for (
    let lineNumber = chunk.chunk_start;
    lineNumber <= chunk.chunk_end && lineNumber < lines.length;
    lineNumber += 1
  ) {
    const line = lines[lineNumber] ?? '';
    for (const reference of explicitOwnerDefaultReferences(chunk.relative_path, lineNumber, line, policy)) {
      references.push(reference);
    }
    const structReferences = structUpdateDefaultReferences(chunk.relative_path, lineNumber, line, policy, scope);
    for (const reference of structReferences) references.push(reference);
    const attributedColumns = new Set(structReferences.map((reference) => reference.column!));
    if (hasUnattributedDefaultTraitCall(line, attributedColumns)) return null;
  }
  return references.length === 0 ? null : references;
}

function explicitOwnerDefaultReferences(
  file: string,
  line: number,
  codeLine: string,
  { owner, ownerDefaultCall }: RustDefaultReferencePolicy,
): SemanticReference[] {
  const references: SemanticReference[] = [];
  ownerDefaultCall.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ownerDefaultCall.exec(codeLine))) {
    references.push({ file, line, column: match.index + match[1]!.length + owner.length + '::'.length });
  }
  return references;
}

function structUpdateDefaultReferences(
  file: string,
  line: number,
  codeLine: string,
  policy: RustDefaultReferencePolicy,
  scope: RustOwnerLiteralScope,
): SemanticReference[] {
  const references: SemanticReference[] = [];
  for (let column = 0; column < codeLine.length; column += 1) {
    const structUpdateDefault = STRUCT_UPDATE_DEFAULT_CALL.exec(codeLine.slice(column));
    if (structUpdateDefault) {
      if (policy.canUseStructUpdateDefault && scope.ownerLiteralDepths.includes(scope.braceDepth)) {
        references.push({ file, line, column: column + structUpdateDefault[0].lastIndexOf('default') });
      }
      column += structUpdateDefault[0].length - 1;
      continue;
    }
    trackRustOwnerLiteralScope(codeLine, column, policy.ownerLiteralBeforeBrace, scope);
  }
  return references;
}

function trackRustOwnerLiteralScope(
  codeLine: string,
  column: number,
  ownerLiteralBeforeBrace: RegExp,
  scope: RustOwnerLiteralScope,
): void {
  const char = codeLine[column];
  if (char === '{') {
    const opensOwnerLiteral = ownerLiteralBeforeBrace.test(codeLine.slice(0, column));
    scope.braceDepth += 1;
    if (opensOwnerLiteral) scope.ownerLiteralDepths.push(scope.braceDepth);
    return;
  }
  if (char === '}') {
    scope.braceDepth = Math.max(0, scope.braceDepth - 1);
    while (
      scope.ownerLiteralDepths.length > 0 &&
      scope.ownerLiteralDepths[scope.ownerLiteralDepths.length - 1]! > scope.braceDepth
    ) {
      scope.ownerLiteralDepths.pop();
    }
  }
}

function hasUnattributedDefaultTraitCall(codeLine: string, attributedColumns: ReadonlySet<number>): boolean {
  DEFAULT_TRAIT_CALL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DEFAULT_TRAIT_CALL.exec(codeLine))) {
    if (!attributedColumns.has(match.index + 'Default::'.length)) return true;
  }
  return false;
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
  try {
    return readProjectFileText(db.config.projectRoot, relativePath, {
      inputKind: 'indexed Rust source file',
    });
  } catch (error) {
    if (!isMissingProjectFileError(error)) throw error;
    return null;
  }
}
