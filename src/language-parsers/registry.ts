/**
 * Language-parser registry — wires each per-language adapter to its
 * extensions and exposes a single dispatcher.
 *
 * For now most adapters thunk into the parser functions still living in
 * source-analysis.ts; the indirection is the seam. Per-language files
 * (`./rust.ts`, `./python.ts`, etc.) can move parser code out one
 * language at a time without editing this file's clients.
 */
import {
  parseCLikeImports,
  parseDartExports,
  parseDartImports,
  parseDotNetImports,
  parseJavaScriptImports,
  parseJvmImports,
  parsePhpImports,
  parsePythonImports,
  parseRubyImports,
  parseRustExports,
  parseRustImports,
} from '../source-analysis.js';
import type { LanguageParser } from './types.js';
import { selectParser } from './types.js';

const javascript: LanguageParser = {
  language: 'javascript',
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue'],
  parseImports: parseJavaScriptImports,
};

const python: LanguageParser = {
  language: 'python',
  extensions: ['.py', '.pyi'],
  parseImports: parsePythonImports,
};

const jvm: LanguageParser = {
  language: 'jvm',
  extensions: ['.java', '.scala', '.kt', '.kts'],
  parseImports: parseJvmImports,
};

const rust: LanguageParser = {
  language: 'rust',
  extensions: ['.rs'],
  parseImports: parseRustImports,
  parseExports: parseRustExports,
};

const ruby: LanguageParser = {
  language: 'ruby',
  extensions: ['.rb'],
  parseImports: parseRubyImports,
};

const cLike: LanguageParser = {
  language: 'c/cpp',
  extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'],
  parseImports: parseCLikeImports,
};

const dotnet: LanguageParser = {
  language: 'dotnet',
  extensions: ['.cs', '.vb'],
  parseImports: parseDotNetImports,
};

const dart: LanguageParser = {
  language: 'dart',
  extensions: ['.dart'],
  parseImports: parseDartImports,
  parseExports: parseDartExports,
};

const php: LanguageParser = {
  language: 'php',
  extensions: ['.php'],
  parseImports: parsePhpImports,
};

const REGISTRY: ReadonlyArray<LanguageParser> = [
  javascript, python, jvm, rust, ruby, cLike, dotnet, dart, php,
];

export function getParserForPath(relativePath: string): LanguageParser | null {
  return selectParser(REGISTRY, relativePath);
}
