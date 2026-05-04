import type { ScipDatabase } from '../db.js';
import { isEntrySurface } from '../file-classifier.js';
import { getScopedDefinitions } from '../definition-catalog.js';
import { buildCalleeMap, buildCrossFileCallerMap, buildSourceFallbackCallerFiles } from '../reference-graph.js';
import type { IsolatedResult } from '../types.js';
import { shortenSymbol } from '../symbol-parser.js';
import { appendFileSync } from 'node:fs';
const tr = (m: string): void => appendFileSync('/tmp/iso2.log', `${Date.now()} ${m}\n`);

/**
 * Find isolated callables: defined locally, referenced by nothing,
 * and calling nothing else. These are truly disconnected leaves.
 */
export function isolated(
  db: ScipDatabase,
  opts: { scope?: string; minLoc?: number } = {},
): IsolatedResult[] {
  const { scope, minLoc = 3 } = opts;

  tr('A start');
  const t = Date.now();
  const defs = getScopedDefinitions(db, scope);
  tr(`B getScopedDefinitions=${defs.length} +${Date.now()-t}ms`);
  const t2 = Date.now();
  const candidates = defs
    .filter((definition) => !db.isIgnored(definition.relativePath))
    .filter((definition) => !isEntrySurface(db, definition.relativePath))
    .filter((definition) => definition.isFunctionLike)
    .filter((definition) => (definition.endLine - definition.startLine + 1) >= minLoc);
  tr(`C candidates=${candidates.length} +${Date.now()-t2}ms`);

  const t3 = Date.now();
  const scipCallerMap = buildCrossFileCallerMap(db, candidates);
  tr(`D scipCallerMap=${scipCallerMap.size} +${Date.now()-t3}ms`);
  const t4 = Date.now();
  const fallbackCallerMap = buildSourceFallbackCallerFiles(db, candidates);
  tr(`E fallbackCallerMap=${fallbackCallerMap.size} +${Date.now()-t4}ms`);
  const symbolsWithCallers = new Set<number>([
    ...scipCallerMap.keys(),
    ...fallbackCallerMap.keys(),
  ]);

  const symbolBySymbolId = new Map(candidates.map((d) => [d.symbolId, d.symbol]));
  const t5 = Date.now();
  // additive: chunk-based callee detection unioned with AST. For "does this
  // function call anything at all?" we want max recall — Rust trait methods
  // like `new()` and `from()` resolve via dynamic dispatch and AST attribution
  // skips them as ambiguous leaves; the chunk path catches them.
  const calleeMap = buildCalleeMap(db, candidates, { additive: true });
  tr(`F calleeMap=${calleeMap.size} +${Date.now()-t5}ms`);
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
