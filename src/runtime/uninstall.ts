import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { removeAgentSetup, type RemoveAgentSetupResult } from './agent-setup.js';
import { installProjectAgentHooks, type InstallUserAgentHooksResult } from './agent-hooks.js';
import { uninstallSkills, type UninstallSkillsResult } from './setup.js';

export interface ProjectUninstallResult {
  hooks: InstallUserAgentHooksResult;
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

  if (report.global) {
    for (const target of report.global.removed) lines.push(`  ${prefix}remove: ${target}`);
    if (opts.verbose) {
      for (const target of report.global.left) lines.push(`  left: ${target}`);
    } else if (report.global.left.length > 0) {
      const noun = report.global.left.length === 1 ? 'entry' : 'entries';
      lines.push(`  left: ${report.global.left.length} unrelated global skill ${noun} (use --verbose to list)`);
    }
    for (const skip of report.global.skipped) lines.push(`  skip: ${skip}`);
  }

  if (report.project) {
    for (const target of report.project.hooks.removed) lines.push(`  ${prefix}remove: ${target}`);
    for (const target of report.project.agentSetup.removed) lines.push(`  ${prefix}remove: ${target}`);
    for (const target of report.project.agentSetup.unchanged) lines.push(`  ok: ${target} (no managed block)`);
    for (const skip of report.project.hooks.skipped) lines.push(`  skip: ${skip.target} — ${skip.reason}`);
    for (const skip of report.project.agentSetup.skipped) lines.push(`  skip: ${skip.target} — ${skip.reason}`);
    for (const target of report.project.left) lines.push(`  left: ${target}`);
  }

  const removed =
    (report.global?.removed.length ?? 0) +
    (report.project?.hooks.removed.length ?? 0) +
    (report.project?.agentSetup.removed.length ?? 0);
  if (removed === 0) {
    lines.push(report.dryRun ? 'No scip-query-owned files would be removed.' : 'No scip-query-owned files removed.');
  }
  return lines;
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
    hooks: installProjectAgentHooks(projectRoot, { remove: true, dryRun: opts.dryRun }),
    agentSetup: removeAgentSetup(projectRoot, { dryRun: opts.dryRun }),
    left: projectFilesLeftInPlace(projectRoot),
  };
}

function projectFilesLeftInPlace(projectRoot: string): string[] {
  return [
    ['.scipquery.json', join(projectRoot, '.scipquery.json')],
    ['.scipquery/goals/ (repository records)', join(projectRoot, '.scipquery', 'goals')],
    ['.scipquery/changes/ (repository records)', join(projectRoot, '.scipquery', 'changes')],
    ['.scipquery/attempts/ (repository records)', join(projectRoot, '.scipquery', 'attempts')],
    ['.scipquery/decisions/ (repository records)', join(projectRoot, '.scipquery', 'decisions')],
    ['.scipquery/obligations/ (repository records)', join(projectRoot, '.scipquery', 'obligations')],
    [
      '.scipquery/obligation-transitions/ (repository records)',
      join(projectRoot, '.scipquery', 'obligation-transitions'),
    ],
    [
      '.scipquery/completeness-admissions/ (repository records)',
      join(projectRoot, '.scipquery', 'completeness-admissions'),
    ],
    ['.scipquery/transition-rules/ (repository records)', join(projectRoot, '.scipquery', 'transition-rules')],
    ['.scipquery/completion-contexts/ (repository records)', join(projectRoot, '.scipquery', 'completion-contexts')],
    [
      '.scipquery/completion-evaluations/ (repository records)',
      join(projectRoot, '.scipquery', 'completion-evaluations'),
    ],
    [
      '.scipquery/completion-transitions/ (repository records)',
      join(projectRoot, '.scipquery', 'completion-transitions'),
    ],
    ['.scipquery/suppressions/ (repository records)', join(projectRoot, '.scipquery', 'suppressions')],
    ['.scipquery/events/ (repository records)', join(projectRoot, '.scipquery', 'events')],
    ['.scipquery/ledger/ (repository records)', join(projectRoot, '.scipquery', 'ledger')],
    ['docs/scip-query/', join(projectRoot, 'docs', 'scip-query')],
  ]
    .filter(([, path]) => existsSync(path))
    .map(([label]) => label);
}
