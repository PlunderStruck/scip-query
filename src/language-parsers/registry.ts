/**
 * Language-parser registry — wires each per-language adapter to its
 * extensions and exposes a single dispatcher.
 *
 * Each per-language file (`./javascript.ts`, `./python.ts`, …) owns its
 * AST + regex fallback. Adding a language = one new file + one entry in
 * the REGISTRY array; the registry has no knowledge of any language's
 * internals.
 */
import { parseCLikeImports } from './c-like.js';
import { parseDartExports, parseDartImports } from './dart.js';
import { parseDotNetImports } from './dotnet.js';
import { parseJavaScriptImports, parseReExports } from './javascript.js';
import { parseJvmImports } from './jvm.js';
import { parsePhpImports } from './php.js';
import { parsePythonImports } from './python.js';
import { parseRubyImports } from './ruby.js';
import { parseRustExports, parseRustImports } from './rust.js';
import { importOnlyLanguageParser, type LanguageParser } from './types.js';
import { selectParser } from './types.js';

const javascript = {
  language: 'javascript',
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue'],
  capabilities: {
    imports: 'ast-with-regex-fallback',
    reExports: 'ast-with-regex-fallback',
  },
  parseImports: parseJavaScriptImports,
  parseReExports,
} satisfies LanguageParser;

const python = importOnlyLanguageParser({
  language: 'python',
  extensions: ['.py', '.pyi'],
  imports: 'ast-with-regex-fallback',
  parseImports: parsePythonImports,
});

const jvm = importOnlyLanguageParser({
  language: 'jvm',
  extensions: ['.java', '.scala', '.kt', '.kts'],
  imports: 'ast-dispatch-with-regex-fallback',
  parseImports: parseJvmImports,
});

const rust = {
  language: 'rust',
  extensions: ['.rs'],
  capabilities: {
    imports: 'ast-with-regex-fallback',
    exports: 'ast-with-regex-fallback',
  },
  parseImports: parseRustImports,
  parseExports: parseRustExports,
} satisfies LanguageParser;

const ruby = importOnlyLanguageParser({
  language: 'ruby',
  extensions: ['.rb'],
  imports: 'ast-with-regex-fallback',
  parseImports: parseRubyImports,
});

const cLike = importOnlyLanguageParser({
  language: 'c/cpp',
  extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'],
  imports: 'ast-with-regex-fallback',
  parseImports: parseCLikeImports,
});

const dotnet = importOnlyLanguageParser({
  language: 'dotnet',
  extensions: ['.cs', '.vb'],
  imports: 'ast-dispatch-with-regex-fallback',
  parseImports: parseDotNetImports,
});

const dart = {
  language: 'dart',
  extensions: ['.dart'],
  capabilities: {
    imports: 'regex-only',
    exports: 'regex-only',
  },
  parseImports: parseDartImports,
  parseExports: parseDartExports,
} satisfies LanguageParser;

const php = importOnlyLanguageParser({
  language: 'php',
  extensions: ['.php'],
  imports: 'ast-with-regex-fallback',
  parseImports: parsePhpImports,
});

const REGISTRY: ReadonlyArray<LanguageParser> = [
  javascript, python, jvm, rust, ruby, cLike, dotnet, dart, php,
];

// scip-query: ignore-wrapper — public face of the registry; hides REGISTRY +
// the selectParser function from index.ts so the barrel only knows the
// "given a path, get a parser" abstraction.
export function getParserForPath(relativePath: string): LanguageParser | null {
  return selectParser(REGISTRY, relativePath);
}
