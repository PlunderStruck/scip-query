import type { ScipDatabase } from '../../storage/db.js';
import type { SymbolMatch } from '../../domain/types.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';
import { getCalleeRowsForSymbol } from '../../symbols/graph/call-graph-evidence.js';
import { uniqueSymbolFileRows } from '../query-utils.js';

export interface CallableCalleeEvidence {
  symbol: string;
  file: string;
}

// scip-query: ignore-similar — this boundary returns callable graph evidence;
// dataflow's endpoint collector has a different producer/consumer contract.
/** Keep query layers behind one compiler-backed callable-callee adapter. */
export function callableCalleeEvidence(db: ScipDatabase, definition: SymbolMatch): CallableCalleeEvidence[] {
  return uniqueSymbolFileRows(
    getCalleeRowsForSymbol(db, definition, {
      additive: true,
      callableOnly: true,
      semantic: true,
      semanticEvidence: symbolSemanticEvidence,
    }),
  ).map((callee) => ({ symbol: callee.symbol, file: callee.file }));
}
