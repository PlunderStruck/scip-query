import type { ScipDatabase } from '../db.js';
import type { ByKindResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';

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
export function byKind(
  db: ScipDatabase,
  kindQuery: string,
  opts: { scope?: string; limit?: number } = {},
): ByKindResult[] {
  const { scope, limit = 100 } = opts;

  // Resolve kind: accept number or name
  let kindNum: number | null = null;
  const asNum = parseInt(kindQuery, 10);
  if (!isNaN(asNum)) {
    kindNum = asNum;
  } else {
    kindNum = KIND_BY_NAME.get(kindQuery.toLowerCase()) ?? null;
    // Fuzzy match: try partial name
    if (kindNum === null) {
      for (const [name, num] of KIND_BY_NAME) {
        if (name.includes(kindQuery.toLowerCase())) {
          kindNum = num;
          break;
        }
      }
    }
  }

  if (kindNum === null) {
    return [];
  }

  const scopeFilter = scope ? `AND d.relative_path LIKE '%${scope}%'` : '';

  // Check if the index actually has kind data populated
  const hasKinds = db.get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM global_symbols WHERE kind IS NOT NULL`,
  );
  if (!hasKinds || hasKinds.c === 0) {
    return []; // Indexer doesn't populate kind field
  }

  const rows = db.all<{
    symbol: string;
    kind: number;
    relative_path: string;
    start_line: number;
    end_line: number;
  }>(
    `SELECT gs.symbol, gs.kind, d.relative_path, der.start_line, der.end_line
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE gs.kind = ?
      ${db.pathExclusionsFor('d')}
      ${scopeFilter}
    ORDER BY d.relative_path, der.start_line
    LIMIT ?`,
    kindNum, limit,
  );

  return rows
    .filter((r) => !db.isIgnored(r.relative_path))
    .map((r) => ({
      symbol: r.symbol,
      shortName: shortenSymbol(r.symbol),
      kind: r.kind,
      kindName: KIND_NAMES[r.kind] ?? 'Unknown',
      relativePath: r.relative_path,
      startLine: r.start_line,
      endLine: r.end_line,
    }));
}

/** List all symbol kinds present in the index with counts */
export function kindCounts(
  db: ScipDatabase,
  opts: { scope?: string } = {},
): Array<{ kind: number; kindName: string; count: number }> {
  const scopeFilter = opts.scope
    ? `AND d.relative_path LIKE '%${opts.scope}%'`
    : '';

  const rows = db.all<{ kind: number; cnt: number }>(
    `SELECT gs.kind, COUNT(*) AS cnt
    FROM global_symbols gs
    JOIN defn_enclosing_ranges der ON gs.id = der.symbol_id
    JOIN documents d ON der.document_id = d.id
    WHERE 1 = 1
      ${db.pathExclusionsFor('d')}
      AND gs.kind IS NOT NULL
      AND gs.kind != 0
      ${scopeFilter}
    GROUP BY gs.kind
    ORDER BY cnt DESC`,
  );

  return rows.map((r) => ({
    kind: r.kind,
    kindName: KIND_NAMES[r.kind] ?? 'Unknown',
    count: r.cnt,
  }));
}
