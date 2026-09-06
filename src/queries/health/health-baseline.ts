/**
 * Health baseline — the ratchet. A committed snapshot of finding identities;
 * `health --baseline` fails when NEW findings appear, regardless of the
 * absolute score. "Don't get worse" is an objective gate that cannot be
 * gamed by score arithmetic.
 *
 * Identities are deterministic (detector:file:symbol; canonicalized cycle
 * and pair keys). Git-derived findings are deliberately excluded — new
 * commits would churn them without any code change.
 *
 * Detector options come from HEALTH_DETECTOR_PROFILES — the same constants
 * health uses, so the ratchet and the report always describe the same runs.
 */
import type { ScipDatabase } from '../../storage/db.js';
import { writeJsonDurable } from '../../storage/atomic-json.js';
import { isEntrySurface, isRootedSymbol } from '../../analysis/file-classifier.js';
import { HEALTH_DETECTOR_PROFILES } from '../internal/health-detector-profiles.js';
import {
  compareAgainstBaseline,
  normalizeBaselineFindingIdentity,
  resolveBaselinePath,
  type BaselineComparison,
  type HealthBaselineFile,
} from '../internal/baseline-file.js';
import { architecture, architectureFindingIdentities } from '../graph/architecture.js';
import { dependencyCycles } from '../graph/cycles.js';
import { dead } from '../cleanup/dead.js';
import { drift } from '../cleanup/drift.js';
import { duplicateBodies } from '../cleanup/duplicate-bodies.js';
import { passthroughCandidates } from '../cleanup/passthrough-candidates.js';
import { similarAll } from '../cleanup/similar.js';

// Baseline identities are exhaustive within the detector policies; display and scan
// budgets must not silently change the population compared on the next run.
export function collectBaselineFindings(db: ScipDatabase, opts: { scope?: string } = {}): string[] {
  const { scope } = opts;
  const findings: string[] = [];

  const deadResult = dead(db, { scope, ...HEALTH_DETECTOR_PROFILES.dead });
  for (const symbol of deadResult.symbols) {
    if (isEntrySurface(db, symbol.relativePath)) continue;
    if (isRootedSymbol(db, symbol.symbol, symbol.relativePath)) continue;
    if (symbol.kind !== 'dead-code') continue;
    findings.push(`dead:${symbol.relativePath}:${symbol.shortName}`);
  }

  for (const cycle of dependencyCycles(db, { scope, edgeBasis: 'imports' })) {
    findings.push(`cycle:${canonicalCycleKey(cycle.path)}`);
  }

  for (const pair of similarAll(db, { scope, ...HEALTH_DETECTOR_PROFILES.similar, limit: Number.POSITIVE_INFINITY })) {
    findings.push(`similar:${[pair.symbolA, pair.symbolB].sort().join('|')}`);
  }

  for (const group of duplicateBodies(db, {
    scope,
    ...HEALTH_DETECTOR_PROFILES.duplicateBodies,
    limit: Number.POSITIVE_INFINITY,
  })) {
    findings.push(
      `duplicate-bodies:${group.hash}:${group.functions
        .map((entry) => entry.symbol)
        .sort()
        .join('|')}`,
    );
  }

  for (const candidate of passthroughCandidates(db, {
    scope,
    ...HEALTH_DETECTOR_PROFILES.passthroughs,
    limit: Number.POSITIVE_INFINITY,
  })) {
    findings.push(`passthrough:${candidate.file}:${candidate.shortName}`);
  }

  // Baseline finding identities must cover every result, not just the CLI's
  // 21.2 default display cap, or findings beyond the cap would silently
  // vanish from the baseline and re-appear as new on the next comparison.
  for (const result of drift(db, {
    scope,
    ...HEALTH_DETECTOR_PROFILES.drift,
    includePatternDeviations: false,
    limit: Number.POSITIVE_INFINITY,
  }).results) {
    if (result.kind === 'architecture-violation') continue;
    findings.push(`drift:${result.kind}:${result.file}:${result.dep}`);
  }

  findings.push(...architectureFindingIdentities(architecture(db, { scope })));

  return [...new Set(findings.map(normalizeBaselineFindingIdentity))].sort();
}

/** Rotate so the lexicographically smallest file leads — stable across runs. */
function canonicalCycleKey(path: readonly string[]): string {
  if (path.length === 0) return '';
  let smallest = 0;
  for (let i = 1; i < path.length; i++) {
    if (path[i]! < path[smallest]!) smallest = i;
  }
  return [...path.slice(smallest), ...path.slice(0, smallest)].join('>');
}

export function writeHealthBaseline(
  db: ScipDatabase,
  opts: { path?: string; scope?: string } = {},
): { path: string; findingCount: number } {
  const findings = collectBaselineFindings(db, { scope: opts.scope });
  const path = resolveBaselinePath(db, opts.path);
  const payload: HealthBaselineFile = { version: 1, findings };
  writeJsonDurable(path, payload, { spacing: 2, trailingNewline: true });
  return { path, findingCount: findings.length };
}

export function checkHealthBaseline(
  db: ScipDatabase,
  opts: { path?: string; scope?: string } = {},
): BaselineComparison {
  return compareAgainstBaseline(db, collectBaselineFindings(db, { scope: opts.scope }), { path: opts.path });
}
