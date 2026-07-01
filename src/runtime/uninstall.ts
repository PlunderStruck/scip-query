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

export function runUninstall(opts: {
  projectRoot: string;
  global?: boolean;
  project?: boolean;
  dryRun?: boolean;
  homeDir?: string;
}): UninstallReport {
  const requestedGlobal = opts.global === true;
  const requestedProject = opts.project === true;
  const noScopeRequested = !requestedGlobal && !requestedProject;
  const removeGlobal = requestedGlobal || noScopeRequested;
  const removeProject = requestedProject || noScopeRequested;
  const report: UninstallReport = { dryRun: opts.dryRun === true };

  if (removeGlobal) {
    report.global = uninstallSkills({ dryRun: opts.dryRun, homeDir: opts.homeDir });
  }

  if (removeProject) {
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
    ['docs/scip-query/', join(projectRoot, 'docs', 'scip-query')],
  ]
    .filter(([, path]) => existsSync(path))
    .map(([label]) => label);
}
