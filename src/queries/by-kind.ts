import type { ScipDatabase } from '../db.js';
import type { ByKindResult } from '../types.js';
import { getAllDefinitions } from '../definition-catalog.js';
import type { IndexedDefinition } from '../types.js';
import { leafSuffix, parseSymbol, shortenSymbol } from '../symbol-parser.js';

/**
 * SCIP SymbolInformation.Kind enum values.
 * From: https://github.com/sourcegraph/scip/blob/main/scip.proto
 */
const KIND_NAMES: Record<number, string> = {
  0: 'UnspecifiedKind',
  1: 'AbstractMethod',
  2: 'Accessor',
  3: 'Array',
  4: 'Assertion',
  5: 'AssociatedType',
  6: 'Attribute',
  7: 'Axiom',
  8: 'Boolean',
  9: 'Class',
  10: 'Constant',
  11: 'Constructor',
  12: 'Contract',
  13: 'DataFamily',
  14: 'DefinitionMacro',
  15: 'Delegate',
  16: 'Enum',
  17: 'EnumMember',
  18: 'Error',
  19: 'Event',
  20: 'Fact',
  21: 'Field',
  22: 'File',
  23: 'Function',
  24: 'Getter',
  25: 'Grammar',
  26: 'Instance',
  27: 'Interface',
  28: 'Key',
  29: 'Lang',
  30: 'Lemma',
  31: 'Library',
  32: 'Macro',
  33: 'Method',
  34: 'MethodAlias',
  35: 'MethodReceiver',
  36: 'MethodSpecification',
  37: 'Message',
  38: 'Modifier',
  39: 'Module',
  40: 'Namespace',
  41: 'Null',
  42: 'Number',
  43: 'Object',
  44: 'Operator',
  45: 'Package',
  46: 'PackageObject',
  47: 'Parameter',
  48: 'ParameterLabel',
  49: 'Pattern',
  50: 'Predicate',
  51: 'Property',
  52: 'Protocol',
  53: 'ProtocolMethod',
  54: 'PureVirtualMethod',
  55: 'Quasiquoter',
  56: 'SelfParameter',
  57: 'Setter',
  58: 'Signature',
  59: 'SingletonClass',
  60: 'SingletonMethod',
  61: 'StaticDataMember',
  62: 'StaticEvent',
  63: 'StaticField',
  64: 'StaticMethod',
  65: 'StaticProperty',
  66: 'StaticVariable',
  67: 'String',
  68: 'Struct',
  69: 'Subscript',
  70: 'Tactic',
  71: 'Theorem',
  72: 'ThisParameter',
  73: 'Trait',
  74: 'TraitMethod',
  75: 'Type',
  76: 'TypeAlias',
  77: 'TypeClass',
  78: 'TypeClassMethod',
  79: 'TypeFamily',
  80: 'TypeParameter',
  81: 'Union',
  82: 'Value',
  83: 'Variable',
};

/** Reverse lookup: name -> kind number */
const KIND_BY_NAME = new Map<string, number>();
for (const [k, v] of Object.entries(KIND_NAMES)) {
  KIND_BY_NAME.set(v.toLowerCase(), Number(k));
}

/**
 * Find symbols by SCIP kind (class, interface, enum, function, etc.)
 */
function resolveKindQuery(kindQuery: string): number | null {
  const asNum = parseInt(kindQuery, 10);
  if (!isNaN(asNum)) return asNum;

  const lower = kindQuery.toLowerCase();
  const exact = KIND_BY_NAME.get(lower);
  if (exact !== undefined) return exact;

  for (const [name, num] of KIND_BY_NAME) {
    if (name.includes(lower)) return num;
  }
  return null;
}

export function byKind(
  db: ScipDatabase,
  kindQuery: string,
  opts: { scope?: string; limit?: number } = {},
): ByKindResult[] {
  const { scope, limit = 100 } = opts;

  const kindNum = resolveKindQuery(kindQuery);
  if (kindNum === null) {
    return [];
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
    kindName: KIND_NAMES[resolvedKind!] ?? 'Unknown',
    relativePath: row.relative_path,
    startLine: row.start_line,
    endLine: row.end_line,
  }));
}

/** List all symbol kinds present in the index with counts */
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
      kindName: KIND_NAMES[kind] ?? 'Unknown',
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

function loadKindRows(
  db: ScipDatabase,
  scope?: string,
): KindRow[] {
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

function resolveKindNumber(row: Pick<KindRow, 'symbol' | 'kind' | 'documentation' | 'enclosing_symbol'>): number | null {
  if (row.kind !== null && row.kind !== 0) {
    return normalizeIndexedKind(row.kind, row.symbol, row.documentation);
  }
  return inferKindNumber(row.symbol, row.documentation, row.enclosing_symbol);
}

function normalizeIndexedKind(
  kind: number,
  symbol: string,
  documentation: string | null,
): number {
  const signature = (documentation ?? '').toLowerCase();
  const suffix = leafSuffix(symbol);

  if (suffix === 'type') {
    if (signature.includes('type ')) return 76;
    if (signature.includes('interface ')) return 27;
    if (signature.includes('struct ')) return 68;
    if (signature.includes('trait ')) return 73;
    if (signature.includes('class ')) return 9;
  }

  return kind;
}

function inferKindNumber(
  symbol: string,
  documentation: string | null,
  enclosingSymbol: string | null,
): number | null {
  const parsed = parseSymbol(symbol);
  if ('kind' in parsed) {
    return null;
  }

  const descriptors = parsed.descriptors;
  const parent = descriptors[descriptors.length - 2] ?? null;
  const suffix = leafSuffix(symbol);
  const signature = (documentation ?? '').toLowerCase();
  if (suffix === 'type') {
    if (signature.includes('type ')) return 76;
    if (signature.includes('interface ')) return 27;
    if (signature.includes('struct ')) return 68;
    if (signature.includes('trait ')) return 73;
    if (signature.includes('class ')) return 9;
    return 9; // Class fallback when the index does not expose richer type metadata
  }
  if (suffix === 'method') {
    return parent?.suffix === 'type' ? 33 : 23;
  }
  if (suffix === 'namespace') return 39; // Module
  if (suffix !== 'term') return null;

  if (signature.includes('async def ') || signature.includes('def ')) {
    return 23; // Function
  }

  const enclosingSuffix = enclosingSymbol ? leafSuffix(enclosingSymbol) : (parent?.suffix ?? null);
  if (enclosingSuffix === 'type') {
    return 21; // Field
  }

  return 83; // Variable / term fallback
}
