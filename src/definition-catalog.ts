/**
 * definition-catalog — per-file and per-project definition records, with
 * AST-corrected ranges.
 *
 * Where to get what:
 *   - `getDefinitionsForFile(db, relativePath)` — every definition in a
 *     file, ranges corrected via tree-sitter when supported (Rust, TS/JS,
 *     Python) or via regex fallback otherwise.
 *   - `getAllDefinitions(db)` / `getScopedDefinitions(db, scope)` — every
 *     definition across the project (or matching a scope substring).
 *   - `loadFileSymbols(db, pathOrPattern, opts)` — projection helper used
 *     by `symbols`, `system`, and `outline`. Adds shortName/signature.
 *   - `findEnclosingDefinition(definitions, line)` — smallest containing
 *     definition; used to attribute reference lines to their owner.
 *
 * Do NOT read `defn_enclosing_ranges.start_line/end_line` directly. The
 * AST correction here is the only thing that handles cases where the
 * SCIP indexer's chunk range is wider than the actual function body
 * (Rust file-wide chunks, callable signatures inside larger blocks).
 *
 * Layer position: built on path-resolver and symbol-lookup. Used by
 * reference-graph and many query commands.
 */
import type { ScipDatabase } from './db.js';
import { getCallableSites, type CallableSite } from './ast.js';
import { getSourceText } from './source-analysis.js';
import { isFunctionLikeSymbol, leafName, leafSuffix, parseSymbol, shortenSymbol } from './symbol-parser.js';
import { createPerDbCache } from './per-db-cache.js';
import { resolveIndexedPaths } from './path-resolver.js';
import { cleanSignature, extractSignature, type SymbolQueryRow } from './symbol-lookup.js';
import type { IndexedDefinition } from './types.js';

export const FILE_DEFINITION_CACHE = createPerDbCache<string, IndexedDefinition[]>('file-definitions');

export interface FileSymbolResult {
  startLine: number;
  endLine: number;
  symbol: string;
  shortName: string;
  signature: string | null;
  relativePath: string;
  enclosingSymbol: string | null;
}

export function getDefinitionsForFile(
  db: ScipDatabase,
  relativePath: string,
): IndexedDefinition[] {
  return FILE_DEFINITION_CACHE.get(db, relativePath, () => {
    const primary = db.all<SymbolQueryRow>(
      `SELECT
        gs.id,
        gs.symbol,
        der.document_id,
        der.start_line,
        der.end_line,
        d.relative_path,
        gs.display_name,
        gs.kind,
        gs.documentation,
        gs.enclosing_symbol
       FROM global_symbols gs
       JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
       JOIN documents d ON der.document_id = d.id
       WHERE d.relative_path = ?
         ${db.symbolNoiseFor('gs')}
       ORDER BY der.start_line, der.end_line`,
      relativePath,
    );

    const fallback = primary.length > 0 ? [] : db.all<SymbolQueryRow>(
      `SELECT
        gs.id,
        gs.symbol,
        c.document_id,
        MIN(c.start_line) AS start_line,
        MAX(c.end_line) AS end_line,
        d.relative_path,
        gs.display_name,
        gs.kind,
        gs.documentation,
        gs.enclosing_symbol
       FROM global_symbols gs
       JOIN mentions m ON m.symbol_id = gs.id
       JOIN chunks c ON m.chunk_id = c.id
       JOIN documents d ON c.document_id = d.id
       WHERE d.relative_path = ?
         AND m.role = 1
         ${db.symbolNoiseFor('gs')}
       GROUP BY gs.id, gs.symbol, c.document_id, d.relative_path
       ORDER BY start_line, end_line`,
      relativePath,
    );

    return correctDefinitionRangesFromSource(
      db,
      relativePath,
      (primary.length > 0 ? primary : fallback).map((row) => ({
        symbolId: row.id,
        symbol: row.symbol,
        documentId: row.document_id,
        startLine: row.start_line,
        endLine: row.end_line,
        relativePath: row.relative_path,
        leaf: leafName(row.symbol),
        parentTypeName: parentTypeName(row.symbol),
        isFunctionLike: isFunctionLikeSymbol(row.symbol),
        isTypeLike: leafSuffix(row.symbol) === 'type',
        kind: row.kind ?? null,
        documentation: row.documentation ?? null,
        enclosingSymbol: row.enclosing_symbol ?? null,
      })),
    );
  });
}

