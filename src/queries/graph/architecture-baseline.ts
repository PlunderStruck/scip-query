/**
 * Architecture-only view of the shared ratchet.
 *
 * The default diff gate blocks on architecture regressions without running the
 * full health detector set, so this compares just the architecture identity
 * family against the same committed baseline. It lives beside `architecture`
 * rather than beside the health report because that is the report it reads;
 * the file format and comparison come from `queries/internal`.
 */
import type { ScipDatabase } from '../../storage/db.js';
import { compareAgainstBaseline, type BaselineComparison } from '../internal/baseline-file.js';
import { ARCHITECTURE_BASELINE_PREFIX, architecture, architectureFindingIdentities } from './architecture.js';

export function checkArchitectureBaseline(
  db: ScipDatabase,
  opts: { path?: string; scope?: string } = {},
): BaselineComparison {
  const current = architectureFindingIdentities(architecture(db, { scope: opts.scope }));
  return compareAgainstBaseline(db, current, {
    path: opts.path,
    accept: (finding) => finding.startsWith(ARCHITECTURE_BASELINE_PREFIX),
  });
}
