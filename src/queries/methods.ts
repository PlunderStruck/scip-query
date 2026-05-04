import { basename } from 'node:path';
import type { ScipDatabase } from '../db.js';
import { findFirstSymbolMatch } from '../symbol-lookup.js';
import { getDefinitionsForFile } from '../definition-catalog.js';
import type { MethodResult } from '../types.js';
import { isCallableSymbol, leafName } from '../symbol-parser.js';

export function methods(db: ScipDatabase, className: string): MethodResult[] {
  const classMatch = findFirstSymbolMatch(db, className);
  if (!classMatch) {
    return [];
  }

  const ownerName = leafName(classMatch.symbol);
  const definitions = getDefinitionsForFile(db, classMatch.relativePath)
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
