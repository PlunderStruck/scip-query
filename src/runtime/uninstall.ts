import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { removeAgentSetup, type RemoveAgentSetupResult } from './agent-setup.js';
import { uninstallSkills, type UninstallSkillsResult } from './setup.js';

export interface ProjectUninstallResult {
  agentSetup: RemoveAgentSetupResult;
  left: string[];
}

export interface UninstallReport {
  dryRun: boolean;
  global?: UninstallSkillsResult;
  project?: ProjectUninstallResult;
}

export function formatUninstallReport(report: UninstallReport, opts: { verbose?: boolean } = {}): string[] {
  const lines: string[] = [];
  const prefix = report.dryRun ? 'would ' : '';

  if (report.global) appendGlobalUninstallReport(lines, report.global, prefix, opts.verbose);
  if (report.project) appendProjectUninstallReport(lines, report.project, prefix);

  const removed = (report.global?.removed.length ?? 0) + (report.project?.agentSetup.removed.length ?? 0);
  if (removed === 0) {
    lines.push(report.dryRun ? 'No scip-query-owned files would be removed.' : 'No scip-query-owned files removed.');
  }
  return lines;
}

function appendGlobalUninstallReport(
  lines: string[],
  report: UninstallSkillsResult,
  prefix: string,
  verbose: boolean | undefined,
): void {
  for (const target of report.removed) lines.push(`  ${prefix}remove: ${target}`);
  if (verbose) {
    for (const target of report.left) lines.push(`  left: ${target}`);
  } else if (report.left.length > 0) {
    const noun = report.left.length === 1 ? 'entry' : 'entries';
    lines.push(`  left: ${report.left.length} unrelated global skill ${noun} (use --verbose to list)`);
  }
  for (const skip of report.skipped) lines.push(`  skip: ${skip}`);
}

function appendProjectUninstallReport(lines: string[], report: ProjectUninstallResult, prefix: string): void {
  for (const target of report.agentSetup.removed) lines.push(`  ${prefix}remove: ${target}`);
  for (const target of report.agentSetup.unchanged) lines.push(`  ok: ${target} (no managed block)`);
  for (const skip of report.agentSetup.skipped) lines.push(`  skip: ${skip.target} — ${skip.reason}`);
  for (const target of report.left) lines.push(`  left: ${target}`);
}

export type UninstallScopeSelection = { ok: true; global: boolean; project: boolean } | { ok: false; message: string };

export function selectUninstallScope(opts: {
  global?: boolean;
  project?: boolean;
  dryRun?: boolean;
}): UninstallScopeSelection {
  const requestedGlobal = opts.global === true;
  const requestedProject = opts.project === true;
  if (requestedGlobal && requestedProject) {
    return { ok: false, message: 'choose either --global or --project, not both.' };
  }
  if (!requestedGlobal && !requestedProject) {
    if (opts.dryRun === true) return { ok: true, global: true, project: true };
    return {
      ok: false,
      message:
        'uninstall requires an explicit scope: use --global or --project. To preview both scopes without removing anything, run uninstall --dry-run.',
    };
  }
  return { ok: true, global: requestedGlobal, project: requestedProject };
}

export function runUninstall(opts: {
  projectRoot: string;
  global?: boolean;
  project?: boolean;
  dryRun?: boolean;
  homeDir?: string;
}): UninstallReport {
  const selection = selectUninstallScope(opts);
  if (!selection.ok) throw new Error(selection.message);
  const report: UninstallReport = { dryRun: opts.dryRun === true };

  if (selection.global) {
    report.global = uninstallSkills({ dryRun: opts.dryRun, homeDir: opts.homeDir });
  }

  if (selection.project) {
    report.project = uninstallProject(opts.projectRoot, { dryRun: opts.dryRun });
  }

  return report;
}

export function uninstallProject(projectRoot: string, opts: { dryRun?: boolean } = {}): ProjectUninstallResult {
  return {
    agentSetup: removeAgentSetup(projectRoot, { dryRun: opts.dryRun }),
    left: projectFilesLeftInPlace(projectRoot),
  };
}

function projectFilesLeftInPlace(projectRoot: string): string[] {
  return [
    ['.scipquery.json', join(projectRoot, '.scipquery.json')],
    ['.scipquery/suppressions/ (repository records)', join(projectRoot, '.scipquery', 'suppressions')],
    ['docs/scip-query/', join(projectRoot, 'docs', 'scip-query')],
  ]
    .filter(([, path]) => existsSync(path))
    .map(([label]) => label);
}
