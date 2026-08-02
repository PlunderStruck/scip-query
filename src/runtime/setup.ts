import { existsSync, mkdirSync, symlinkSync, readlinkSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const IS_WINDOWS = platform() === 'win32';
export const BUILTIN_SKILLS = ['scip-query'] as const;
// ── Skills Installation ────────────────────────────────────

export interface InstallSkillsResult {
  installed: string[];
  skipped: string[];
  alreadyLinked: string[];
  pruned: string[];
}

// scip-query: ignore-stale — reviewed S1 owned contract; skill removal returns this named result.
export interface UninstallSkillsResult {
  removed: string[];
  left: string[];
  skipped: string[];
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
    pruned: [],
  };

  for (const targetDir of targets) {
    // Only install if the parent directory exists (tool is installed)
    const parentDir = dirname(targetDir);
    if (!existsSync(parentDir)) {
      continue;
    }

    mkdirSync(targetDir, { recursive: true });
    const toolName = toolNameForTarget(targetDir);
    pruneStaleOwnedSkillLinks(targetDir, skillsSource, toolName, result, log);

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

function pruneStaleOwnedSkillLinks(
  targetDir: string,
  skillsSource: string,
  toolName: string,
  result: InstallSkillsResult,
  log: (message: string) => void,
): void {
  const shipped = new Set<string>(BUILTIN_SKILLS);
  for (const entry of readdirSync(targetDir)) {
    if (shipped.has(entry)) continue;
    const target = join(targetDir, entry);
    let resolvedTarget: string;
    try {
      resolvedTarget = resolve(dirname(target), readlinkSync(target));
    } catch {
      continue;
    }
    if (!isPathInside(resolvedTarget, skillsSource)) continue;
    unlinkSync(target);
    result.pruned.push(`${toolName}/${entry}`);
    log(`  prune: ${entry} → ${toolName} (removed stale scip-query skill link)`);
  }
}

export function uninstallSkills(opts: { dryRun?: boolean; homeDir?: string } = {}): UninstallSkillsResult {
  const thisFile = fileURLToPath(import.meta.url);
  const skillsSource = resolve(dirname(thisFile), '..', 'skills');
  const home = opts.homeDir ?? homedir();
  const targets = [join(home, '.claude', 'skills'), join(home, '.codex', 'skills'), join(home, '.agents', 'skills')];
  const result: UninstallSkillsResult = { removed: [], left: [], skipped: [] };

  for (const targetDir of targets) {
    if (!existsSync(targetDir)) continue;
    const toolName = toolNameForTarget(targetDir);
    for (const entry of readdirSync(targetDir)) {
      const target = join(targetDir, entry);
      let resolvedTarget: string;
      try {
        const linkTarget = readlinkSync(target);
        resolvedTarget = resolve(dirname(target), linkTarget);
      } catch {
        result.left.push(`${toolName}/${entry} (not a symlink)`);
        continue;
      }
      if (!isPathInside(resolvedTarget, skillsSource)) {
        result.left.push(`${toolName}/${entry} (symlink outside scip-query package)`);
        continue;
      }
      result.removed.push(`${toolName}/${entry}`);
      if (!opts.dryRun) {
        try {
          unlinkSync(target);
        } catch (error) {
          result.skipped.push(`${toolName}/${entry} (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    }
  }

  return result;
}

function isPathInside(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function toolNameForTarget(targetDir: string): string {
  if (targetDir.includes('.codex')) return 'Codex';
  if (targetDir.includes('.agents')) return 'Agents';
  return 'Claude';
}

// ── First-Run Setup ────────────────────────────────────────

/**
 * Print first-time setup guidance.
 * Called from the postinstall script.
 */
export function postinstall(): void {
  console.log(
    "scip-query installed (Node.js 24 LTS recommended; minimum Node.js 22) -- run 'scip-query setup' in a repo to install skills and build the index.",
  );
}

export { isScipInstalled, getScipVersion, printScipInstallInstructions } from '../platform/scip-cli.js';
