import type { ScipDatabase } from '../storage/db.js';
import { getRustAttrReferencedNames } from '../analysis/framework-patterns.js';
import { detectAstLanguage } from '../source/ast.js';
import type { IsolatedResult } from '../domain/types.js';
import { leafName, shortenSymbol } from '../symbols/symbol-parser.js';
import { ProjectIndex } from '../core/project-index.js';

/**
 * Find isolated callables: defined locally, referenced by nothing,
 * and calling nothing else. These are truly disconnected leaves.
 */
// scip-query: ignore-similar — fingerprint overlaps with loadComplexityCandidates
// (shared scoped-definition + callee/caller graph plumbing) but the heuristics
// are unrelated.
export function isolated(
  db: ScipDatabase,
  opts: { scope?: string; minLoc?: number } = {},
): IsolatedResult[] {
  const { scope, minLoc = 3 } = opts;
  const index = new ProjectIndex(db);

  const candidates = index.productionCallableDefinitions({
    scope,
    minLoc,
    excludeEntrySurfaces: true,
    excludeRustTraitImplMembers: true,
    includeSuppressed: true,
  });

  const scipCallerMap = index.crossFileCallerMap(candidates);
  const fallbackCallerMap = index.sourceFallbackCallerFiles(candidates);
  const symbolsWithCallers = new Set<number>([
    ...scipCallerMap.keys(),
    ...fallbackCallerMap.keys(),
  ]);

  // Same-file string-attr references count as a usage. `buildCrossFileCallerMap`
  // skips same-file callers (correct for cross-file isolation) but a function
  // referenced by `#[serde(default = "fn")]` in its own file is not isolated
  // — it's used; just not from another file. Walk every Rust source once and
  // mark candidates whose leaf appears in the file's serde/schemars attrs.
  const candidatesByLeaf = new Map<string, number[]>();
  for (const c of candidates) {
    const leaf = leafName(c.symbol);
    if (!leaf) continue;
    const bucket = candidatesByLeaf.get(leaf) ?? [];
    bucket.push(c.symbolId);
    candidatesByLeaf.set(leaf, bucket);
  }
  const docs = db.all<{ relative_path: string }>(
    `SELECT relative_path FROM documents WHERE 1 = 1 ${db.pathExclusionsFor('documents')}`,
  );
  for (const doc of docs) {
    if (db.isIgnored(doc.relative_path)) continue;
    if (detectAstLanguage(doc.relative_path) !== 'rust') continue;
    const refs = getRustAttrReferencedNames(db, doc.relative_path);
    for (const name of refs) {
      const ids = candidatesByLeaf.get(name);
      if (!ids) continue;
      for (const id of ids) symbolsWithCallers.add(id);
    }
  }

  const symbolBySymbolId = new Map(candidates.map((d) => [d.symbolId, d.symbol]));
  // additive: chunk-based callee detection unioned with AST. For "does this
  // function call anything at all?" we want max recall — Rust trait methods
  // like `new()` and `from()` resolve via dynamic dispatch and AST attribution
  // skips them as ambiguous leaves; the chunk path catches them.
  const calleeMap = index.calleeMap(candidates, { additive: true });
  const symbolsWithCallees = new Set(
    [...calleeMap.entries()]
      .filter(([symbolId, callees]) => {
        const ownSymbol = symbolBySymbolId.get(symbolId);
        return callees.some((c) => c.symbol !== ownSymbol);
      })
      .map(([id]) => id),
  );

  return candidates
    .filter((d) => !symbolsWithCallers.has(d.symbolId))
    .filter((d) => !symbolsWithCallees.has(d.symbolId))
    .sort((left, right) =>
      (right.endLine - right.startLine) - (left.endLine - left.startLine)
      || left.relativePath.localeCompare(right.relativePath)
      || left.startLine - right.startLine,
    )
    .map((definition) => ({
      symbol: definition.symbol,
      shortName: shortenSymbol(definition.symbol),
      relativePath: definition.relativePath,
      startLine: definition.startLine,
      endLine: definition.endLine,
      loc: definition.endLine - definition.startLine + 1,
    }));
}
