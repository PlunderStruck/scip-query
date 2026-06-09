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
 * Detector options mirror the health profile but the contract that matters
 * is self-consistency between `--write-baseline` and `--baseline` runs.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ScipDatabase } from '../storage/db.js';
import { isEntrySurface, isRootedSymbol } from '../analysis/file-classifier.js';
import { cycles } from './cycles.js';
import { dead } from './dead.js';
import { drift } from './drift.js';
import { extractCandidates } from './extract-candidates.js';
import { isolated } from './isolated.js';
import { passthroughCandidates } from './passthrough-candidates.js';
import { similarAll } from './similar.js';
import { staleAbstractions } from './stale-abstractions.js';
import { stats } from './stats.js';
import { wrapperCandidates } from './wrapper-candidates.js';

// Mirror health's large-index budget so baseline runs stay bounded.
const LARGE_BASELINE_SYMBOL_THRESHOLD = 75_000;
const LARGE_BASELINE_DOCUMENT_THRESHOLD = 5_000;
const LARGE_BASELINE_SCAN_LIMIT = 2_500;

function baselineScanLimit(db: ScipDatabase): number | undefined {
  const overview = stats(db);
  const isLarge = overview.symbols >= LARGE_BASELINE_SYMBOL_THRESHOLD
    || overview.documents >= LARGE_BASELINE_DOCUMENT_THRESHOLD;
  return isLarge ? LARGE_BASELINE_SCAN_LIMIT : undefined;
}

export const DEFAULT_BASELINE_FILENAME = '.scipquery-baseline.json';

export interface HealthBaselineFile {
  version: 1;
  findings: string[];
}

export interface BaselineComparison {
  baselinePath: string;
  baselineCount: number;
  current: string[];
  newFindings: string[];
  fixedFindings: string[];
}

export function resolveBaselinePath(db: ScipDatabase, path?: string): string {
  if (path && isAbsolute(path)) return path;
  return join(db.config.projectRoot, path ?? DEFAULT_BASELINE_FILENAME);
}

export function collectBaselineFindings(
  db: ScipDatabase,
  opts: { scope?: string } = {},
): string[] {
  const { scope } = opts;
  const scanLimit = baselineScanLimit(db);
  const findings: string[] = [];

  const deadResult = dead(db, { scope, minLoc: 3, skipBarrels: true, deadCodeOnly: true, scanLimit, semantic: false });
  for (const symbol of deadResult.symbols) {
    if (isEntrySurface(db, symbol.relativePath)) continue;
    if (isRootedSymbol(db, symbol.symbol, symbol.relativePath)) continue;
    if (symbol.kind !== 'dead-code') continue;
    findings.push(`dead:${symbol.relativePath}:${symbol.shortName}`);
  }

  for (const symbol of isolated(db, { scope, minLoc: 3, scanLimit, semantic: false })) {
    if (isEntrySurface(db, symbol.relativePath)) continue;
    if (isRootedSymbol(db, symbol.symbol, symbol.relativePath)) continue;
    findings.push(`isolated:${symbol.relativePath}:${symbol.shortName}`);
  }

  for (const cycle of cycles(db, { scope })) {
    if (cycle.kind !== 'real') continue;
    findings.push(`cycle:${canonicalCycleKey(cycle.path)}`);
  }

  for (const pair of similarAll(db, { scope, minSimilarity: 0.6, limit: 50, minCallees: 4, scanLimit, semantic: false })) {
    findings.push(`similar:${[pair.symbolA, pair.symbolB].sort().join('|')}`);
  }

  for (const candidate of extractCandidates(db, { scope, minLoc: 15, minCallees: 5, limit: 50, scanLimit, semantic: false })) {
    findings.push(`extract:${candidate.relativePath}:${candidate.shortName}`);
  }

  for (const candidate of wrapperCandidates(db, { scope, maxLoc: 15, limit: 50, scanLimit, semantic: false })) {
    findings.push(`wrapper:${candidate.file}:${candidate.shortName}`);
  }

  for (const candidate of passthroughCandidates(db, { scope, maxLoc: 15, limit: 50, scanLimit, semantic: false })) {
    findings.push(`passthrough:${candidate.file}:${candidate.shortName}`);
  }

  for (const candidate of staleAbstractions(db, { scope, minLoc: 3, limit: 50, scanLimit, semantic: false })) {
    findings.push(`stale:${candidate.file}:${candidate.shortName}`);
  }

  for (const result of drift(db, { scope, semantic: false }).results) {
    if (result.kind === 'pattern-deviation') continue; // advisory, too noisy to ratchet
    findings.push(`drift:${result.kind}:${result.file}:${result.dep}`);
  }

  return [...new Set(findings)].sort();
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
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n');
  return { path, findingCount: findings.length };
}

export function checkHealthBaseline(
  db: ScipDatabase,
  opts: { path?: string; scope?: string } = {},
): BaselineComparison {
  const path = resolveBaselinePath(db, opts.path);
  if (!existsSync(path)) {
    throw new Error(`No baseline found at ${path}. Create one with: scip-query health --write-baseline`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as HealthBaselineFile;
  const baseline = new Set(parsed.findings ?? []);
  const current = collectBaselineFindings(db, { scope: opts.scope });
  const currentSet = new Set(current);

  return {
    baselinePath: path,
    baselineCount: baseline.size,
    current,
    newFindings: current.filter((finding) => !baseline.has(finding)),
    fixedFindings: [...baseline].filter((finding) => !currentSet.has(finding)),
  };
}
