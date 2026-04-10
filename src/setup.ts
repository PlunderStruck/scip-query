import {
  existsSync, mkdirSync, symlinkSync, readlinkSync,
  unlinkSync, chmodSync, createWriteStream,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { get as httpsGet } from 'node:https';

const IS_WINDOWS = platform() === 'win32';
const SKILLS = ['concrete-plan', 'scip-explore', 'scip-debloat'];
const SCIP_VERSION = 'v0.7.0';

// ── Skills Installation ────────────────────────────────────

export interface InstallSkillsResult {
  installed: string[];
  skipped: string[];
  alreadyLinked: string[];
}

/**
 * Install scip-query skills into both Claude Code (~/.claude/skills/)
 * and Codex (~/.codex/skills/). Uses symlinks (junctions on Windows)
 * so skills auto-update when the package updates.
 */
export function installSkills(
  opts: { quiet?: boolean } = {},
): InstallSkillsResult {
  const log = opts.quiet ? () => {} : console.log;
  const thisFile = fileURLToPath(import.meta.url);
  const skillsSource = resolve(dirname(thisFile), '..', 'skills');

  const targets = [
    join(homedir(), '.claude', 'skills'),
    join(homedir(), '.codex', 'skills'),
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
    const toolName = targetDir.includes('.codex') ? 'Codex' : 'Claude';

    for (const skill of SKILLS) {
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

// ── SCIP CLI Binary Detection & Installation ───────────────

/**
 * Check if the `scip` CLI binary is available on PATH.
 */
export function isScipInstalled(): boolean {
  try {
    const cmd = IS_WINDOWS ? 'where' : 'which';
    execFileSync(cmd, ['scip'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the scip CLI version if installed.
 */
export function getScipVersion(): string | null {
  try {
    const output = execFileSync('scip', ['--version'], { stdio: 'pipe' }).toString().trim();
    return output;
  } catch {
    return null;
  }
}

/**
 * Resolve the download URL for the scip CLI binary for this platform.
 */
function getScipDownloadUrl(): { url: string; filename: string } | null {
  const os = platform();
  const cpu = arch();

  let osName: string;
  let archName: string;
  let ext: string;

  switch (os) {
    case 'darwin': osName = 'darwin'; ext = 'tar.gz'; break;
    case 'linux': osName = 'linux'; ext = 'tar.gz'; break;
    case 'win32': osName = 'windows'; ext = 'zip'; break;
    default: return null;
  }

  switch (cpu) {
    case 'arm64': archName = 'arm64'; break;
    case 'x64': archName = 'amd64'; break;
    default: return null;
  }

  const filename = `scip-${osName}-${archName}.${ext}`;
  const url = `https://github.com/sourcegraph/scip/releases/download/${SCIP_VERSION}/${filename}`;
  return { url, filename };
}

/**
 * Print instructions for installing the scip CLI binary.
 */
export function printScipInstallInstructions(): void {
  const download = getScipDownloadUrl();

  console.log('\nThe `scip` CLI is required but not found on PATH.\n');

  if (platform() === 'darwin') {
    console.log('Install via Homebrew:');
    console.log('  brew install sourcegraph/scip/scip\n');
    console.log('Or download manually:');
  } else {
    console.log('Download from:');
  }

  if (download) {
    console.log(`  ${download.url}\n`);
  } else {
    console.log(`  https://github.com/sourcegraph/scip/releases/tag/${SCIP_VERSION}\n`);
  }

  console.log('After installing, ensure `scip` is on your PATH and run `scip-query reindex`.');
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

  // Check for scip binary (advisory, don't fail install)
  if (!isScipInstalled()) {
    printScipInstallInstructions();
  } else {
    const version = getScipVersion();
    console.log(`\nscip CLI: ${version ?? 'installed'}`);
  }

  console.log('');
}
