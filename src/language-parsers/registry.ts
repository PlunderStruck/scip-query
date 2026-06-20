/**
 * Language-parser registry — wires each per-language adapter to its
 * extensions and exposes a single dispatcher.
 *
 * Each per-language file (`./javascript.ts`, `./python.ts`, …) owns its
 * AST + regex fallback. Adding a language = one new file + one entry in
 * the REGISTRY array; the registry has no knowledge of any language's
 * internals.
 */
import { parseCLikeImports } from './languages/c-like.js';
import { parseDartExports, parseDartImports } from './languages/dart.js';
import { parseDotNetImports } from './languages/dotnet.js';
import { parseJavaScriptImports, parseReExports } from './languages/javascript.js';
import { parseJvmImports } from './languages/jvm.js';
import { parsePhpImports } from './languages/php.js';
import { parsePythonImports } from './languages/python.js';
import { parseRubyImports } from './languages/ruby.js';
import { parseRustExports, parseRustImports } from './languages/rust.js';
import {
  C_LIKE_EXTENSIONS,
  DART_EXTENSIONS,
  DOTNET_EXTENSIONS,
  JS_EXTENSIONS,
  JVM_EXTENSIONS,
  PHP_EXTENSIONS,
  PYTHON_EXTENSIONS,
  RUBY_EXTENSIONS,
  RUST_EXTENSIONS,
} from '../resolution/import-path-resolver.js';
import { importOnlyLanguageParser, type LanguageParser } from './types.js';
import { selectParser } from './types.js';

const javascript = {
  language: 'javascript',
  extensions: JS_EXTENSIONS,
  capabilities: {
    imports: 'ast-with-regex-fallback',
    reExports: 'ast-with-regex-fallback',
  },
  parseImports: parseJavaScriptImports,
  parseReExports,
} satisfies LanguageParser;

const python = importOnlyLanguageParser({
  language: 'python',
  extensions: PYTHON_EXTENSIONS,
  imports: 'ast-with-regex-fallback',
  parseImports: parsePythonImports,
});

const jvm = importOnlyLanguageParser({
  language: 'jvm',
  extensions: JVM_EXTENSIONS,
  imports: 'ast-dispatch-with-regex-fallback',
  parseImports: parseJvmImports,
});

const rust = {
  language: 'rust',
  extensions: RUST_EXTENSIONS,
  capabilities: {
    imports: 'ast-with-regex-fallback',
    exports: 'ast-with-regex-fallback',
  },
  parseImports: parseRustImports,
  parseExports: parseRustExports,
} satisfies LanguageParser;

const ruby = importOnlyLanguageParser({
  language: 'ruby',
  extensions: RUBY_EXTENSIONS,
  imports: 'ast-with-regex-fallback',
  parseImports: parseRubyImports,
});

const cLike = importOnlyLanguageParser({
  language: 'c/cpp',
  extensions: C_LIKE_EXTENSIONS,
  imports: 'ast-with-regex-fallback',
  parseImports: parseCLikeImports,
});

const dotnet = importOnlyLanguageParser({
  language: 'dotnet',
  extensions: DOTNET_EXTENSIONS,
  imports: 'ast-dispatch-with-regex-fallback',
  parseImports: parseDotNetImports,
});

const dart = {
  language: 'dart',
  extensions: DART_EXTENSIONS,
  capabilities: {
    imports: 'regex-only',
    exports: 'regex-only',
  },
  parseImports: parseDartImports,
  parseExports: parseDartExports,
} satisfies LanguageParser;

const php = importOnlyLanguageParser({
  language: 'php',
  extensions: PHP_EXTENSIONS,
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
