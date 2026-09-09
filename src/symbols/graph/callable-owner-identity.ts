import type { ScipDatabase } from '../../storage/db.js';
import type { SymbolMatch } from '../../domain/types.js';
import type { SourceCallableOwner } from '../../source/facts/source-fact-types.js';
import { getSourceFacts } from '../../source/facts/source-facts.js';
import { leafName } from '../symbol-parser.js';

export function sourceCallableOwnerKey(owner: SourceCallableOwner | null): string {
  return owner ? `${owner.startLine}:${owner.startColumn}:${owner.endLine}:${owner.endColumn}` : '';
}

export function lexicalCallOwners<D extends SymbolMatch>(
  db: ScipDatabase,
  file: string,
  definitions: readonly D[],
): Map<string, D> {
  const owners = new Map<string, D>();
  const ambiguous = new Set<string>();
  for (const definition of definitions) {
    // A definition may contain many functions, including another with the same
    // name. Its uniquely enclosing matching declaration owns it; a nested call cannot climb
    // to an outer definition merely because the requested set omitted its owner.
    const callable = sourceCallableForDefinition(db, file, definition);
    if (!callable || callable.startColumn === undefined || callable.endColumn === undefined) continue;
    const key = sourceCallableOwnerKey({
      ...callable,
      startColumn: callable.startColumn,
      endColumn: callable.endColumn,
    });
    if (owners.has(key)) ambiguous.add(key);
    else owners.set(key, definition);
  }
  for (const key of ambiguous) owners.delete(key);
  return owners;
}

export function sourceCallableForDefinition(db: ScipDatabase, file: string, definition: SymbolMatch) {
  const leaf = leafName(definition.symbol);
  const name = leaf === '<constructor>' ? 'constructor' : leaf;
  const candidates = (getSourceFacts(db, file)?.callables ?? []).filter(
    (candidate) =>
      candidate.name === name &&
      candidate.startLine >= definition.startLine &&
      candidate.endLine <= definition.endLine &&
      (candidate.startLine !== definition.startLine ||
        candidate.startColumn === undefined ||
        candidate.startColumn >= (definition.startChar ?? 0)) &&
      (candidate.endLine !== definition.endLine ||
        candidate.endColumn === undefined ||
        !definition.endChar ||
        candidate.endColumn <= definition.endChar),
  );
  // A matching nested declaration cannot own its enclosing declaration's symbol.
  // Multiple disjoint matches in a coarse legacy range remain ambiguous.
  const outer = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          other !== candidate &&
          (other.startLine < candidate.startLine ||
            (other.startLine === candidate.startLine && (other.startColumn ?? 0) < (candidate.startColumn ?? 0))) &&
          (other.endLine > candidate.endLine ||
            (other.endLine === candidate.endLine &&
              (other.endColumn ?? Number.MAX_SAFE_INTEGER) >= (candidate.endColumn ?? 0))),
      ),
  );
  return outer.length === 1 ? outer[0] : undefined;
}
