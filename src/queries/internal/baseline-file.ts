/**
 * Shared ratchet infrastructure: the baseline file format, its location, and
 * the comparison that turns a finding set into new-versus-fixed.
 *
 * This lives below every detector on purpose. Both the health report and the
 * architecture check compare against the same committed baseline, so the file
 * format and the comparison cannot belong to either of them without one
 * importing the other. What stays out of this module is the production of
 * findings — collecting them requires running detectors, which sit above.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { readSmallArtifactText } from '../../storage/bounded-artifact.js';

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

/**
 * Convert legacy pair findings that embedded full SCIP package identities to
 * repository-qualified symbol names. Other detector identities, including
 * architecture findings, pass through unchanged.
 */
export function normalizeBaselineFindingIdentity(finding: string): string {
  if (finding.startsWith('similar:')) {
    const symbols = finding.slice('similar:'.length).split('|');
    if (symbols.length !== 2) return finding;
    return `similar:${symbols.map(shortenSymbol).sort().join('|')}`;
  }

  if (finding.startsWith('duplicate-bodies:')) {
    const remainder = finding.slice('duplicate-bodies:'.length);
    const hashSeparator = remainder.indexOf(':');
    if (hashSeparator < 0) return finding;
    const hash = remainder.slice(0, hashSeparator);
    const symbols = remainder.slice(hashSeparator + 1).split('|');
    if (symbols.length < 2) return finding;
    return `duplicate-bodies:${hash}:${symbols.map(shortenSymbol).sort().join('|')}`;
  }

  return finding;
}

export function resolveBaselinePath(db: ScipDatabase, path?: string): string {
  if (path && isAbsolute(path)) return path;
  return join(db.config.projectRoot, path ?? DEFAULT_BASELINE_FILENAME);
}

/**
 * Compare a freshly computed finding set against the committed baseline.
 *
 * `accept` narrows which recorded identities participate, so a check that owns
 * one finding family (architecture) can ratchet against the shared file
 * without treating every other family's absence as a fix.
 */
export function compareAgainstBaseline(
  db: ScipDatabase,
  current: readonly string[],
  opts: { path?: string; accept?: (finding: string) => boolean } = {},
): BaselineComparison {
  const path = resolveBaselinePath(db, opts.path);
  if (!existsSync(path)) {
    throw new Error(`No baseline found at ${path}. Create one with: scip-query health --write-baseline`);
  }
  const parsed = JSON.parse(readSmallArtifactText(path, 'health baseline')) as HealthBaselineFile;
  const recorded = (parsed.findings ?? []).map(normalizeBaselineFindingIdentity);
  const baseline = new Set(opts.accept ? recorded.filter(opts.accept) : recorded);
  const currentSet = new Set(current);

  return {
    baselinePath: path,
    baselineCount: baseline.size,
    current: [...current],
    newFindings: current.filter((finding) => !baseline.has(finding)),
    fixedFindings: [...baseline].filter((finding) => !currentSet.has(finding)),
  };
}
