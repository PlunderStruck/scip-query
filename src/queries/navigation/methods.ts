import { basename } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { ProjectIndex } from '../internal/project-index.js';
import { nearestSymbolNames, resolveSymbol } from '../../symbols/symbol-lookup.js';
import { detectAstLanguage, getSourceFacts } from '../../source/ast.js';
import { isCallableSymbol, isDirectChildSymbol, leafName, shortenSymbol } from '../../symbols/symbol-parser.js';
import type { SymbolMatch, SymbolResolutionCandidate } from '../../domain/types.js';

export interface MethodResult {
  startLine: number;
  endLine: number;
  name: string;
}

export interface ResolveMethodsOptions {
  className: string;
}

export interface MethodsOwner {
  symbol: string;
  shortName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
}

export type MethodsResolution =
  | {
      kind: 'matched';
      query: string;
      owner: MethodsOwner;
      methods: MethodResult[];
    }
  | {
      kind: 'missing';
      query: string;
      suggestions: string[];
    }
  | {
      kind: 'ambiguous';
      query: string;
      total: number;
      candidates: SymbolResolutionCandidate[];
    };

export function resolveMethods(db: ScipDatabase, options: ResolveMethodsOptions): MethodsResolution {
  const className = options.className;
  const resolution = resolveSymbol(db, className);
  if (!resolution.match) {
    return {
      kind: 'missing',
      query: className,
      suggestions: nearestSymbolNames(db, className, 5),
    };
  }
  if (resolution.total > 1) {
    return {
      kind: 'ambiguous',
      query: className,
      total: resolution.total,
      candidates: [candidateFromMatch(resolution.match), ...resolution.candidates],
    };
  }
  return {
    kind: 'matched',
    query: className,
    owner: ownerFromMatch(resolution.match),
    methods: methodsForOwner(db, resolution.match),
  };
}

/**
 * @deprecated Use `resolveMethods(db, { className })` so missing and ambiguous
 * resolution remain structured outcomes.
 */
// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function methods(db: ScipDatabase, className: string): MethodResult[] {
  const resolution = resolveMethods(db, { className });
  if (resolution.kind === 'missing') {
    throw new Error(`No class definition matched '${className}'.`);
  }
  if (resolution.kind === 'ambiguous') {
    const candidates = resolution.candidates
      .map((candidate) => `${candidate.relativePath}:${candidate.startLine + 1}`)
      .join(', ');
    throw new Error(
      `Class '${className}' is ambiguous across ${resolution.total} definitions (${candidates}). ` +
        'Qualify it with a path or exact SCIP symbol identity.',
    );
  }
  return resolution.methods;
}

function methodsForOwner(db: ScipDatabase, classMatch: SymbolMatch): MethodResult[] {
  const ownerName = leafName(classMatch.symbol);
  const index = new ProjectIndex(db);
  const definitions = index
    .definitionsForFile(classMatch.relativePath)
    .filter((definition) => isCallableSymbol(definition.symbol));

  const directMethods = definitions.filter(
    (definition) =>
      definition.enclosingSymbol === classMatch.symbol || isDirectChildSymbol(classMatch.symbol, definition.symbol),
  );

  const fileScopedMethods =
    directMethods.length > 0
      ? directMethods
      : stripExtension(basename(classMatch.relativePath)) === ownerName
        ? definitions.filter((definition) => definition.symbol.includes('<invalid-global-code>'))
        : [];

  const graphMethods = fileScopedMethods.map((definition) => ({
    startLine: definition.startLine,
    endLine: definition.endLine,
    name: leafName(definition.symbol),
  }));
  if (detectAstLanguage(classMatch.relativePath) !== 'clojure') return graphMethods;

  return mergeMethods(graphMethods, clojureSourceMethods(db, classMatch));
}

function candidateFromMatch(match: SymbolMatch): SymbolResolutionCandidate {
  return {
    symbol: match.symbol,
    shortName: shortenSymbol(match.symbol),
    relativePath: match.relativePath,
    startLine: match.startLine,
  };
}

function ownerFromMatch(match: SymbolMatch): MethodsOwner {
  return {
    ...candidateFromMatch(match),
    endLine: match.endLine,
  };
}

function stripExtension(relativePath: string): string {
  return relativePath.replace(/\.[^.]+$/, '');
}

function clojureSourceMethods(db: ScipDatabase, owner: { symbol: string; relativePath: string }): MethodResult[] {
  const ownerName = leafName(owner.symbol);
  if (!ownerName) return [];
  return (getSourceFacts(db, owner.relativePath)?.clojureMembers ?? [])
    .filter((member) => member.ownerName === ownerName)
    .map((member) => ({
      startLine: member.startLine,
      endLine: member.endLine,
      name: member.memberName,
    }));
}

function mergeMethods(graphMethods: MethodResult[], sourceMethods: MethodResult[]): MethodResult[] {
  const byLocation = new Map<string, MethodResult>();
  for (const method of [...graphMethods, ...sourceMethods]) {
    byLocation.set(`${method.name}:${method.startLine}:${method.endLine}`, method);
  }
  return [...byLocation.values()].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}
