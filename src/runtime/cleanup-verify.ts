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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CleanupBatch, CleanupPlanResult } from '../queries/cleanup/cleanup-plan.js';
import { stripCommentsAndStrings } from '../source/source-stripper.js';

export interface BatchVerification {
  depth: number;
  status: 'verified' | 'failed';
  /** NEW checker errors caused by this batch — they name the missed references. */
  errors?: string[];
}

export interface CleanupVerification {
  /** Human-readable checker invocations, empty when none was detected. */
  checkers: string[];
  /** Plan files no detected checker covers — their entries are NOT verified. */
  uncoveredFiles: string[];
  /**
   * Pre-existing checker errors on the UNMODIFIED tree. When > 0, batches
   * verify differentially: pass = no NEW errors beyond this baseline.
   */
  baselineErrors: number;
  /** Plan files that are dirty in the working tree — verification runs at HEAD. */
  dirtyOverlap: string[];
  batches: BatchVerification[];
}

export interface CleanupVerificationPolicy {
  allowDirty?: boolean;
}

const CHECK_TIMEOUT_MS = 300_000;
const MAX_ERROR_LINES = 12;

export function verifyCleanupPlan(
  projectRoot: string,
  plan: CleanupPlanResult,
  opts: { timeoutMs?: number } = {},
): CleanupVerification {
  const checkers = detectCheckers(projectRoot);
  if (checkers.length === 0) {
    return { checkers: [], uncoveredFiles: [], baselineErrors: 0, dirtyOverlap: [], batches: [] };
  }
  const uncoveredFiles = planFilesWithoutChecker(plan, checkers);

  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const dirtyOverlap = dirtyPlanFiles(projectRoot, plan);
  const worktree = mkdtempSync(join(tmpdir(), 'scip-cleanup-verify-'));
  const batches: BatchVerification[] = [];
  // Differential baseline: many projects don't check clean at the root
  // (workspace tsconfigs, pre-existing errors). Pass = no NEW errors.
  const baselineKeys = new Set<string>();
  try {
    execFileSync('git', ['-C', projectRoot, 'worktree', 'add', '--detach', '--force', worktree, 'HEAD'], {
      stdio: 'ignore',
    });
    linkUntrackedDeps(projectRoot, worktree);

    for (const checker of checkers) {
      for (const key of runChecker(checker, worktree, timeoutMs).errorKeys) {
        baselineKeys.add(key);
      }
    }

    for (const batch of plan.batches) {
      applyBatchDeletions(worktree, batch);
      const newErrors: string[] = [];
      for (const checker of checkers) {
        const result = runChecker(checker, worktree, timeoutMs);
        newErrors.push(...result.rawErrors.filter((error) =>
          !baselineKeys.has(errorKey(error))));
      }
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

  return {
    checkers: checkers.map((checker) => checker.label),
    uncoveredFiles,
    baselineErrors: baselineKeys.size,
    dirtyOverlap,
    batches,
  };
}

/** Plan files whose extension no detected checker examines. */
function planFilesWithoutChecker(plan: CleanupPlanResult, checkers: Checker[]): string[] {
  const covered = new Set(checkers.flatMap((checker) => checker.coversExtensions));
  const files = new Set(plan.batches.flatMap((batch) => batch.entries.map((entry) => entry.file)));
  return [...files].filter((file) => {
    const extension = file.slice(file.lastIndexOf('.'));
    return !covered.has(extension);
  }).sort();
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
  coversExtensions: string[];
  env?: NodeJS.ProcessEnv;
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.vue'];

/** Detect every applicable checker — mixed-language repos need all of them. Exported for tests. */
export function detectCheckers(projectRoot: string): Checker[] {
  const checkers: Checker[] = [];
  if (existsSync(join(projectRoot, 'tsconfig.json'))) {
    const localTsc = join(projectRoot, 'node_modules', '.bin', 'tsc');
    checkers.push(existsSync(localTsc)
      ? { label: 'tsc --noEmit', binary: localTsc, args: ['--noEmit'], coversExtensions: TS_EXTENSIONS }
      : { label: 'npx tsc --noEmit', binary: 'npx', args: ['tsc', '--noEmit'], coversExtensions: TS_EXTENSIONS });
  }
  if (existsSync(join(projectRoot, 'go.mod'))) {
    checkers.push({
      label: 'go build ./...',
      binary: 'go',
      args: ['build', './...'],
      coversExtensions: ['.go'],
    });
  }
  if (['pyproject.toml', 'setup.py', 'requirements.txt'].some((marker) => existsSync(join(projectRoot, marker)))) {
    const pythonChecker = detectPythonChecker();
    if (pythonChecker) checkers.push(pythonChecker);
  }
  for (const manifest of findCargoManifests(projectRoot)) {
    checkers.push({
      label: `cargo check --quiet --manifest-path ${manifest}`,
      binary: 'cargo',
      args: ['check', '--quiet', '--manifest-path', manifest],
      coversExtensions: ['.rs'],
      // Reuse the project's build cache — a cold target dir takes minutes.
      env: {
        ...process.env,
        CARGO_TARGET_DIR: join(projectRoot, manifest, '..', 'target'),
      },
    });
  }
  return checkers;
}

/**
 * Python deletion oracle: ruff's undefined-name checks (F821/F822) catch
 * exactly what deleting a symbol breaks in a dynamic language; syntax-only
 * compileall is the fallback (catches bisected statements, not dead names).
 */
function detectPythonChecker(): Checker | null {
  if (binaryAvailable('ruff')) {
    return {
      label: 'ruff check --select E9,F821,F822',
      binary: 'ruff',
      args: ['check', '--quiet', '--select', 'E9,F821,F822', '.'],
      coversExtensions: ['.py'],
    };
  }
  if (binaryAvailable('python3')) {
    return {
      label: 'python3 -m compileall (syntax only)',
      binary: 'python3',
      args: ['-m', 'compileall', '-q', '.'],
      coversExtensions: ['.py'],
    };
  }
  return null;
}

function binaryAvailable(binary: string): boolean {
  try {
    return spawnSync(binary, ['--version'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

/** Cargo.toml at the root or one level down (src-tauri/, backend/, ...). */
function findCargoManifests(projectRoot: string): string[] {
  const manifests: string[] = [];
  if (existsSync(join(projectRoot, 'Cargo.toml'))) {
    manifests.push('Cargo.toml');
    return manifests; // root workspace covers members
  }
  let entries: string[];
  try {
    entries = readdirSync(projectRoot);
  } catch {
    return manifests;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    if (existsSync(join(projectRoot, entry, 'Cargo.toml'))) {
      manifests.push(`${entry}/Cargo.toml`);
    }
  }
  return manifests;
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
    writeFileSync(path, deleteLineRanges(readFileSync(path, 'utf-8'), ranges, { rust: file.endsWith('.rs') }));
  }
}

export function applyCleanupBatches(projectRoot: string, batches: readonly CleanupBatch[]): void {
  for (const batch of batches) applyBatchDeletions(projectRoot, batch);
}

export function createCleanupPatch(
  projectRoot: string,
  batches: readonly CleanupBatch[],
): string {
  const worktree = mkdtempSync(join(tmpdir(), 'scip-cleanup-patch-'));
  try {
    execFileSync('git', ['-C', projectRoot, 'worktree', 'add', '--detach', '--force', worktree, 'HEAD'], {
      stdio: 'ignore',
    });
    applyCleanupBatches(worktree, batches);
    return execFileSync('git', ['-C', worktree, 'diff', '--binary'], {
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } finally {
    try {
      execFileSync('git', ['-C', projectRoot, 'worktree', 'remove', '--force', worktree], { stdio: 'ignore' });
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
  }
}

export function selectCleanupBatches(
  plan: CleanupPlanResult,
  opts: { batch?: number; all?: boolean } = {},
): CleanupBatch[] {
  if (opts.all) return [...plan.batches];
  if (opts.batch !== undefined) {
    const batch = plan.batches.find((candidate) => candidate.depth === opts.batch);
    return batch ? [batch] : [];
  }
  return [...plan.batches];
}

export function cleanupVerificationFailures(
  verification: CleanupVerification,
  selectedBatches: readonly CleanupBatch[],
  policy: CleanupVerificationPolicy = {},
): string[] {
  const failures: string[] = [];
  if (verification.checkers.length === 0) {
    failures.push('No project checker was detected, so no deletion patch is compiler-verified.');
  }
  if (verification.uncoveredFiles.length > 0) {
    failures.push(`No detected checker covers: ${verification.uncoveredFiles.join(', ')}.`);
  }
  if (!policy.allowDirty && verification.dirtyOverlap.length > 0) {
    failures.push(`Plan files are dirty in the working tree: ${verification.dirtyOverlap.join(', ')}.`);
  }

  const verifiedDepths = new Set(
    verification.batches
      .filter((batch) => batch.status === 'verified')
      .map((batch) => batch.depth),
  );
  for (const batch of selectedBatches) {
    if (!verifiedDepths.has(batch.depth)) {
      failures.push(`Batch ${batch.depth} is not compiler-verified.`);
    }
  }
  return failures;
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
  opts: { rust?: boolean } = {},
): string {
  const lines = content.split('\n');
  // Rust lifetimes ('a) look like unterminated char literals to the generic
  // masker, corrupting bracket counts — use a quote-aware Rust variant.
  const strippedLines = (opts.rust === true
    ? stripRustCommentsAndStrings(content)
    : stripCommentsAndStrings(content)
  ).split('\n');
  const remove = new Set<number>();
  for (const range of ranges) {
    const start = extendOverLeadingDocLines(lines, range.start);
    const end = extendToBalanced(strippedLines, start, Math.min(range.end, lines.length - 1));
    for (let line = start; line <= end && line < lines.length; line++) {
      remove.add(line);
    }
  }
  return lines.filter((_line, index) => !remove.has(index)).join('\n');
}

/** Mask comments and double-quoted strings only — single quotes stay (lifetimes). */
function stripRustCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\/.*$/gm, (segment) => segment.replace(/[^\r\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (segment) => segment.replace(/[^\r\n]/g, ' '))
    .replace(/"(?:\\.|[^"\\\r\n])*"/g, (segment) => segment.replace(/[^\r\n]/g, ' '));
}

/**
 * Deleting an item must take its attached doc comments and attributes with
 * it — an orphaned `///` above a removed item is a syntax error in Rust
 * ("expected item after doc comment").
 */
function extendOverLeadingDocLines(lines: readonly string[], start: number): number {
  let line = start;
  while (line > 0) {
    const above = (lines[line - 1] ?? '').trim();
    if (/^(?:\/\/\/|\/\/!|#\[|#!\[|\/\*\*|\*|\*\/|@\w)/.test(above)) {
      line -= 1;
    } else {
      break;
    }
  }
  return line;
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
