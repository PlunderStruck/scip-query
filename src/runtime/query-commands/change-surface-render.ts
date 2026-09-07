import type { ChangeSurfaceEntry } from '../../queries/index.js';
import { displayRange } from '../render.js';

/** Shared symbol-risk row for change-surface and repository-context output. */
export function changeSurfaceSymbolRow(symbol: ChangeSurfaceEntry): string {
  const risk =
    symbol.riskLevel === 'high' ? ' *** HIGH RISK ***' : symbol.riskLevel === 'medium' ? ' * medium risk *' : '';
  const riskReasons = symbol.riskReasons ?? [];
  const reasons =
    riskReasons.length === 0
      ? ''
      : `  [why: ${riskReasons.map((reason) => `${reason.kind}: ${reason.detail}`).join('; ')}]`;
  return `  ${displayRange(symbol.startLine, symbol.endLine)}  ${symbol.shortName}  [${symbol.externalConsumers} consumers]${risk}${reasons}`;
}
