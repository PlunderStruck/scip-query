import { extname } from 'node:path';

import type {
  PlanAllowedSurvivor,
  PlanContractRecordV1,
  PlanReferentKind,
  PlanRetirementTarget,
} from '../../change-control/plan-contract.js';
import { normalizeSafeProjectRelativePath } from '../../domain/path-normalization.js';
import {
  isMissingProjectFileError,
  listProjectFiles,
  projectFileExists,
  readProjectFileText,
} from '../../platform/project-files.js';

export interface PlanRetirementOccurrence {
  file: string;
  line: number;
  excerpt: string;
}

export interface PlanRetirementEvaluation {
  planId: string;
  itemId: string;
  target: PlanRetirementTarget;
  disposition: 'contradiction' | 'supported-survivor' | 'insufficient-evidence';
  occurrences: PlanRetirementOccurrence[];
  reasons: string[];
  survivor?: PlanAllowedSurvivor;
}

export interface PlanRetirementCoverage {
  state: 'complete' | 'partial';
  scope: 'current-plan-retirement-literals-and-paths';
  analyzedFiles: string[];
  omitted: Array<{ planId: string; itemId: string; reason: string }>;
}

export interface PlanRetirementResidueResult {
  coverage: PlanRetirementCoverage;
  evaluations: PlanRetirementEvaluation[];
}

/**
 * Test explicit retirement consequences against the current repository. A
 * literal or path occurrence can prove that a named identity or artifact is
 * still present. Absence proves only this declared scope; responsibility-level
 * behavior remains incomplete unless the plan also names concrete artifacts.
 */
export function planRetirementResidue(
  projectRoot: string,
  plans: readonly PlanContractRecordV1[],
): PlanRetirementResidueResult {
  const files = listProjectFiles(projectRoot);
  const analyzedFiles = new Set<string>();
  const omitted: PlanRetirementCoverage['omitted'] = [];
  const evaluations: PlanRetirementEvaluation[] = [];

  for (const plan of plans) {
    for (const target of plan.retirements) {
      if (target.kind === 'responsibility') {
        omitted.push({
          planId: plan.planId,
          itemId: target.id,
          reason:
            'A responsibility description cannot establish behavior retirement without a concrete symbol or artifact seed.',
        });
        evaluations.push({
          planId: plan.planId,
          itemId: target.id,
          target,
          disposition: 'insufficient-evidence',
          occurrences: [],
          reasons: [
            'The plan must add a symbol, identity, file, configuration, test, documentation, or architecture seed.',
          ],
        });
        continue;
      }

      const scan = occurrencesFor(projectRoot, files, plan, target, analyzedFiles);
      if (scan.omitted.length > 0) {
        omitted.push(...scan.omitted.map((reason) => ({ planId: plan.planId, itemId: target.id, reason })));
      }
      if (scan.occurrences.length === 0) continue;
      const survivor = plan.allowedSurvivors.find((candidate) => candidate.referent === target.referent);
      const support = survivor ? verifySurvivorAuthority(projectRoot, survivor) : undefined;
      if (survivor && support?.supported) {
        evaluations.push({
          planId: plan.planId,
          itemId: target.id,
          target,
          disposition: 'supported-survivor',
          occurrences: scan.occurrences,
          reasons: support.reasons,
          survivor,
        });
        continue;
      }
      evaluations.push({
        planId: plan.planId,
        itemId: target.id,
        target,
        disposition: 'contradiction',
        occurrences: scan.occurrences,
        reasons: [
          `${target.referent} remains in ${scan.occurrences.length} current repository location(s).`,
          ...(survivor
            ? (support?.reasons ?? [
                'The claimed survivor authority could not be established from repository evidence.',
              ])
            : ['No supported current role authorizes this survivor.']),
        ],
        ...(survivor ? { survivor } : {}),
      });
    }
  }

  return {
    coverage: {
      state: omitted.length === 0 ? 'complete' : 'partial',
      scope: 'current-plan-retirement-literals-and-paths',
      analyzedFiles: [...analyzedFiles].sort(),
      omitted,
    },
    evaluations,
  };
}

