import { isDeepStrictEqual } from 'node:util';
import { decodeProjectConfig } from '../../domain/project-config.js';
import {
  evaluateSuppressionAdjudication,
  automaticSuppressionRateIsAnomalous,
} from '../../domain/suppression-adjudication.js';
import type { SuppressionAdjudicationResult } from '../../domain/suppression-adjudication.js';
import { decodeSuppressionFile, readSuppressionDir, suppressionIdentity } from '../../storage/suppression-store.js';
import { readProjectFileText } from '../../source/primitives/project-file-boundary.js';
import { sourceHash } from '../../source/ast/function-metrics.js';
import type { SourceSnapshot } from '../../source/maintenance-snapshot.js';
import type { FindingSuppression } from '../../domain/config-types.js';
import type { SourceFinding } from './source-finding-contract.js';

export interface SourceSuppressionDecision {
  id?: string;
  check?: string;
  file?: string;
  outcome: SuppressionAdjudicationResult['kind'] | 'unmatched';
  reasons: string[];
}

/** Evaluate recorded exceptions against current source without requiring compiler-index state. */
export function sourceSuppressionDecisions(
  projectRoot: string,
  snapshot: SourceSnapshot,
  findings: readonly SourceFinding[],
  problems: string[],
): SourceSuppressionDecision[] {
  const { suppressions, conflicts } = mergeSourceSuppressionRecords(
    sourceSuppressionRecords(projectRoot, snapshot, problems),
  );
  const runtime = {
    now: Date.now(),
    contentHash(file: string): string | undefined {
      try {
        return sourceHash(
          snapshot.files.get(file) ?? snapshot.project.inputs.get(file) ?? readProjectFileText(projectRoot, file),
        );
      } catch {
        return undefined;
      }
    },
  };
  const decisions = suppressions.map((suppression) =>
    evaluateSourceSuppression(suppression, findings, conflicts, runtime),
  );
  const accepted = new Set(
    decisions.filter((decision) => decision.outcome === 'accepted').map((decision) => decision.id),
  );
  if (automaticSuppressionRateIsAnomalous(accepted.size, findings.length)) {
    for (const decision of decisions) {
      if (decision.outcome !== 'accepted') continue;
      decision.outcome = 'escalated';
      decision.reasons = ['Automatic suppression rate requires policy review.'];
    }
  }
  return decisions;
}

function evaluateSourceSuppression(
  suppression: FindingSuppression,
  findings: readonly SourceFinding[],
  conflicts: ReadonlySet<string>,
  runtime: Parameters<typeof evaluateSuppressionAdjudication>[2],
): SourceSuppressionDecision {
  const target = { id: suppression.id, check: suppression.check, file: suppression.file };
  const finding = findings.find((candidate) => candidate.id === suppression.id && candidate.status !== 'resolved');
  if (!finding)
    return { ...target, outcome: 'unmatched', reasons: ['No exact current finding in the requested scope.'] };
  if (conflicts.has(suppressionIdentity(suppression))) {
    return {
      ...target,
      outcome: 'escalated',
      reasons: ['Conflicting stored/configured suppression records require review.'],
    };
  }
  const scopeProblem = suppressionScopeProblem(suppression, finding);
  if (scopeProblem) return { ...target, outcome: 'escalated', reasons: [scopeProblem] };
  const result = evaluateSuppressionAdjudication(
    suppression,
    {
      id: finding.id,
      check: finding.rule,
      evidence: finding.evidence,
      actionTier: finding.evidence === 'derived' ? 'direct' : 'signal',
      file: finding.sites[0]?.file,
      targetFiles: finding.sites.map((site) => site.file),
    },
    runtime,
  );
  return { ...target, outcome: result.kind, reasons: result.kind === 'accepted' ? [] : result.reasons };
}

function suppressionScopeProblem(suppression: FindingSuppression, finding: SourceFinding): string | undefined {
  if (
    (suppression.check && suppression.check !== finding.rule) ||
    (suppression.file && !finding.sites.some((site) => site.file === suppression.file))
  ) {
    return 'Suppression detector/file scope does not match the finding.';
  }
  if (suppression.expiresAt && !Number.isFinite(Date.parse(suppression.expiresAt))) {
    return 'Invalid suppression expiry.';
  }
  return undefined;
}

function mergeSourceSuppressionRecords(records: FindingSuppression[]): {
  suppressions: FindingSuppression[];
  conflicts: Set<string>;
} {
  const byIdentity = new Map<string, FindingSuppression>();
  const conflicts = new Set<string>();
  for (const record of records) {
    const id = suppressionIdentity(record);
    const previous = byIdentity.get(id);
    if (previous && !isDeepStrictEqual(previous, record)) conflicts.add(id);
    else byIdentity.set(id, record);
  }
  return { suppressions: [...byIdentity.values()], conflicts };
}

function sourceSuppressionRecords(
  projectRoot: string,
  snapshot: SourceSnapshot,
  problems: string[],
): FindingSuppression[] {
  const records: FindingSuppression[] = [];
  try {
    const stored = readSuppressionDir(projectRoot);
    records.push(...stored.suppressions);
    problems.push(...stored.warnings.map((warning) => `Suppression storage: ${warning}`));
  } catch (error) {
    problems.push(`Suppression storage unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return [...records, ...configuredSuppressionRecords(snapshot, problems)];
}

function configuredSuppressionRecords(snapshot: SourceSnapshot, problems: string[]): FindingSuppression[] {
  const records: FindingSuppression[] = [];
  const raw = snapshot.project.inputs.get('.scipquery.json');
  if (raw === undefined) return records;
  const decoded = decodeProjectConfig(raw);
  if (decoded.kind === 'malformed' || decoded.kind === 'unsupported') return records;
  const configured = decoded.config.suppressions;
  if (configured !== undefined && !Array.isArray(configured)) {
    problems.push('.scipquery.json suppressions must be an array.');
    return records;
  }
  for (const candidate of configured ?? []) {
    const suppression = decodeSuppressionFile(candidate);
    if ('error' in suppression) problems.push(`Configured suppression: ${suppression.error}`);
    else records.push(suppression.suppression);
  }
  return records;
}
