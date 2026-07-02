import { createRequire } from 'node:module';
import type { AstLanguage } from './ast-language.js';
import type { QueryInstance, Tree } from './ast-types.js';

const require = createRequire(import.meta.url);

// All grammars are CommonJS native bindings.
type ParserCtor = new () => ParserInstance;
interface ParserInstance {
  setLanguage(lang: unknown): void;
  parse(source: string | ((index: number, position: { row: number; column: number }) => string | null)): Tree;
}
interface QueryConstructor {
  new (lang: unknown, queryString: string): QueryInstance;
}

// `tree-sitter` is an optionalDependency: its native binding can fail to
// install on minimal environments. Cache the failure so callers fall back fast.
let parserCtor: (ParserCtor & { Query: QueryConstructor }) | null = null;
let parserUnavailable = false;

export function getParserCtor(): (ParserCtor & { Query: QueryConstructor }) | null {
  if (parserUnavailable) return null;
  if (parserCtor) return parserCtor;
  try {
    parserCtor = require('tree-sitter') as ParserCtor & { Query: QueryConstructor };
    return parserCtor;
  } catch {
    parserUnavailable = true;
    return null;
  }
}

export type LanguageRuntimeProbe = 'ast' | 'reader' | 'regex' | 'unavailable';

export function probeAstLanguageRuntime(lang: AstLanguage): LanguageRuntimeProbe {
  if (lang === 'clojure') return 'unavailable';
  const Ctor = getParserCtor();
  if (!Ctor) return 'unavailable';
  const grammar = loadGrammar(lang);
  if (!grammar) return 'unavailable';
  try {
    const parser = new Ctor();
    parser.setLanguage(grammar);
    return 'ast';
  } catch {
    failedLanguages.add(lang);
    return 'unavailable';
  }
}

const grammarCache = new Map<AstLanguage, unknown>();
const failedLanguages = new Set<AstLanguage>();

function loadGrammar(lang: AstLanguage): unknown | null {
  if (failedLanguages.has(lang)) return null;
  const cached = grammarCache.get(lang);
  if (cached) return cached;
  let grammar: unknown;
  try {
    switch (lang) {
      case 'rust':
        grammar = require('tree-sitter-rust');
        break;
      case 'typescript':
        grammar = (require('tree-sitter-typescript') as { typescript: unknown }).typescript;
        break;
      case 'tsx':
        grammar = (require('tree-sitter-typescript') as { tsx: unknown }).tsx;
        break;
      case 'javascript':
        grammar = require('tree-sitter-javascript');
        break;
      case 'python':
        grammar = require('tree-sitter-python');
        break;
      case 'java':
        grammar = require('tree-sitter-java');
        break;
      case 'kotlin':
        grammar = require('tree-sitter-kotlin');
        break;
      case 'scala':
        grammar = require('tree-sitter-scala');
        break;
      case 'ruby':
        grammar = require('tree-sitter-ruby');
        break;
      case 'c':
        grammar = require('tree-sitter-c');
        break;
      case 'cpp':
        grammar = require('tree-sitter-cpp');
        break;
      case 'csharp':
        grammar = require('tree-sitter-c-sharp');
        break;
      case 'php':
        grammar = (require('tree-sitter-php') as { php: unknown }).php;
        break;
      case 'vb': {
        const module = require('tree-sitter-vb-dotnet') as { language?: unknown };
        grammar = module.language ?? module;
        break;
      }
      case 'clojure':
        failedLanguages.add(lang);
        return null;
    }
  } catch {
    failedLanguages.add(lang);
    return null;
  }
  grammarCache.set(lang, grammar);
  return grammar;
}

const parserPool = new Map<AstLanguage, ParserInstance>();

function getParser(lang: AstLanguage): ParserInstance | null {
  const cached = parserPool.get(lang);
  if (cached) return cached;
  const grammar = loadGrammar(lang);
  if (!grammar) return null;
  const Ctor = getParserCtor();
  if (!Ctor) return null;
  const parser = new Ctor();
  try {
    parser.setLanguage(grammar);
  } catch {
    failedLanguages.add(lang);
    return null;
  }
  parserPool.set(lang, parser);
  return parser;
}

function parseSource(parser: ParserInstance, source: string): Tree {
  const chunkSize = 16 * 1024;
  return parser.parse((index) =>
    index >= source.length ? null : source.slice(index, Math.min(source.length, index + chunkSize)),
  );
}

// scip-query: ignore-wrapper — public parser-runtime operation consumed by
// the AST facade; it hides parser pooling, optional grammar availability, and
// chunked tree-sitter parsing behind one runtime boundary.
export function parseAstSource(lang: AstLanguage, source: string): Tree | null {
  const parser = getParser(lang);
  if (!parser) return null;
  try {
    return parseSource(parser, source);
  } catch {
    return null;
  }
}

const queryCache = new Map<string, QueryInstance | null>();

/**
 * Compile (and cache) a tree-sitter query for the given language + query text.
 *
 * scip-query: ignore-wrapper — public parser-runtime operation re-exported by
 * the AST facade; callers should not know grammar loading or Query constructor
 * availability policy.
 */
export function compileQuery(lang: AstLanguage, queryString: string): QueryInstance | null {
  const key = `${lang}::${queryString}`;
  if (queryCache.has(key)) return queryCache.get(key) ?? null;
  const grammar = loadGrammar(lang);
  if (!grammar) {
    queryCache.set(key, null);
    return null;
  }
  const Ctor = getParserCtor();
  if (!Ctor) {
    queryCache.set(key, null);
    return null;
  }
  try {
    const compiled = new Ctor.Query(grammar, queryString);
    queryCache.set(key, compiled);
    return compiled;
  } catch {
    queryCache.set(key, null);
    return null;
  }
}