function occurrencesFor(
  projectRoot: string,
  files: readonly string[],
  plan: PlanContractRecordV1,
  target: PlanRetirementTarget,
  analyzedFiles: Set<string>,
): { occurrences: PlanRetirementOccurrence[]; omitted: string[] } {
  if (target.kind === 'file') {
    try {
      const path = normalizeSafeProjectRelativePath(target.referent);
      return {
        occurrences:
          path !== plan.source.path && projectFileExists(projectRoot, path)
            ? [{ file: path, line: 1, excerpt: path }]
            : [],
        omitted: [],
      };
    } catch (error) {
      return { occurrences: [], omitted: [error instanceof Error ? error.message : String(error)] };
    }
  }

  const occurrences: PlanRetirementOccurrence[] = [];
  const omitted: string[] = [];
  for (const file of files) {
    if (file === plan.source.path || excludedHistoryPath(file) || !fileMatchesKind(file, target.kind)) continue;
    let source: string;
    try {
      source = readProjectFileText(projectRoot, file);
    } catch (error) {
      if (isMissingProjectFileError(error)) continue;
      omitted.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (source.includes('\0')) continue;
    analyzedFiles.add(file);
    const lines = source.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!containsReferent(line, target.referent)) continue;
      occurrences.push({ file, line: index + 1, excerpt: line.trim().slice(0, 240) });
    }
  }
  return { occurrences, omitted };
}

function verifySurvivorAuthority(
  projectRoot: string,
  survivor: PlanAllowedSurvivor,
): { supported: boolean; reasons: string[] } {
  if (survivor.authority !== 'repository-policy') {
    return {
      supported: false,
      reasons: [
        `${survivor.authority} survivor authority needs an independently fixed goal or decision reader; the literal closure producer cannot establish it.`,
      ],
    };
  }
  const separator = survivor.authorityReferent.indexOf('#');
  const pathPart = separator === -1 ? survivor.authorityReferent : survivor.authorityReferent.slice(0, separator);
  const fragment = separator === -1 ? '' : survivor.authorityReferent.slice(separator + 1);
  try {
    const path = normalizeSafeProjectRelativePath(pathPart);
    const policy = readProjectFileText(projectRoot, path);
    if (!fragment || !policy.toLowerCase().includes(fragment.toLowerCase())) {
      return {
        supported: false,
        reasons: [`${survivor.authorityReferent} does not resolve to a repository policy statement.`],
      };
    }
    return {
      supported: true,
      reasons: [
        `${survivor.authorityReferent} is a current repository policy source.`,
        `The plan records the current role as: ${survivor.currentRole}.`,
      ],
    };
  } catch (error) {
    return {
      supported: false,
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function fileMatchesKind(file: string, kind: PlanReferentKind): boolean {
  const lower = file.toLowerCase();
  if (kind === 'test') return /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|\.)/u.test(lower);
  if (kind === 'documentation') return /(?:\.md|\.mdx|\.rst|\.adoc|\.txt)$/u.test(lower);
  if (kind === 'architecture')
    return lower === '.scipquery.json' || /(?:^|\/)architecture[^/]*\.(?:json|ya?ml)$/u.test(lower);
  if (kind === 'configuration') {
    return (
      lower === '.scipquery.json' ||
      /(?:^|\/)(?:config|configuration|settings)(?:\/|\.)/u.test(lower) ||
      ['.json', '.yaml', '.yml', '.toml'].includes(extname(lower))
    );
  }
  return /\.(?:[cm]?[jt]sx?|vue|svelte|py|rs|go|java|kt|kts|rb|php|cs|fs|fsx|swift|scala|clj|cljs|ex|exs)$/u.test(
    lower,
  );
}

function containsReferent(line: string, referent: string): boolean {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(referent)) {
    return new RegExp(`\\b${escapeRegex(referent)}\\b`, 'u').test(line);
  }
  return line.includes(referent);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function excludedHistoryPath(file: string): boolean {
  return (
    file.startsWith('.scipquery/') ||
    file.startsWith('docs/plans/') ||
    file.startsWith('docs/reviews/') ||
    file.startsWith('docs/validation/')
  );
}
