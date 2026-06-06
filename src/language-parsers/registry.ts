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
import { parseJavaScriptImports } from './javascript.js';
import { parseJvmImports } from './jvm.js';
import { parsePhpImports } from './php.js';
import { parsePythonImports } from './python.js';
import { parseRubyImports } from './ruby.js';
import { parseRustExports, parseRustImports } from './rust.js';
import type { LanguageParser } from './types.js';
import { selectParser } from './types.js';

const javascript = {
  language: 'javascript',
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue'],
  parseImports: parseJavaScriptImports,
} satisfies LanguageParser;

const python = {
  language: 'python',
  extensions: ['.py', '.pyi'],
  parseImports: parsePythonImports,
} satisfies LanguageParser;

const jvm = {
  language: 'jvm',
  extensions: ['.java', '.scala', '.kt', '.kts'],
  parseImports: parseJvmImports,
} satisfies LanguageParser;

const rust = {
  language: 'rust',
  extensions: ['.rs'],
  parseImports: parseRustImports,
  parseExports: parseRustExports,
} satisfies LanguageParser;

const ruby = {
  language: 'ruby',
  extensions: ['.rb'],
  parseImports: parseRubyImports,
} satisfies LanguageParser;

const cLike = {
  language: 'c/cpp',
  extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'],
  parseImports: parseCLikeImports,
} satisfies LanguageParser;

const dotnet = {
  language: 'dotnet',
  extensions: ['.cs', '.vb'],
  parseImports: parseDotNetImports,
} satisfies LanguageParser;

const dart = {
  language: 'dart',
  extensions: ['.dart'],
  parseImports: parseDartImports,
  parseExports: parseDartExports,
} satisfies LanguageParser;

const php = {
  language: 'php',
  extensions: ['.php'],
  parseImports: parsePhpImports,
} satisfies LanguageParser;

const REGISTRY: ReadonlyArray<LanguageParser> = [
  javascript, python, jvm, rust, ruby, cLike, dotnet, dart, php,
];

// scip-query: ignore-wrapper — public face of the registry; hides REGISTRY +
// the selectParser function from index.ts so the barrel only knows the
// "given a path, get a parser" abstraction.
export function getParserForPath(relativePath: string): LanguageParser | null {
  return selectParser(REGISTRY, relativePath);
}
