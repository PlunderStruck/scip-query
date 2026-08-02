/**
 * Architecture-only view of the shared ratchet.
 *
 * Compares the architecture identity family against the committed health
 * baseline without running the full health detector set. It lives beside
 * `architecture` because that is the report it reads; the file format and
 * comparison come from `queries/internal`.
 */
import type { ScipDatabase } from '../../storage/db.js';
import { compareAgainstBaseline, type BaselineComparison } from '../internal/baseline-file.js';
import {
  ARCHITECTURE_BASELINE_PREFIX,
  architecture,
  architectureFindingIdentities,
  type ArchitectureReport,
} from './architecture.js';

export interface ArchitectureBaselineEvaluation {
  comparison: BaselineComparison;
  report: ArchitectureReport;
}

export function checkArchitectureBaseline(
  db: ScipDatabase,
  opts: { path?: string; scope?: string } = {},
): BaselineComparison {
  return evaluateArchitectureBaseline(db, opts).comparison;
}

export function evaluateArchitectureBaseline(
  db: ScipDatabase,
  opts: { path?: string; scope?: string } = {},
): ArchitectureBaselineEvaluation {
  const report = architecture(db, { scope: opts.scope });
  const current = architectureFindingIdentities(report);
  const comparison = compareAgainstBaseline(db, current, {
    path: opts.path,
    accept: (finding) => finding.startsWith(ARCHITECTURE_BASELINE_PREFIX),
  });
  return { comparison, report };
}
