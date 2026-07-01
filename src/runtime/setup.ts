import { existsSync, mkdirSync, symlinkSync, readlinkSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getScipVersion, isScipInstalled, printScipInstallInstructions, tryInstallScipCli } from './scip-cli.js';

const IS_WINDOWS = platform() === 'win32';
export const BUILTIN_SKILLS = [
  'scip-query',
  'scip-query-setup',
  'scip-adoption',
  'scip-health-audit',
  'scip-health-improve',
  'scip-hyper-optimization',
  'scip-api-impact',
  'concrete-plan',
  'scip-ai-cleanup',
  'scip-debug',
  'scip-explore',
  'scip-triage-issue',
  'scip-diagram',
  'scip-debloat',
  'scip-doc-reconcile',
  'scip-directory-architecture',
  'scip-maintainability',
  'scip-react-maintainability',
  'scip-vue-maintainability',
  'scip-verify',
  'scip-language-playbook',
  'tla-model-system',
] as const;
// ── Skills Installation ────────────────────────────────────

export interface InstallSkillsResult {
  installed: string[];
  skipped: string[];
  alreadyLinked: string[];
}

/**
 * Install scip-query skills into Claude Code (~/.claude/skills/),
 * Codex (~/.codex/skills/), and the shared agents skill root (~/.agents/skills/).
 * Uses symlinks (junctions on Windows)
 * so skills auto-update when the package updates.
 */
export function installSkills(opts: { quiet?: boolean } = {}): InstallSkillsResult {
  const log = opts.quiet ? () => {} : console.log;
  const thisFile = fileURLToPath(import.meta.url);
  const skillsSource = resolve(dirname(thisFile), '..', 'skills');

  const targets = [
    join(homedir(), '.claude', 'skills'),
    join(homedir(), '.codex', 'skills'),
    join(homedir(), '.agents', 'skills'),
  ];

  const result: InstallSkillsResult = {
    installed: [],
    skipped: [],
    alreadyLinked: [],
  };

  for (const targetDir of targets) {
    // Only install if the parent directory exists (tool is installed)
    const parentDir = dirname(targetDir);
    if (!existsSync(parentDir)) {
      continue;
    }

    mkdirSync(targetDir, { recursive: true });
    const toolName = toolNameForTarget(targetDir);

    for (const skill of BUILTIN_SKILLS) {
      const source = join(skillsSource, skill);
      const target = join(targetDir, skill);

      if (!existsSync(source)) {
        result.skipped.push(`${toolName}/${skill}`);
        continue;
      }

      if (existsSync(target)) {
        try {
          const existing = readlinkSync(target);
          if (resolve(existing) === resolve(source)) {
            result.alreadyLinked.push(`${toolName}/${skill}`);
            log(`  ok:   ${skill} → ${toolName} (already linked)`);
            continue;
          }
        } catch {
          // Not a symlink — don't overwrite user's custom skill
          result.skipped.push(`${toolName}/${skill}`);
          log(`  skip: ${skill} → ${toolName} (exists, not a symlink)`);
          continue;
        }
        unlinkSync(target);
      }

      // Use 'junction' on Windows (doesn't need admin), 'dir' elsewhere
      symlinkSync(source, target, IS_WINDOWS ? 'junction' : 'dir');
      result.installed.push(`${toolName}/${skill}`);
      log(`  done: ${skill} → ${toolName}`);
    }
  }

  return result;
}

function toolNameForTarget(targetDir: string): string {
  if (targetDir.includes('.codex')) return 'Codex';
  if (targetDir.includes('.agents')) return 'Agents';
  return 'Claude';
}

// ── First-Run Setup ────────────────────────────────────────

/**
 * Run first-time setup: install skills and check for scip binary.
 * Called from the postinstall script.
 */
export function postinstall(): void {
  console.log('scip-query: installing skills...');
  const result = installSkills({ quiet: false });

  const total = result.installed.length + result.alreadyLinked.length;
  if (total > 0) {
    console.log(`\n${result.installed.length} skill(s) installed, ${result.alreadyLinked.length} already linked.`);
  }

  // Check for scip binary — auto-install if missing
  if (!isScipInstalled()) {
    console.log('\nscip CLI not found on PATH. Attempting auto-install...');
    const installed = tryInstallScipCli(console.log);
    if (!installed) {
      printScipInstallInstructions();
    }
  } else {
    const version = getScipVersion();
    console.log(`\nscip CLI: ${version ?? 'installed'}`);
  }

  console.log('');
}

export { isScipInstalled, getScipVersion, printScipInstallInstructions } from './scip-cli.js';
export {
  installProjectAgentHooks,
  installUserAgentHooks,
  mergeScipHookConfig,
  removeUserAgentHooks,
  shouldSkipUserHookInstall,
} from './agent-hooks.js';
