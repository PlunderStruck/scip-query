import { basename } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { ProjectIndex } from '../internal/project-index.js';
import { resolveSymbol } from '../../symbols/symbol-lookup.js';
import { detectAstLanguage, getSourceFacts } from '../../source/ast.js';
import { isCallableSymbol, leafName } from '../../symbols/symbol-parser.js';

export interface MethodResult {
  startLine: number;
  endLine: number;
  name: string;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export function methods(db: ScipDatabase, className: string): MethodResult[] {
  const resolution = resolveSymbol(db, className);
  if (!resolution.match) {
    throw new Error(`No class definition matched '${className}'.`);
  }
  if (resolution.total > 1) {
    const candidates = [resolution.match, ...resolution.candidates]
      .map((candidate) => `${candidate.relativePath}:${candidate.startLine + 1}`)
      .join(', ');
    throw new Error(
      `Class '${className}' is ambiguous across ${resolution.total} definitions (${candidates}). ` +
        'Qualify it with a path or exact SCIP symbol identity.',
    );
  }
  const classMatch = resolution.match;

  const ownerName = leafName(classMatch.symbol);
  const index = new ProjectIndex(db);
  const definitions = index
    .definitionsForFile(classMatch.relativePath)
    .filter((definition) => isCallableSymbol(definition.symbol));

  const directMethods = definitions.filter(
    (definition) => definition.parentTypeName === ownerName || definition.symbol.includes(ownerName),
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
