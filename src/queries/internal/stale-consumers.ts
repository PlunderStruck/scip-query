import { getReExports } from '../../language-parsers/index.js';
import { detectAstLanguage, getAst, type SyntaxNode } from '../../source/ast.js';
import { getSourceText } from '../../source/source-text.js';
import { createPerDbCache } from '../../storage/per-db-cache.js';
import type { ScipDatabase } from '../../storage/db.js';
import { leafName } from '../../symbols/symbol-parser.js';

export interface StaleConsumerPartition {
  realConsumers: string[];
  barrelConsumers: number;
}

const FILE_USAGE_CACHE = createPerDbCache<string, { importedLeaves: Set<string>; usedLeaves: Set<string> }>('stale-abs-file-usage');

/**
 * Split consumers into "real" (actually use the type) vs "barrel" (their only
 * reference to the type is a passthrough re-export or import-only phantom use).
 */
export function partitionStaleConsumers(
  db: ScipDatabase,
  definitionFile: string,
  symbol: string,
  consumerFiles: string[],
): StaleConsumerPartition {
  const realConsumers: string[] = [];
  let barrelConsumers = 0;
  const leaf = leafName(symbol);

  for (const consumer of consumerFiles) {
    if (isReExportOnlyConsumer(db, consumer, definitionFile, leaf)) {
      barrelConsumers++;
    } else if (isImportOnlyConsumer(db, consumer, leaf)) {
      barrelConsumers++;
    } else {
      realConsumers.push(consumer);
    }
  }

  return { realConsumers, barrelConsumers };
}

export function isImportOnlyConsumer(
  db: ScipDatabase,
  consumerFile: string,
  leaf: string,
): boolean {
  if (!leaf) return false;
  const lang = detectAstLanguage(consumerFile);
  if (!lang) return false;
  const usage = FILE_USAGE_CACHE.get(db, consumerFile, () =>
    computeFileLeafUsage(db, consumerFile, lang),
  );
  return usage.importedLeaves.has(leaf) && !usage.usedLeaves.has(leaf);
}

// scip-query: ignore-passthrough — cache lifecycle hook for stale consumer
// classification; callers should not know the FILE_USAGE_CACHE key or shape.
export function clearStaleConsumerCaches(db: ScipDatabase): void {
  FILE_USAGE_CACHE.invalidateAll(db);
}

function computeFileLeafUsage(
  db: ScipDatabase,
  file: string,
  lang: string,
): { importedLeaves: Set<string>; usedLeaves: Set<string> } {
  const importedLeaves = new Set<string>();
  const usedLeaves = new Set<string>();
  const tree = getAst(db, file);
  if (!tree) return { importedLeaves, usedLeaves };

  const importTypes = lang === 'rust'
    ? new Set(['use_declaration'])
    : lang === 'python'
      ? new Set(['import_statement', 'import_from_statement'])
      : new Set(['import_statement']);

  const walk = (node: SyntaxNode, insideImport: boolean): void => {
    const nowInside = insideImport || importTypes.has(node.type);
    if (node.type === 'identifier' || node.type === 'type_identifier'
        || node.type === 'property_identifier' || node.type === 'field_identifier') {
      if (nowInside) importedLeaves.add(node.text);
      else usedLeaves.add(node.text);
    }
    for (const child of node.children) walk(child, nowInside);
  };
  walk(tree.rootNode, false);
  return { importedLeaves, usedLeaves };
}

/**
 * True when every mention of `leaf` in `consumerFile` sits inside a
 * re-export statement (`export { X } from '...'` or `export * from '...'`).
 */
function isReExportOnlyConsumer(
  db: ScipDatabase,
  consumerFile: string,
  _definitionFile: string,
  leaf: string,
): boolean {
  if (!leaf) return false;
  const source = getSourceText(db, consumerFile);
  if (!source) return false;

  const reExports = getReExports(db, consumerFile);
  if (reExports.length === 0) return false;

  const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wordRegex = new RegExp(`\\b${escaped}\\b`);
  const lines = source.split('\n');

  let occurrenceCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!wordRegex.test(lines[i] ?? '')) continue;
    occurrenceCount++;
    const coveredBy = reExports.find((r) => r.startLine <= i && i <= r.endLine);
    if (!coveredBy) return false;
  }

  return occurrenceCount > 0;
}
