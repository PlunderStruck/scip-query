import { join } from 'node:path';
import type { IndexedDefinition } from '../domain/types.js';
import { getSourceText } from '../source/primitives/source-text.js';
import type { ScipDatabase } from '../storage/db.js';
import { createPerDbCache } from '../storage/per-db-cache.js';
import { analyzeTypeScriptLocalFlow, type TypeScriptLocalFlowResult } from './typescript/local-flow.js';
import { isTypeScriptLike } from './typescript/source-kinds.js';

const TYPESCRIPT_LOCAL_FLOW_CACHE = createPerDbCache<string, TypeScriptLocalFlowResult>('typescript-local-flow', {
  clearGroups: ['whole-project', 'source-file', 'semantic-provider'],
});

/** Compiler-owned local definition-use evidence for one indexed TypeScript callable. */
export function semanticLocalFlowForDefinition(
  db: ScipDatabase,
  definition: IndexedDefinition,
): TypeScriptLocalFlowResult | null {
  return semanticLocalFlowForRange(db, definition.relativePath, definition.startLine, definition.endLine);
}

/** Compiler-owned local definition-use evidence for an exact TypeScript source range. */
export function semanticLocalFlowForRange(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  endLine: number,
): TypeScriptLocalFlowResult | null {
  if (!isTypeScriptLike(relativePath)) return null;
  const cacheKey = `${relativePath}\0${startLine}\0${endLine}`;
  return TYPESCRIPT_LOCAL_FLOW_CACHE.get(db, cacheKey, () => {
    const source = getSourceText(db, relativePath);
    if (!source) {
      return {
        points: [],
        edges: [],
        coverage: {
          status: 'unsupported',
          basis: 'typescript-compiler-cfg-reaching-definitions',
          unsupported: [`Current source is unavailable for ${relativePath}.`],
        },
      };
    }
    return analyzeTypeScriptLocalFlow(source, join(db.config.projectRoot, relativePath), {
      startLine,
      endLine,
    });
  });
}

export type {
  TypeScriptLocalFlowCoverage,
  TypeScriptLocalFlowEdge,
  TypeScriptLocalFlowPoint,
  TypeScriptLocalFlowResult,
} from './typescript/local-flow.js';
