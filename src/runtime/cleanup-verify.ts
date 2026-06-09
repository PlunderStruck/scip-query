/**
 * Compile-verified deletion — the universal oracle.
 *
 * Every language ships its own ground truth: tsc, cargo check. Applying a
 * cleanup batch in a throwaway git worktree and running the project's own
 * checker upgrades plan entries from candidates to proofs — and a FAILURE is
 * signal too: the errors name the references the static evidence missed
 * (barrel re-export lines, unused imports, dynamic paths).
 *
 * Batches verify cumulatively (batch n is only dead once batch n-1 is gone),
 * which also exercises the cascade claim itself.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CleanupBatch, CleanupPlanResult } from '../queries/cleanup-plan.js';
import { stripCommentsAndStrings } from '../source/source-stripper.js';

export interface BatchVerification {
  depth: number;
  status: 'verified' | 'failed';
  /** NEW checker errors caused by this batch — they name the missed references. */
  errors?: string[];
}

export interface CleanupVerification {
  /** Human-readable checker invocation, or null when none was detected. */
  checker: string | null;
  /**
   * Pre-existing checker errors on the UNMODIFIED tree. When > 0, batches
   * verify differentially: pass = no NEW errors beyond this baseline.
   */
  baselineErrors: number;
  /** Plan files that are dirty in the working tree — verification runs at HEAD. */
  dirtyOverlap: string[];
  batches: BatchVerification[];
}

const CHECK_TIMEOUT_MS = 300_000;
const MAX_ERROR_LINES = 12;