export function getAllDefinitions(
  db: ScipDatabase,
  opts: { scope?: string } = {},
): IndexedDefinition[] {
  return getScopedDefinitions(db, opts.scope);
}

export function getScopedDefinitions(
  db: ScipDatabase,
  scope?: string,
): IndexedDefinition[] {
  const scopeFilter = scope ? `AND relative_path LIKE '%${scope}%'` : '';

  return db.all<{ relative_path: string }>(
    `SELECT relative_path
     FROM documents
     WHERE 1 = 1
       ${db.pathExclusionsFor('documents')}
       ${scopeFilter}
     ORDER BY relative_path`,
  )
    .flatMap((row) => getDefinitionsForFile(db, row.relative_path))
    .filter((row) => !db.isIgnored(row.relativePath));
}

/**
 * Project a set of file paths (or a file pattern) into the symbol-list shape
 * shared by `symbols`, `system`, and `outline`. Encapsulates the read →
 * filter ignored → optionally drop undocumented → optionally sort →
 * project pipeline that those three queries used to inline (which made
 * them register as similar-callee pairs).
 */
export function loadFileSymbols(
  db: ScipDatabase,
  filePatternOrPaths: string | string[],
  opts: { onlyDocumented?: boolean; sort?: boolean } = {},
): FileSymbolResult[] {
  const paths = typeof filePatternOrPaths === 'string'
    ? resolveIndexedPaths(db, filePatternOrPaths)
    : filePatternOrPaths;
  if (paths.length === 0) return [];

  let definitions = paths
    .flatMap((relativePath) => getDefinitionsForFile(db, relativePath))
    .filter((row) => !db.isIgnored(row.relativePath));

  if (opts.onlyDocumented) {
    definitions = definitions.filter((d) => d.documentation !== null && d.documentation !== '');
  }
  if (opts.sort) {
    definitions = definitions.sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath)
      || a.startLine - b.startLine
      || a.endLine - b.endLine,
    );
  }

  return definitions.map((d) => ({
    startLine: d.startLine,
    endLine: d.endLine,
    symbol: d.symbol,
    shortName: shortenSymbol(d.symbol),
    signature: cleanSignature(extractSignature(d.documentation)),
    relativePath: d.relativePath,
    enclosingSymbol: d.enclosingSymbol,
  }));
}

export function findEnclosingDefinition(
  definitions: IndexedDefinition[],
  line: number,
): IndexedDefinition | null {
  let best: IndexedDefinition | null = null;

  for (const definition of definitions) {
    if (definition.startLine > line || definition.endLine < line) continue;
    if (!best || (definition.endLine - definition.startLine) < (best.endLine - best.startLine)) {
      best = definition;
    }
  }

  return best;
}

// ── AST / regex range correction ─────────────────────────────────

