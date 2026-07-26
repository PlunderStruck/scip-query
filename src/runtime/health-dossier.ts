import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readSmallArtifactText } from '../platform/bounded-file.js';

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
  generatedAt?: string;
}

export function writeProjectHealthDossier<Report extends HealthDossierReport>(
  report: Report,
  opts: { dossierDir?: string } = {},
): ProjectSetupHealthDossier {
  const dossierDir = opts.dossierDir
    ? resolve(report.projectRoot, opts.dossierDir)
    : join(report.projectRoot, 'docs', 'scip-query');
  const pending: ProjectSetupHealthDossier = {
    markdownPath: join(dossierDir, 'health-dossier.md'),
    jsonPath: join(dossierDir, 'health-dossier.json'),
    status: 'written',
    written: [],
    unchanged: [],
  };
  const reportWithDossier = relativizeReport(
    { ...report, generatedAt: new Date().toISOString(), healthDossier: pending },
    report.projectRoot,
  );

  try {
    writeIfChanged(pending.markdownPath, renderHealthDossierMarkdown(reportWithDossier), pending);
    writeJsonIfChanged(pending.jsonPath, reportWithDossier, pending);
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
    `Project: ${report.projectRoot}`,
    `Setup verdict: ${report.verdict}`,
    `Health score: ${formatHealthScoreSummary(report.health)}`,
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

export interface HealthScoreSummary {
  score: number | null;
  riskScore: number | null;
  hygieneScore: number | null;
  unavailableReason?: string;
}

export function formatHealthScoreSummary(health: HealthScoreSummary): string {
  if (health.score === null) return `unavailable (${health.unavailableReason ?? 'not checked'})`;
  return `${health.score} (risk ${health.riskScore}, hygiene ${health.hygieneScore})`;
}

function relativeDossierJsonPath(report: HealthDossierReport): string {
  return report.healthDossier?.jsonPath.replace(`${report.projectRoot}/`, '') ?? 'docs/scip-query/health-dossier.json';
}

function writeIfChanged(path: string, content: string, result: ProjectSetupHealthDossier): void {
  mkdirSync(dirname(path), { recursive: true });
  const current = existsSync(path) ? readSmallArtifactText(path, 'health dossier Markdown') : null;
  if (current === content) {
    result.unchanged.push(path);
    return;
  }
  writeFileSync(path, content);
  result.written.push(path);
}

function writeJsonIfChanged(path: string, payload: HealthDossierReport, result: ProjectSetupHealthDossier): void {
  mkdirSync(dirname(path), { recursive: true });
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  const current = existsSync(path) ? readSmallArtifactText(path, 'health dossier JSON') : null;
  if (current && jsonEqualIgnoringGeneratedAt(current, content)) {
    result.unchanged.push(path);
    return;
  }
  writeFileSync(path, content);
  result.written.push(path);
}

function jsonEqualIgnoringGeneratedAt(left: string, right: string): boolean {
  try {
    const leftParsed = JSON.parse(left) as Record<string, unknown>;
    const rightParsed = JSON.parse(right) as Record<string, unknown>;
    delete leftParsed['generatedAt'];
    delete rightParsed['generatedAt'];
    return JSON.stringify(leftParsed) === JSON.stringify(rightParsed);
  } catch {
    return left === right;
  }
}

function relativizeReport<Report extends HealthDossierReport>(report: Report, projectRoot: string): Report {
  return relativizeValue(report, projectRoot) as Report;
}

function relativizeValue(value: unknown, projectRoot: string): unknown {
  if (typeof value === 'string') return relativizeString(value, projectRoot);
  if (Array.isArray(value)) return value.map((entry) => relativizeValue(entry, projectRoot));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, relativizeValue(entry, projectRoot)]));
  }
  return value;
}

function relativizeString(value: string, projectRoot: string): string {
  if (value === projectRoot) return '.';
  if (!isAbsolute(value)) return value;
  const relativePath = relative(projectRoot, value).replace(/\\/g, '/');
  if (!relativePath) return '.';
  if (relativePath.startsWith('..')) {
    const homeRelativePath = relative(homedir(), value).replace(/\\/g, '/');
    if (homeRelativePath && !homeRelativePath.startsWith('..')) return `~/${homeRelativePath}`;
    return value;
  }
  return relativePath;
}
