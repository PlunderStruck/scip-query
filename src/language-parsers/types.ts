/**
 * Language-parser registry — the seam each per-language adapter plugs into.
 *
 * Adding a language used to mean editing four places: the dispatcher
 * ternary, the source-extension list, the AST-language enum, and a new
 * parseXImportsAst sibling function. The registry collapses all of that
 * into "register one adapter that owns its extensions, AST, and regex
 * fallback in one place."
 *
 * The adapter shape is intentionally minimal — each language exposes
 * `parseImports` (always) and optionally `parseExports`. Both receive the
 * already-loaded source string so the dispatcher pays for the disk read
 * exactly once per file regardless of how many adapters might match.
 */
import type { ScipDatabase } from '../db.js';
import type { ParsedSourceExport, ParsedSourceImport } from '../source-analysis.js';

export interface LanguageParser {
  /** Human-readable language name — only used in diagnostics. */
  language: string;

  /** Extensions this adapter owns. Lowercase, with leading dot. */
  extensions: readonly string[];

  /**
   * Returns the file's imports as ParsedSourceImport entries. Each entry's
   * `sourcePath` should be project-relative (or null when unresolvable).
   */
  parseImports(
    db: ScipDatabase,
    importerPath: string,
    source: string,
  ): ParsedSourceImport[];

  /**
   * Returns the file's exports. Optional — most languages don't have a
   * distinct re-export construct that the consumer needs to read.
   */
  parseExports?(
    db: ScipDatabase,
    importerPath: string,
    source: string,
  ): ParsedSourceExport[];
}

/**
 * Returns the parser whose extensions claim the path, or null when no
 * adapter matches. Lowercase-comparison on extension only.
 */
export function selectParser(
  parsers: ReadonlyArray<LanguageParser>,
  relativePath: string,
): LanguageParser | null {
  const lower = relativePath.toLowerCase();
  for (const parser of parsers) {
    for (const ext of parser.extensions) {
      if (lower.endsWith(ext)) return parser;
    }
  }
  return null;
}
