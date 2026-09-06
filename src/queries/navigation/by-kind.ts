import type { ScipDatabase } from '../../storage/db.js';
import { getAllDefinitions } from '../../symbols/definition-catalog.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { leafSuffix, parseSymbol, shortenSymbol } from '../../symbols/symbol-parser.js';
import { SymbolInformation_Kind } from '@c4312/scip';
import { SCIP_KIND_BY_NAME, SCIP_KIND_NAMES, scipKindName } from '../../symbols/symbol-kind.js';

export interface ByKindResult {
  symbol: string;
  shortName: string;
  kind: number;
  kindName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
}

/**
 * Find symbols by SCIP kind (class, interface, enum, function, etc.)
 */
function resolveKindQuery(kindQuery: string): number | null {
  const query = kindQuery.trim().toLowerCase();
  if (!query) return null;
  if (/^\d+$/.test(query)) {
    const kind = Number(query);
    return SCIP_KIND_NAMES.has(kind) ? kind : null;
  }
  const exact = SCIP_KIND_BY_NAME.get(query);
  if (exact !== undefined) return exact;
  const matches = [...SCIP_KIND_NAMES].filter(([, name]) => name.toLowerCase().includes(query));
  return matches.length === 1 ? matches[0]![0] : null;
}

// scip-query: ignore-extract — the cluster the extract heuristic finds
// (Array.slice + loadKindRows + PathFilter.filter) is just the trailing
// fluent chain of the filter pipeline, not an extractable unit.
export function byKind(
  db: ScipDatabase,
  kindQuery: string,
  opts: { scope?: string; limit?: number } = {},
): ByKindResult[] {
  const { scope, limit = 100 } = opts;

  const kindNum = resolveKindQuery(kindQuery);
  if (kindNum === null) {
    throw new Error(
      `Unknown or ambiguous symbol kind: ${JSON.stringify(kindQuery)}. Use an exact SCIP kind name or number.`,
    );
  }

  const rows = loadKindRows(db, scope)
    .map((row) => ({
      row,
      resolvedKind: resolveKindNumber(row),
    }))
    .filter((entry) => entry.resolvedKind === kindNum)
    .slice(0, limit);

  return rows.map(({ row, resolvedKind }) => ({
    symbol: row.symbol,
    shortName: shortenSymbol(row.symbol),
    kind: resolvedKind!,
    kindName: scipKindName(resolvedKind!),
    relativePath: row.relative_path,
    startLine: row.start_line,
    endLine: row.end_line,
  }));
}

/** List all symbol kinds present in the index with counts */
// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
export function kindCounts(
  db: ScipDatabase,
  opts: { scope?: string } = {},
): Array<{ kind: number; kindName: string; count: number }> {
  const counts = new Map<number, number>();

  for (const row of loadKindRows(db, opts.scope)) {
    const kind = resolveKindNumber(row);
    if (kind === null || kind === 0) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([kind, count]) => ({
      kind,
      kindName: scipKindName(kind),
      count,
    }));
}

interface KindRow {
  symbol: string;
  kind: number | null;
  documentation: string | null;
  enclosing_symbol: string | null;
  relative_path: string;
  start_line: number;
  end_line: number;
}

function loadKindRows(db: ScipDatabase, scope?: string): KindRow[] {
  return getAllDefinitions(db, { scope }).map(mapDefinitionToKindRow);
}

function mapDefinitionToKindRow(definition: IndexedDefinition): KindRow {
  return {
    symbol: definition.symbol,
    kind: definition.kind,
    documentation: definition.documentation,
    enclosing_symbol: definition.enclosingSymbol,
    relative_path: definition.relativePath,
    start_line: definition.startLine,
    end_line: definition.endLine,
  };
}

function resolveKindNumber(
  row: Pick<KindRow, 'symbol' | 'kind' | 'documentation' | 'enclosing_symbol'>,
): number | null {
  if (row.kind !== null && row.kind !== 0) {
    return normalizeIndexedKind(row.kind, row.symbol, row.documentation);
  }
  return inferKindNumber(row.symbol, row.documentation, row.enclosing_symbol);
}

function normalizeIndexedKind(kind: number, symbol: string, documentation: string | null): number {
  const signature = (documentation ?? '').toLowerCase();
  const suffix = leafSuffix(symbol);

  if (suffix === 'type') {
    if (signature.includes('type ')) return SymbolInformation_Kind.TypeAlias;
    if (signature.includes('interface ')) return SymbolInformation_Kind.Interface;
    if (signature.includes('struct ')) return SymbolInformation_Kind.Struct;
    if (signature.includes('trait ')) return SymbolInformation_Kind.Trait;
    if (signature.includes('class ')) return SymbolInformation_Kind.Class;
  }

  return kind;
}

function inferKindNumber(symbol: string, documentation: string | null, enclosingSymbol: string | null): number | null {
  const parsed = parseSymbol(symbol);
  if ('kind' in parsed) {
    return null;
  }

  const descriptors = parsed.descriptors;
  const parent = descriptors[descriptors.length - 2] ?? null;
  const suffix = leafSuffix(symbol);
  const signature = (documentation ?? '').toLowerCase();
  if (suffix === 'type') {
    if (signature.includes('type ')) return SymbolInformation_Kind.TypeAlias;
    if (signature.includes('interface ')) return SymbolInformation_Kind.Interface;
    if (signature.includes('struct ')) return SymbolInformation_Kind.Struct;
    if (signature.includes('trait ')) return SymbolInformation_Kind.Trait;
    if (signature.includes('class ')) return SymbolInformation_Kind.Class;
    return SymbolInformation_Kind.Class; // Class fallback when the index does not expose richer type metadata
  }
  if (suffix === 'method') {
    return parent?.suffix === 'type' ? SymbolInformation_Kind.Method : SymbolInformation_Kind.Function;
  }
  if (suffix === 'namespace') return SymbolInformation_Kind.Module;
  if (suffix !== 'term') return null;

  if (signature.includes('async def ') || signature.includes('def ')) {
    return SymbolInformation_Kind.Function;
  }

  const enclosingSuffix = enclosingSymbol ? leafSuffix(enclosingSymbol) : (parent?.suffix ?? null);
  if (enclosingSuffix === 'type') {
    return SymbolInformation_Kind.Field;
  }

  return SymbolInformation_Kind.Variable;
}
