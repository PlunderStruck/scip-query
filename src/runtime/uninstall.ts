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

export type UninstallScopeSelection =
  | { ok: true; global: boolean; project: boolean }
  | { ok: false; message: string };

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
    ['.scipquery/suppressions/ (repository records)', join(projectRoot, '.scipquery', 'suppressions')],
    ['.scipquery/ledger/ (repository records)', join(projectRoot, '.scipquery', 'ledger')],
    ['docs/scip-query/', join(projectRoot, 'docs', 'scip-query')],
  ]
    .filter(([, path]) => existsSync(path))
    .map(([label]) => label);
}
