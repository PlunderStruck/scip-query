import { basename } from 'node:path';
import type { ScipDatabase } from '../storage/db.js';
import { ProjectIndex } from '../core/project-index.js';
import { findFirstSymbolMatch } from '../symbols/symbol-lookup.js';
import { isCallableSymbol, leafName } from '../symbols/symbol-parser.js';

export interface MethodResult {
  startLine: number;
  endLine: number;
  name: string;
}

export function methods(db: ScipDatabase, className: string): MethodResult[] {
  const classMatch = findFirstSymbolMatch(db, className);
  if (!classMatch) {
    return [];
  }

  const ownerName = leafName(classMatch.symbol);
  const index = new ProjectIndex(db);
  const definitions = index.definitionsForFile(classMatch.relativePath)
    .filter((definition) => isCallableSymbol(definition.symbol));

  const directMethods = definitions.filter((definition) => (
      definition.parentTypeName === ownerName
      || definition.symbol.includes(ownerName)
    ));

  const fileScopedMethods = directMethods.length > 0
    ? directMethods
    : (
      stripExtension(basename(classMatch.relativePath)) === ownerName
        ? definitions.filter((definition) => definition.symbol.includes('<invalid-global-code>'))
        : []
    );

  return fileScopedMethods.map((definition) => ({
    startLine: definition.startLine,
    endLine: definition.endLine,
    name: leafName(definition.symbol),
  }));
}

function stripExtension(relativePath: string): string {
  return relativePath.replace(/\.[^.]+$/, '');
}
