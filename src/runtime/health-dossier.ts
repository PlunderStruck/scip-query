import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// scip-query: ignore-stale — exported setup report attachment shared by setup
// orchestration, dossier writing, and tests; it is a named product contract.
export interface ProjectSetupHealthDossier {
  markdownPath: string;
  jsonPath: string;
  status: 'written' | 'failed';
  written: string[];
  unchanged: string[];
  error?: string;
}

interface HealthDossierReport {
  projectRoot: string;
  verdict: string;
  health: {
    score: number | null;
    riskScore: number | null;
    hygieneScore: number | null;
    unavailableReason?: string;
    issuesNeedAttention: Array<{
      category: string;
      description: string;
      count: number;
      impact: string;
      effort: string;
      evidence: string;
      confirmationStatus: string;
      safeForAgentToStart: boolean;
      recommendedNextStep: string;
    }>;
  };
  smokeTests: Array<{ command: string; status: string; evidence: string }>;
  steps: Array<{ status: string; label: string; message?: string }>;
  indexerRemediation: Array<{
    language: string;
    binaryLabel: string;
    attempted: boolean;
    after: { runnable: boolean };
    recovery?: string;
  }>;
  healthDossier: ProjectSetupHealthDossier | null;
}

export function writeProjectHealthDossier<Report extends HealthDossierReport>(
  report: Report,
): ProjectSetupHealthDossier {
  const pending: ProjectSetupHealthDossier = {
    markdownPath: join(report.projectRoot, 'docs', 'scip-query', 'health-dossier.md'),
    jsonPath: join(report.projectRoot, 'docs', 'scip-query', 'health-dossier.json'),
    status: 'written',
    written: [],
    unchanged: [],
  };
  const reportWithDossier = { ...report, healthDossier: pending };

  try {
    writeIfChanged(pending.markdownPath, renderHealthDossierMarkdown(reportWithDossier), pending);
    writeIfChanged(pending.jsonPath, `${JSON.stringify(reportWithDossier, null, 2)}\n`, pending);
    return pending;
  } catch (error) {
    return {
      ...pending,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function renderHealthDossierMarkdown(report: HealthDossierReport): string {
  const lines = [
    '# scip-query Health Dossier',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Project: ${report.projectRoot}`,
    `Setup verdict: ${report.verdict}`,
    `Health score: ${formatHealthScore(report)}`,
    '',
    '## Items That Need Attention',
    '',
    ...issueLines(report),
    '',
    '## Blocked Or Unavailable Checks',
    '',
    ...blockedLines(report),
    '',
    '## Setup Smoke Tests',
    '',
    ...report.smokeTests.map((test) => `- ${test.status.toUpperCase()} \`${test.command}\`: ${test.evidence}`),
    '',
    '## Setup Steps',
    '',
    ...report.steps.map(
      (step) => `- ${step.status.toUpperCase()} ${step.label}${step.message ? `: ${step.message}` : ''}`,
    ),
    '',
    '## Indexer Remediation',
    '',
    ...indexerLines(report),
    '',
    '## JSON',
    '',
    `Machine-readable report: \`${relativeDossierJsonPath(report)}\``,
    '',
  ];
  return `${lines.join('\n')}`;
}

function issueLines(report: HealthDossierReport): string[] {
  if (report.health.issuesNeedAttention.length === 0) {
    return ['No prioritized health actions were reported.'];
  }
  return report.health.issuesNeedAttention.map(
    (issue) =>
      `- ${issue.category}: ${issue.description} (${issue.count}; impact ${issue.impact}, effort ${issue.effort}, evidence ${issue.evidence}; confirmation ${issue.confirmationStatus}; safe to start ${issue.safeForAgentToStart ? 'yes' : 'no'}). ${issue.recommendedNextStep}`,
  );
}

function blockedLines(report: HealthDossierReport): string[] {
  const lines = [
    ...report.smokeTests
      .filter((test) => test.status !== 'pass')
      .map((test) => `- ${test.status.toUpperCase()} \`${test.command}\`: ${test.evidence}`),
    ...report.indexerRemediation
      .filter((entry) => !entry.after.runnable)
      .map((entry) => `- BLOCKED ${entry.language}: ${entry.recovery ?? `Install ${entry.binaryLabel}.`}`),
  ];
  return lines.length > 0 ? lines : ['No blocked or unavailable setup checks were reported.'];
}

function indexerLines(report: HealthDossierReport): string[] {
  if (report.indexerRemediation.length === 0) {
    return ['All detected indexers were already runnable.'];
  }
  return report.indexerRemediation.map((entry) => {
    const state = entry.after.runnable ? 'READY' : 'BLOCKED';
    const attempted = entry.attempted ? 'install attempted' : 'no automatic install attempted';
    return `- ${state} ${entry.language}: ${entry.binaryLabel} (${attempted})`;
  });
}

function formatHealthScore(report: HealthDossierReport): string {
  if (report.health.score === null) return `unavailable (${report.health.unavailableReason ?? 'not checked'})`;
  return `${report.health.score} (risk ${report.health.riskScore}, hygiene ${report.health.hygieneScore})`;
}

function relativeDossierJsonPath(report: HealthDossierReport): string {
  return report.healthDossier?.jsonPath.replace(`${report.projectRoot}/`, '') ?? 'docs/scip-query/health-dossier.json';
}

function writeIfChanged(path: string, content: string, result: ProjectSetupHealthDossier): void {
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readFileSync(path, 'utf-8') : null;
  if (current === content) {
    result.unchanged.push(path);
    return;
  }
  writeFileSync(path, content);
  result.written.push(path);
}