export function correctDefinitionRangesFromSource(
  db: ScipDatabase,
  relativePath: string,
  definitions: IndexedDefinition[],
): IndexedDefinition[] {
  // Tree-sitter path: gives both startLine and endLine in one shot from the
  // parsed AST, so no brace-counting or regex sweeps are needed. This is the
  // primary path for Rust / TS / JS / Python.
  const callables = getCallableSites(db, relativePath);
  if (callables) {
    return correctDefinitionRangesFromAst(definitions, callables);
  }

  // Regex fallback for languages without tree-sitter support.
  const source = getSourceText(db, relativePath);
  if (!source) {
    return definitions;
  }

  const lines = source.split(/\r?\n/);

  const declarationLines = definitions.some((d) => isCallableDefinition(d.symbol))
    ? buildDeclarationCandidatesMap(lines)
    : null;

  const correctedStarts = new Map<number, number>();
  for (const definition of definitions) {
    correctedStarts.set(
      definition.symbolId,
      resolveCallableDefinitionStartLine(lines, declarationLines, definition),
    );
  }

  const correctedRanges = new Map<number, { startLine: number; endLine: number }>();
  const callableDefinitions = definitions
    .filter((definition) => isCallableDefinition(definition.symbol))
    .map((definition) => ({
      definition,
      startLine: correctedStarts.get(definition.symbolId) ?? definition.startLine,
    }))
    .sort((left, right) =>
      left.startLine - right.startLine
      || left.definition.startLine - right.definition.startLine
      || left.definition.symbol.localeCompare(right.definition.symbol),
    );

  for (let index = 0; index < callableDefinitions.length; index += 1) {
    const current = callableDefinitions[index]!;
    const next = callableDefinitions[index + 1];
    const maxEndLine = next
      ? Math.max(current.startLine, next.startLine - 1)
      : lines.length - 1;

    correctedRanges.set(current.definition.symbolId, {
      startLine: current.startLine,
      endLine: resolveCallableDefinitionEndLine(
        lines,
        current.definition,
        current.startLine,
        maxEndLine,
      ),
    });
  }

  return definitions.map((definition) => {
    const corrected = correctedRanges.get(definition.symbolId);
    if (!corrected) {
      return definition;
    }

    return {
      ...definition,
      startLine: corrected.startLine,
      endLine: corrected.endLine,
    };
  });
}

/**
 * Match each callable definition against tree-sitter callable sites by leaf
 * name; pick the AST site whose startLine is nearest to the SCIP-reported
 * startLine. Non-callable definitions (types, constants) pass through with
 * their original chunk-level ranges since the AST query targets functions.
 */
export function correctDefinitionRangesFromAst(
  definitions: IndexedDefinition[],
  callables: ReadonlyArray<CallableSite>,
): IndexedDefinition[] {
  const sitesByName = new Map<string, CallableSite[]>();
  for (const site of callables) {
    const arr = sitesByName.get(site.name);
    if (arr) arr.push(site);
    else sitesByName.set(site.name, [site]);
  }

  return definitions.map((def) => {
    if (!isCallableDefinition(def.symbol) || !def.leaf) return def;
    const sites = sitesByName.get(def.leaf);
    if (!sites || sites.length === 0) return def;

    let best = sites[0]!;
    let bestDistance = Math.abs(best.startLine - def.startLine);
    for (let i = 1; i < sites.length; i += 1) {
      const site = sites[i]!;
      const distance = Math.abs(site.startLine - def.startLine);
      if (distance < bestDistance) {
        best = site;
        bestDistance = distance;
      }
    }

    return { ...def, startLine: best.startLine, endLine: best.endLine };
  });
}

export function resolveCallableDefinitionStartLine(
  lines: string[],
  declarationLines: DeclarationCandidatesMap | null,
  definition: IndexedDefinition,
): number {
  if (!isCallableDefinition(definition.symbol)) {
    return definition.startLine;
  }
  const fallback = Math.max(0, Math.min(definition.startLine, lines.length - 1));
  if (!declarationLines) return fallback;

  const candidates = declarationLines.get(definition.leaf);
  if (!candidates || candidates.length === 0) return fallback;

  // Original semantics: prefer the declaration line nearest the chunk-reported
  // startLine. Strong and fallback patterns shared the same nearest-wins pick,
  // so we merge them into one candidate list per name.
  let best: { line: number; distance: number } | null = null;
  for (const line of candidates) {
    const distance = Math.abs(line - definition.startLine);
    if (!best || distance < best.distance) {
      best = { line, distance };
    }
  }
  return best?.line ?? fallback;
}

type DeclarationCandidatesMap = Map<string, number[]>;