export function verifyCleanupPlan(
  projectRoot: string,
  plan: CleanupPlanResult,
  opts: { timeoutMs?: number } = {},
): CleanupVerification {
  const checker = detectChecker(projectRoot);
  if (!checker) {
    return { checker: null, baselineErrors: 0, dirtyOverlap: [], batches: [] };
  }

  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const dirtyOverlap = dirtyPlanFiles(projectRoot, plan);
  const worktree = mkdtempSync(join(tmpdir(), 'scip-cleanup-verify-'));
  const batches: BatchVerification[] = [];
  let baselineErrors = 0;
  try {
    execFileSync('git', ['-C', projectRoot, 'worktree', 'add', '--detach', '--force', worktree, 'HEAD'], {
      stdio: 'ignore',
    });
    linkUntrackedDeps(projectRoot, worktree);

    // Differential baseline: many projects don't check clean at the root
    // (workspace tsconfigs, pre-existing errors). Pass = no NEW errors.
    const baseline = runChecker(checker, worktree, timeoutMs);
    baselineErrors = baseline.errorKeys.size;

    for (const batch of plan.batches) {
      applyBatchDeletions(worktree, batch);
      const result = runChecker(checker, worktree, timeoutMs);
      const newErrors = result.rawErrors.filter((error) =>
        !baseline.errorKeys.has(errorKey(error)));
      if (newErrors.length === 0) {
        batches.push({ depth: batch.depth, status: 'verified' });
      } else {
        batches.push({ depth: batch.depth, status: 'failed', errors: newErrors.slice(0, MAX_ERROR_LINES) });
        break; // later batches depend on this one landing
      }
    }
  } finally {
    try {
      execFileSync('git', ['-C', projectRoot, 'worktree', 'remove', '--force', worktree], { stdio: 'ignore' });
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
  }

  return { checker: checker.label, baselineErrors, dirtyOverlap, batches };
}

/**
 * Position-independent error identity: deletions shift line numbers, so two
 * runs of the same pre-existing error must still match. Exported for tests.
 */
export function errorKey(errorLine: string): string {
  return errorLine.replace(/\(\d+,\d+\)|:\d+(?::\d+)?/g, '').trim();
}

interface Checker {
  label: string;
  binary: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function detectChecker(projectRoot: string): Checker | null {
  if (existsSync(join(projectRoot, 'tsconfig.json'))) {
    const localTsc = join(projectRoot, 'node_modules', '.bin', 'tsc');
    return existsSync(localTsc)
      ? { label: 'tsc --noEmit', binary: localTsc, args: ['--noEmit'] }
      : { label: 'npx tsc --noEmit', binary: 'npx', args: ['tsc', '--noEmit'] };
  }
  if (existsSync(join(projectRoot, 'Cargo.toml'))) {
    return {
      label: 'cargo check --quiet',
      binary: 'cargo',
      args: ['check', '--quiet'],
      // Reuse the project's build cache — a cold target dir takes minutes.
      env: { ...process.env, CARGO_TARGET_DIR: join(projectRoot, 'target') },
    };
  }
  return null;
}

function dirtyPlanFiles(projectRoot: string, plan: CleanupPlanResult): string[] {
  let status: string;
  try {
    status = execFileSync('git', ['-C', projectRoot, 'status', '--porcelain'], { encoding: 'utf-8' });
  } catch {
    return [];
  }
  const dirty = new Set(
    status.split('\n')
      .map((line) => line.slice(3).trim())
      .filter((line) => line !== ''),
  );
  const planFiles = new Set(plan.batches.flatMap((batch) => batch.entries.map((entry) => entry.file)));
  return [...planFiles].filter((file) => dirty.has(file)).sort();
}

/** Worktrees only contain tracked files — link the dependency dirs in. */
function linkUntrackedDeps(projectRoot: string, worktree: string): void {
  for (const dep of ['node_modules']) {
    const source = join(projectRoot, dep);
    const target = join(worktree, dep);
    if (existsSync(source) && !existsSync(target)) {
      try {
        symlinkSync(source, target, 'junction');
      } catch {
        // Verification proceeds; the checker will say if deps are missing.
      }
    }
  }
}

function applyBatchDeletions(worktree: string, batch: CleanupBatch): void {
  const rangesByFile = new Map<string, Array<{ start: number; end: number }>>();
  for (const entry of batch.entries) {
    const bucket = rangesByFile.get(entry.file) ?? [];
    bucket.push({ start: entry.startLine, end: entry.endLine });
    rangesByFile.set(entry.file, bucket);
  }
  for (const [file, ranges] of rangesByFile) {
    const path = join(worktree, file);
    if (!existsSync(path)) continue;
    writeFileSync(path, deleteLineRanges(readFileSync(path, 'utf-8'), ranges));
  }
}

/**
 * Remove inclusive 0-indexed line ranges from content. Exported for tests.
 *
 * Index ranges are sometimes truncated to a declaration's first line; each
 * range is extended downward until brackets balance (measured on
 * comment/string-stripped text) so a deletion never bisects a statement.
 */
export function deleteLineRanges(
  content: string,
  ranges: ReadonlyArray<{ start: number; end: number }>,
): string {
  const lines = content.split('\n');
  const strippedLines = stripCommentsAndStrings(content).split('\n');
  const remove = new Set<number>();
  for (const range of ranges) {
    const end = extendToBalanced(strippedLines, range.start, Math.min(range.end, lines.length - 1));
    for (let line = range.start; line <= end && line < lines.length; line++) {
      remove.add(line);
    }
  }
  return lines.filter((_line, index) => !remove.has(index)).join('\n');
}

const MAX_BALANCE_EXTENSION = 200;

function extendToBalanced(strippedLines: readonly string[], start: number, end: number): number {
  let depth = 0;
  for (let line = start; line < strippedLines.length; line++) {
    for (const char of strippedLines[line] ?? '') {
      if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') depth -= 1;
    }
    if (line >= end && depth <= 0) return line;
    if (line - end > MAX_BALANCE_EXTENSION) break;
  }
  return end;
}

function runChecker(
  checker: Checker,
  worktree: string,
  timeoutMs: number,
): { ok: boolean; rawErrors: string[]; errorKeys: Set<string> } {
  const result = spawnSync(checker.binary, checker.args, {
    cwd: worktree,
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: checker.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status === 0) return { ok: true, rawErrors: [], errorKeys: new Set() };
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const rawErrors = output.split('\n')
    .map((line) => line.trim())
    .filter((line) => /\berror\b/i.test(line));
  if (result.error && rawErrors.length === 0) rawErrors.push(String(result.error));
  return { ok: false, rawErrors, errorKeys: new Set(rawErrors.map(errorKey)) };
}
