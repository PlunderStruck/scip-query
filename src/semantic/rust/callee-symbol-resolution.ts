import type { IndexedDefinition } from '../../domain/types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { getDefinitionsForFile } from '../../symbols/definition-catalog.js';
import type { SemanticCallee } from '../types.js';

export function resolveRustCalleeSymbol(db: ScipDatabase, callee: SemanticCallee): string {
  const definitions = getDefinitionsForFile(db, callee.file);
  if (definitions.length === 0) return callee.symbol;

  const nameCandidates = rustCalleeNameCandidates(callee.symbol);
  const sameNameDefinitions = definitions.filter((definition) => nameCandidates.has(definition.leaf));
  const namedLineMatch = pickDefinitionAtLine(sameNameDefinitions, callee.line);
  if (namedLineMatch) return namedLineMatch.symbol;

  const sameLineDefinitions = definitions.filter((definition) => definition.startLine === callee.line);
  if (sameLineDefinitions.length === 1) return sameLineDefinitions[0]!.symbol;

  return callee.symbol;
}

function pickDefinitionAtLine(definitions: readonly IndexedDefinition[], line: number): IndexedDefinition | null {
  const containing = definitions.filter((definition) => definition.startLine <= line && definition.endLine >= line);
  if (containing.length === 0) return null;
  const exactStart = containing.find((definition) => definition.startLine === line);
  return exactStart ?? containing.sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))[0]!;
}

function rustCalleeNameCandidates(name: string): Set<string> {
  const candidates = new Set([name]);
  const parts = name.split(/::|\.|#/).filter(Boolean);
  const last = parts.at(-1);
  if (last) candidates.add(last);
  return candidates;
}
