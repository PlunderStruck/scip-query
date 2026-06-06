#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const cliPath = join(repoRoot, 'dist', 'cli.js');
const outDir = join(repoRoot, 'reports', 'accuracy');
const stamp = new Date().toISOString().slice(0, 10);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(outDir, `${runId}-generated-real-repo-calibration.md`);

const defaultCases = [
  {
    projectRoot: '/Users/aydansalois/Documents/GitHub/on_main_mvp',
    language: 'typescript',
    symbol: 'confirmBooking',
    file: 'src/domain/booking/booking.ts',
    sourceIncludes: ['export async function confirmBooking', 'ConfirmBookingInput'],
    expectedRefs: ['src/domain/agent/tools/confirm-booking.ts'],
    expectedCallGraph: ['maybeSetConfirmedAtAndReturn', 'ensureBookingStatus', 'loadBookingRowOrThrow'],
    expectedDataflow: ['═══ PRODUCERS', 'maybeSetConfirmedAtAndReturn', 'confirmBookingForCustomer'],
    sliceArgs: ['--forward'],
    expectedSlice: ['forward slice', 'confirmBookingForCustomer', 'confirmWebhookBooking'],
  },
  {
    projectRoot: '/Users/aydansalois/Documents/GitHub/qwen3-tts-apple-silicon',
    language: 'python',
    symbol: 'main_menu',
    file: 'main.py',
    sourceIncludes: ['def main_menu():', 'Voice Cloning'],
    expectedRefs: [],
    expectedCallGraph: ['run_clone_manager', 'run_custom_session'],
    expectedDataflow: ['═══ PRODUCERS', 'run_clone_manager', 'run_custom_session'],
    sliceArgs: [],
    expectedSlice: ['backward slice', 'run_clone_manager', 'run_custom_session'],
  },
  {
    projectRoot: '/Users/aydansalois/Documents/GitHub/SynthRunnerRust',
    language: 'rust',
    symbol: 'main',
    file: 'src/main.rs',
    sourceIncludes: ['fn main()', 'synth_runner_rust::run'],
    expectedRefs: [],
    expectedCallGraph: ['app:run()'],
    expectedDataflow: ['═══ DEFINED AT ═══', 'src/main.rs'],
    sliceArgs: [],
    expectedSlice: ['backward slice of main()', 'No connected symbols found.'],
  },
];

const requestedRoots = process.argv.slice(2).map((entry) => resolve(entry));
const cases = requestedRoots.length > 0
  ? defaultCases.filter((testCase) => requestedRoots.includes(resolve(testCase.projectRoot)))
  : defaultCases;

mkdirSync(outDir, { recursive: true });

const sections = [
  '# Accuracy Calibration',
  '',
  `Date: ${stamp}`,
  '',
  'This report records source-backed real-repository checks. A PASS means the command output was compared against source text and expected graph facts, not merely that the command exited successfully.',
  '',
];

let failures = 0;
let skipped = 0;