/**
 * Single pass through the file's lines: for each line, run name-CAPTURING
 * variants of the same declaration patterns the per-definition resolver
 * used. Build `name → sorted candidate line numbers`.
 *
 * Patterns are kept identical in shape to the original strong + fallback
 * patterns — only the literal `\b{name}\b` is swapped for `\b(\w+)\b` so
 * we can capture instead of testing.
 */
export function buildDeclarationCandidatesMap(lines: string[]): DeclarationCandidatesMap {
  const namedFunction = /\b(?:function|def|fn)\s+([A-Za-z_$][\w$]*)/g;
  const assignedFunction = /\b([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function\b|\()/g;
  const methodDeclaration = /^\s*(?:(?:export|public|private|protected|static|readonly|async|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^(]*>)?\s*\(/;
  const callShape = /\b([A-Za-z_$][\w$]*)\s*\(/g;

  const map: DeclarationCandidatesMap = new Map();
  const record = (name: string, line: number): void => {
    const arr = map.get(name);
    if (!arr) {
      map.set(name, [line]);
      return;
    }
    if (arr[arr.length - 1] !== line) arr.push(line);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    for (const match of line.matchAll(namedFunction)) {
      if (match[1]) record(match[1], i);
    }
    for (const match of line.matchAll(assignedFunction)) {
      if (match[1]) record(match[1], i);
    }
    const methodMatch = line.match(methodDeclaration);
    if (methodMatch?.[1]) record(methodMatch[1], i);
    for (const match of line.matchAll(callShape)) {
      if (match[1]) record(match[1], i);
    }
  }

  return map;
}

export function resolveCallableDefinitionEndLine(
  lines: string[],
  definition: IndexedDefinition,
  startLine: number,
  maxEndLine: number,
): number {
  const boundedEndLine = Math.max(startLine, Math.min(lines.length - 1, maxEndLine));
  const fallbackEndLine = Math.max(startLine, Math.min(boundedEndLine, definition.endLine));

  let braceDepth = 0;
  let parenDepth = 0;
  let sawOpeningBrace = false;

  for (let lineIndex = startLine; lineIndex <= boundedEndLine; lineIndex += 1) {
    const masked = maskStructuralLine(lines[lineIndex] ?? '');
    for (const char of masked) {
      if (char === '{') {
        braceDepth += 1;
        sawOpeningBrace = true;
      } else if (char === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
      } else if (char === '(') {
        parenDepth += 1;
      } else if (char === ')') {
        parenDepth = Math.max(0, parenDepth - 1);
      }
    }

    if (sawOpeningBrace && braceDepth === 0) {
      return lineIndex;
    }

    if (!sawOpeningBrace && parenDepth === 0 && lineIndex >= fallbackEndLine) {
      return lineIndex;
    }
  }

  return fallbackEndLine;
}

export function maskStructuralLine(line: string): string {
  let masked = '';
  let quote: '"' | '\'' | '`' | null = null;
  let escaping = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    const next = line[index + 1];

    if (!quote && char === '/' && next === '/') {
      masked += ' '.repeat(line.length - index);
      break;
    }

    if (quote) {
      if (escaping) {
        escaping = false;
        masked += ' ';
        continue;
      }

      if (char === '\\') {
        escaping = true;
        masked += ' ';
        continue;
      }

      if (char === quote) {
        quote = null;
      }

      masked += ' ';
      continue;
    }

    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      masked += ' ';
      continue;
    }

    masked += char;
  }

  return masked;
}

export function isCallableDefinition(symbol: string): boolean {
  return symbol.includes('().');
}

export function parentTypeName(rawSymbol: string): string | null {
  const parsed = parseSymbol(rawSymbol);
  if ('kind' in parsed) {
    return null;
  }

  for (let index = parsed.descriptors.length - 2; index >= 0; index--) {
    const descriptor = parsed.descriptors[index];
    if (descriptor?.suffix === 'type') {
      return descriptor.name;
    }
  }

  return null;
}

export function applyLimit<T>(
  values: T[],
  limit?: number,
): T[] {
  return typeof limit === 'number' ? values.slice(0, limit) : values;
}
