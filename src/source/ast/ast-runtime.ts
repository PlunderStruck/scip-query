import { createRequire } from 'node:module';
import { noteFinalizerOwnedNativeAllocation } from '../../domain/native-gc.js';
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
  // Clojure has no tree-sitter grammar wired up (see loadGrammar below); its source
  // facts come from a hand-rolled reader (src/source/clojure-facts.ts,
  // src/language-parsers/languages/clojure.ts) that ships as plain TS/JS with no
  // optional native binding, so it has nothing to probe for — it is always
  // present. Report 'reader' truthfully rather than asserting 'unavailable' for a
  // dependency this language never has.
  if (lang === 'clojure') return 'reader';
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

const NATIVE_GRAMMAR_PACKAGES = new Map<AstLanguage, string>([
  ['rust', 'tree-sitter-rust'],
  ['javascript', 'tree-sitter-javascript'],
  ['python', 'tree-sitter-python'],
  ['java', 'tree-sitter-java'],
  ['kotlin', 'tree-sitter-kotlin'],
  ['scala', 'tree-sitter-scala'],
  ['ruby', 'tree-sitter-ruby'],
  ['c', 'tree-sitter-c'],
  ['cpp', 'tree-sitter-cpp'],
  ['csharp', 'tree-sitter-c-sharp'],
]);

function loadNativeGrammar(lang: AstLanguage): unknown {
  const packageName = NATIVE_GRAMMAR_PACKAGES.get(lang);
  if (packageName) return require(packageName);
  switch (lang) {
    case 'typescript':
      return (require('tree-sitter-typescript') as { typescript: unknown }).typescript;
    case 'tsx':
      return (require('tree-sitter-typescript') as { tsx: unknown }).tsx;
    case 'php':
      return (require('tree-sitter-php') as { php: unknown }).php;
    case 'vb': {
      const module = require('tree-sitter-vb-dotnet') as { language?: unknown };
      return module.language ?? module;
    }
    default:
      return undefined;
  }
}

function loadGrammar(lang: AstLanguage): unknown | null {
  if (failedLanguages.has(lang)) return null;
  const cached = grammarCache.get(lang);
  if (cached) return cached;
  let grammar: unknown;
  try {
    if (lang === 'clojure') {
      failedLanguages.add(lang);
      return null;
    }
    grammar = loadNativeGrammar(lang);
  } catch {
    failedLanguages.add(lang);
    return null;
  }
  grammarCache.set(lang, grammar);
  return grammar;
}

const parserPool = new Map<AstLanguage, ParserInstance>();

export function resetAstRuntimeProbeCache(): void {
  parserCtor = null;
  parserUnavailable = false;
  grammarCache.clear();
  failedLanguages.clear();
  parserPool.clear();
  queryCache.clear();
}

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
/**
 * Measured on TypeScript sources: a node-tree-sitter tree holds about 23x the
 * bytes of the source it was parsed from (3,000 files, 21 MB of source, 493 MB
 * of resident trees). Estimating at 10x let dead trees reach several
 * gigabytes between collections.
 */
const NATIVE_TREE_BYTES_PER_SOURCE_BYTE = 24;

export function parseAstSource(lang: AstLanguage, source: string): Tree | null {
  const parser = getParser(lang);
  if (!parser) return null;
  try {
    const tree = parseSource(parser, source);
    // A parsed tree's memory is native and freed only by its GC finalizer;
    // V8 never sees it, so whole-project sweeps must create collection
    // pressure themselves or dead trees accumulate to gigabytes of RSS.
    noteFinalizerOwnedNativeAllocation(source.length * NATIVE_TREE_BYTES_PER_SOURCE_BYTE);
    return tree;
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
