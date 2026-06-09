import type { ProjectIndex } from '../../core/project-index.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { getReExports } from '../../language-parsers/index.js';
import { detectAstLanguage, getAst, type SyntaxNode } from '../../source/ast.js';
import { getSourceText } from '../../source/source-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import { createPerDbCache } from '../../storage/per-db-cache.js';
import { leafName } from '../../symbols/symbol-parser.js';

export interface DefinitionConsumerEvidenceOptions {
  semantic: boolean;
  sourceFallback?: boolean;
}

export interface DefinitionConsumerPartition {
  realConsumers: string[];
  barrelConsumers: number;
  importOnlyConsumers: number;
}

const FILE_USAGE_CACHE = createPerDbCache<string, { importedLeaves: Set<string>; usedLeaves: Set<string> }>('definition-consumer-file-usage', {
  clearGroups: ['whole-project', 'source-file'],
});

/**
 * Consumer evidence for detector queries: cross-file callers plus optional
 * source fallback, keyed by definition symbol id. This names the policy that
 * "consumer" means more than raw SCIP caller rows.
 */
export function definitionConsumerFileMap(
  index: ProjectIndex,
  definitions: readonly IndexedDefinition[],
  opts: DefinitionConsumerEvidenceOptions,
): Map<number, Set<string>> {
  return index.callerFileMap(definitions, {
    semantic: opts.semantic,
    sourceFallback: opts.sourceFallback,
  });
}

/**
 * Split consumer files into detector-ready buckets. "Real" consumers use the
 * definition outside a passthrough re-export or unused import-only reference.
 */
export function partitionDefinitionConsumers(
  db: ScipDatabase,
  definition: Pick<IndexedDefinition, 'relativePath' | 'symbol'>,
  consumerFiles: readonly string[],
): DefinitionConsumerPartition {
  const realConsumers: string[] = [];
  let barrelConsumers = 0;
  let importOnlyConsumers = 0;
  const leaf = leafName(definition.symbol);

  for (const consumer of consumerFiles) {
    if (isReExportOnlyConsumer(db, consumer, definition.relativePath, leaf)) {
      barrelConsumers++;
    } else if (isImportOnlyConsumer(db, consumer, leaf)) {
      importOnlyConsumers++;
    } else {
      realConsumers.push(consumer);
    }
  }

  return { realConsumers, barrelConsumers, importOnlyConsumers };
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

// scip-query: ignore-passthrough — cache lifecycle hook for consumer
// classification; callers should not know the FILE_USAGE_CACHE key or shape.
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
