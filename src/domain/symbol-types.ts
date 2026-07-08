// ── Indexed-symbol Types (shared by path-resolver / symbol-lookup /
//    definition-catalog / symbol evidence modules) ───────────────────

/**
 * A symbol's location in the SCIP index. The minimum data needed to
 * identify a definition: which document it lives in, which lines it
 * spans, and the global symbol id. Used as a lightweight handle when
 * the caller doesn't need the symbol's textual name or path.
 */
export interface SymbolLocation {
  documentId: number;
  startLine: number;
  startChar?: number;
  endLine: number;
  endChar?: number;
  symbolId: number;
}

/**
 * A SymbolLocation plus the human-readable bits: the SCIP symbol string
 * and the document's relative path. Returned by lookup helpers like
 * `findFirstSymbolMatch` so callers don't have to round-trip through the
 * documents table to get a path or symbol name.
 */
export interface SymbolMatch extends SymbolLocation {
  symbol: string;
  relativePath: string;
}

export interface SymbolResolutionCandidate {
  symbol: string;
  shortName: string;
  relativePath: string;
  startLine: number;
}

export interface SymbolResolution {
  match: SymbolMatch | null;
  candidates: SymbolResolutionCandidate[];
  total: number;
}

/**
 * Reference-site of a symbol — where (file + line) the symbol is used,
 * and the smallest enclosing definition at that line (for credit
 * attribution in reverse-index views).
 */
export interface ReferenceSite {
  file: string;
  line: number;
  enclosingSymbol: string | null;
}

/**
 * A full definition record: SymbolMatch plus per-symbol metadata
 * (leaf name, parent type, kind, documentation, enclosing symbol).
 * Used by the catalog APIs (`getDefinitionsForFile`, `getAllDefinitions`,
 * `getScopedDefinitions`) so consumers don't have to re-derive any of
 * these per-record.
 */
export interface IndexedDefinition extends SymbolMatch {
  leaf: string;
  parentTypeName: string | null;
  isFunctionLike: boolean;
  isTypeLike: boolean;
  kind: number | null;
  documentation: string | null;
  enclosingSymbol: string | null;
}

/**
 * Internal scoring shape used by `path-resolver` to rank document path
 * candidates against a user-supplied file pattern. Not part of any
 * public CLI interface.
 */
// scip-query: ignore-stale — exported path-resolution scoring record kept as
// part of the public domain type surface for downstream analysis tools.
export interface DocumentPathCandidate {
  relativePath: string;
  score: number;
}

// ── Source-import / source-export records ─────────────────────────
// Owned here (not in language-parsers/) so any module — query, parser,
// resolver — can reference them without going back through the parser
// registry and re-introducing a cycle.

/**
 * A single import binding parsed out of a source file. Captures both the
 * lexical shape (kind, names, source path) and a usage flag computed from
 * the source's body — `used` is `true` when the imported binding's local
 * name appears anywhere in the file outside the import statement itself.
 *
 * Producers: each per-language parser in `src/language-parsers/*.ts`.
 * Consumers: import-graph queries (`imports`, `drift`, `redundant-reexports`),
 * unused-imports queries, and the import-attribution path inside
 * `identifier-attribution.ts`.
 */
export interface ParsedSourceImport {
  importedName: string;
  localName: string | null;
  sourcePath: string | null;
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
  used: boolean;
  usedMembers: string[];
  isTypeOnly?: boolean;
}

/**
 * A single export-from binding parsed out of a source file. Used by the
 * languages that have an explicit re-export construct (Rust `pub use`,
 * Dart `export`) to surface what a barrel module re-shapes.
 */
export interface ParsedSourceExport {
  sourcePath: string | null;
  specifier: string;
}

/**
 * A re-export statement in a JavaScript/TypeScript source file — one of:
 *   export { X [as Y] } from './path'
 *   export type { X } from './path'
 *   export * from './path'
 *   export * as Ns from './path'
 *
 * The `sourcePath` is the resolved, project-relative path to the re-exported
 * module (same convention as ParsedSourceImport.sourcePath).
 */
export interface ParsedReExport {
  kind: 'named' | 'star' | 'star-as';
  sourcePath: string | null;
  /** For 'named': the list of re-exported identifiers as they appear in THIS file. */
  names: string[];
  /** Start line in the source (0-indexed) — inclusive. */
  startLine: number;
  /** End line in the source (0-indexed) — inclusive. */
  endLine: number;
}

// ── SCIP Symbol Grammar Types ──────────────────────────────

/** Parsed components of a SCIP symbol string */
// scip-query: ignore-stale — exported SCIP grammar record returned by
// parseSymbol; callers use it to inspect parsed global symbol identity.
export interface ScipSymbol {
  /** The indexer scheme (e.g. "scip-typescript", "scip-java", "rust-analyzer") */
  scheme: string;
  /** Package manager (e.g. "npm", "maven", "cargo") */
  manager: string;
  /** Package name (e.g. "@vega/api", "com.example/mylib") */
  packageName: string;
  /** Package version */
  version: string;
  /** Descriptor chain — the path to the symbol within the file */
  descriptors: ScipDescriptor[];
  /** The raw, unparsed symbol string */
  raw: string;
}

export interface ScipDescriptor {
  name: string;
  suffix: DescriptorSuffix;
}

export type DescriptorSuffix =
  | 'namespace' // /
  | 'type' // #
  | 'term' // .
  | 'method' // ().
  | 'type-param' // [
  | 'parameter' // ()
  | 'meta' // :
  | 'macro'; // !

/** A local symbol (file-scoped, no cross-file identity) */
// scip-query: ignore-stale — exported SCIP grammar record returned by
// parseSymbol for file-local symbols.
export interface ScipLocalSymbol {
  kind: 'local';
  id: string;
  raw: string;
}
