import type { SymbolMatch } from '../../domain/types.js';
import { escapeRegex } from '../../source/primitives/regex-utils.js';
import { getSourceLines } from '../../source/primitives/source-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import { leafName } from '../../symbols/symbol-parser.js';

/** True when a definition is explicitly exported by its source module. */
export function isExportedDefinition(db: ScipDatabase, sym: SymbolMatch): boolean {
  const lines = getSourceLines(db, sym.relativePath);
  if (lines.length === 0) return false;
  const name = leafName(sym.symbol);
  if (!name) return false;
  const declarationWindow = lines.slice(Math.max(0, sym.startLine - 2), sym.startLine + 1).join('\n');
  const escapedName = escapeRegex(name);
  const declarationPattern = new RegExp(
    `^\\s*export\\s+(?:default\\s+)?(?:` +
      `(?:async\\s+)?function\\s+${escapedName}\\b|` +
      `(?:abstract\\s+)?class\\s+${escapedName}\\b|` +
      `(?:interface|type|enum|namespace|module)\\s+${escapedName}\\b|` +
      `(?:const|let|var)\\s+${escapedName}\\b` +
      `)`,
    'm',
  );
  if (declarationPattern.test(declarationWindow)) return true;
  return hasNamedExport(lines, name);
}

function hasNamedExport(lines: readonly string[], name: string): boolean {
  if (!name) return false;
  const pattern = new RegExp(`^\\s*export\\s*\\{[^}\\n]*\\b${escapeRegex(name)}\\b`);
  return lines.some((line) => pattern.test(line));
}