for (const testCase of cases) {
  const projectRoot = resolve(testCase.projectRoot);
  sections.push(`## ${basename(projectRoot)}`, '', `Path: \`${projectRoot}\``, '');
  if (!existsSync(projectRoot)) {
    skipped += 1;
    sections.push('SKIP: repository is not present on this machine.', '');
    continue;
  }

  const cacheDir = mkdtempSync(join(tmpdir(), 'scip-query-calibrate-'));
  try {
    const checks = runCase(testCase, projectRoot, cacheDir);
    for (const check of checks) {
      if (!check.pass) failures += 1;
      sections.push(`- ${check.pass ? 'PASS' : 'FAIL'} ${check.name}`);
      if (check.evidence) {
        sections.push('', '```text', check.evidence.trimEnd(), '```');
      }
    }
    sections.push('');
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

sections.push(`Summary: ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failure(s), ${skipped} skipped repo(s))`, '');
writeFileSync(outPath, sections.join('\n'));
console.log(outPath);
if (failures > 0) process.exitCode = 1;

function runCase(testCase, projectRoot, cacheDir) {
  const checks = [];
  const env = {
    ...process.env,
    SCIP_QUERY_PROJECT_ROOT: projectRoot,
    SCIP_QUERY_CACHE_DIR: cacheDir,
  };

  const reindex = run(['reindex', '--force', '--language', testCase.language], projectRoot, env, 180_000);
  checks.push(checkExit('reindex', reindex));
  if (reindex.status !== 0) return checks;
  checks.push(performanceMetadata(cacheDir, { reindex }));

  const source = readFileSync(join(projectRoot, testCase.file), 'utf8');
  checks.push(assertIncludes('source oracle', source, testCase.sourceIncludes));

  const symbols = run(['symbols', testCase.file], projectRoot, env, 60_000);
  checks.push(checkExit('symbols', symbols));
  checks.push(assertIncludes('symbols output', symbols.stdout, [testCase.symbol]));

  const code = run(['code', testCase.symbol], projectRoot, env, 60_000);
  checks.push(checkExit('code', code));
  checks.push(assertIncludes('code output', code.stdout, testCase.sourceIncludes));

  const refs = run(['refs', testCase.symbol], projectRoot, env, 60_000);
  checks.push(checkExit('refs', refs));
  checks.push(assertIncludes('refs output', refs.stdout, testCase.expectedRefs));

  const trace = run(['trace', testCase.symbol], projectRoot, env, 60_000);
  checks.push(checkExit('trace', trace));
  checks.push(assertIncludes('trace output', trace.stdout, ['═══ DEFINITION ═══', testCase.file]));

  const callGraph = run(['call-graph', testCase.symbol], projectRoot, env, 60_000);
  checks.push(checkExit('call-graph', callGraph));
  checks.push(assertIncludes('call-graph output', callGraph.stdout, testCase.expectedCallGraph));

  const complexity = run(['complexity', testCase.symbol], projectRoot, env, 60_000);
  checks.push(checkExit('complexity', complexity));
  checks.push(assertIncludes('complexity output', complexity.stdout, ['Cyclomatic', 'Fan-in', 'Fan-out']));

  const dataflow = run(['dataflow', testCase.symbol], projectRoot, env, 60_000);
  checks.push(checkExit('dataflow', dataflow));
  checks.push(assertIncludes('dataflow output', dataflow.stdout, testCase.expectedDataflow));

  const slice = run(['slice', testCase.symbol, ...(testCase.sliceArgs ?? [])], projectRoot, env, 60_000);
  checks.push(checkExit('slice', slice));
  checks.push(assertIncludes('slice output', slice.stdout, testCase.expectedSlice));
  checks.push(commandDurations({
    symbols,
    code,
    refs,
    trace,
    callGraph,
    complexity,
    dataflow,
    slice,
  }));

  return checks;
}

function run(args, cwd, env, timeout) {
  const startMs = Date.now();
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? '',
    durationMs: Date.now() - startMs,
  };
}

function checkExit(name, result) {
  return {
    name,
    pass: result.status === 0,
    evidence: result.status === 0 ? '' : `${result.stdout}${result.stderr}${result.error}`,
  };
}

function performanceMetadata(cacheDir, commands) {
  return {
    name: 'performance metadata',
    pass: true,
    evidence: [
      `reindex duration: ${commands.reindex.durationMs}ms`,
      `index.scip: ${formatBytes(fileSize(join(cacheDir, 'index.scip')))}`,
      `index.db: ${formatBytes(fileSize(join(cacheDir, 'index.db')))}`,
    ].join('\n'),
  };
}

function commandDurations(commands) {
  return {
    name: 'command durations',
    pass: true,
    evidence: Object.entries(commands)
      .map(([name, result]) => `${name}: ${result.durationMs}ms`)
      .join('\n'),
  };
}

function fileSize(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function assertIncludes(name, text, expectedValues) {
  const missing = expectedValues.filter((value) => !text.includes(value));
  return {
    name,
    pass: missing.length === 0,
    evidence: missing.length === 0
      ? ''
      : `Missing: ${missing.join(', ')}\n\nOutput:\n${text.slice(0, 2_000)}`,
  };
}
