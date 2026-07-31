/**
 * Tree-sitter AST cache for fast, accurate source parsing.
 *
 * Each per-language parser in `src/language-parsers/*.ts` calls `getAst`
 * to walk a source file's syntax tree; regex fallback paths only run when
 * the AST is unavailable.
 */
import type { ScipDatabase } from '../../storage/db.js';
import { createPerDbSourceCache } from '../../storage/per-db-cache.js';
import { detectAstLanguage, isVueSfcPath, type AstLanguage } from './ast-language.js';
import { parseAstSource } from './ast-runtime.js';
import type { Tree } from './ast-types.js';
import { getSourceText } from '../primitives/source-text.js';
import { extractVueScriptBlock } from './vue-script.js';

const TREE_CACHE = createPerDbSourceCache<Tree | null>('ast-trees', {
  clearGroups: ['whole-project', 'source-file'],
});

/**
 * Parse a file with tree-sitter and cache the result. Returns null when the
 * language has no AST parser configured.
 *
 * Vue SFCs are special-cased: there's no working tree-sitter-vue binding
 * compatible with our tree-sitter runtime, so we extract the `<script>` or
 * `<script setup>` block and parse it with TypeScript/JavaScript.
 */
// scip-query: ignore-extract — this is the AST entrypoint: language detection,
// Vue SFC handling, parser selection, and source parsing are one parse policy.
export function getAst(db: ScipDatabase, relativePath: string): Tree | null {
  if (isVueSfcPath(relativePath)) {
    return getVueScriptAst(db, relativePath);
  }
  const lang = detectAstLanguage(relativePath);
  if (!lang) return null;

  const source = getSourceText(db, relativePath);
  if (!source) return null;

  return TREE_CACHE.get(db, relativePath, source, () => {
    return parseAstSource(lang, source);
  });
}

/**
 * Parse caller-supplied bytes under the same language and Vue policy as the
 * live-file AST path. Change-relative analyzers use this boundary so a parser
 * cannot silently substitute the current worktree for a fixed Git-base blob.
 */
export function parseAstSourceText(
  db: ScipDatabase,
  relativePath: string,
  source: string,
): { tree: Tree; language: AstLanguage } | null {
  if (isVueSfcPath(relativePath)) {
    const block = extractVueScriptBlock(db, relativePath, source);
    if (!block) return null;
    const tree = parseAstSource(block.language, '\n'.repeat(block.startLine) + block.body);
    return tree ? { tree, language: block.language } : null;
  }
  const language = detectAstLanguage(relativePath);
  if (!language) return null;
  const tree = parseAstSource(language, source);
  return tree ? { tree, language } : null;
}

/**
 * Extract the `<script>` block from a Vue SFC and parse it with the AST
 * grammar implied by `lang=`. The returned Tree's node positions are
 * SFC-relative because the extracted script is left-padded with newlines.
 */
// scip-query: ignore-extract — this parses the script-bearing part of a Vue
// SFC; block extraction, language selection, and parser dispatch are one rule.
function getVueScriptAst(db: ScipDatabase, relativePath: string): Tree | null {
  const source = getSourceText(db, relativePath);
  if (!source) return null;

  return TREE_CACHE.get(db, relativePath, source, () => {
    const block = extractVueScriptBlock(db, relativePath, source);
    if (!block) return null;
    const padded = '\n'.repeat(block.startLine) + block.body;
    return parseAstSource(block.language, padded);
  });
}
