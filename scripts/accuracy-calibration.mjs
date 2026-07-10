#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CALIBRATION_SCHEMA_VERSION,
  applyVerdictGroups,
  deterministicSample,
  normalizeDeadCandidate,
  summarizeCalibration,
} from './accuracy-calibration-core.mjs';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const cliPath = join(repoRoot, 'dist', 'cli.js');
const outDir = join(repoRoot, 'reports', 'accuracy');
const stamp = new Date().toISOString().slice(0, 10);
const runId = new Date().toISOString().replace(/[:.]/g, '-');

const navigationCases = [
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

const defaultDeadRepos = [
  '/Users/aydansalois/Documents/GitHub/Vega_2.0',
  '/Users/aydansalois/Documents/GitHub/openwork',
  '/Users/aydansalois/Documents/GitHub/Stable_Management',
  '/Users/aydansalois/Documents/GitHub/traceroot',
];

mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
if (args[0] === 'health-dead') {
  runHealthDeadMode(args.slice(1));
} else if (args[0] === 'summarize') {
  runSummarizeMode(args.slice(1));
} else if (args[0] === 'resample') {
  runResampleMode(args.slice(1));
} else {
  runNavigationMode(args);
}

function runResampleMode(rawArgs) {
  const [packetArg, sampleSizeArg = '25'] = rawArgs;
  if (!packetArg) throw new Error('resample requires <packet.json> [sample-size]');
  const sampleSize = Number(sampleSizeArg);
  if (!Number.isInteger(sampleSize) || sampleSize < 1) throw new Error('sample-size must be a positive integer');
  const packet = JSON.parse(readFileSync(resolve(packetArg), 'utf8'));
  if (packet.schemaVersion !== CALIBRATION_SCHEMA_VERSION) {
    throw new Error(`unsupported calibration packet schema: ${packet.schemaVersion}`);
  }

  const rows = [];
  for (const repository of packet.repositories) {
    const candidates = packet.rows.filter((row) => row.repository === repository.repository);
    rows.push(
      ...deterministicSample(
        candidates,
        Math.min(sampleSize, candidates.length),
        `${packet.seed}:${repository.repository}`,
      ),
    );
  }
  const resampled = {
    ...packet,
    generatedAt: new Date().toISOString(),
    sampleSizePerRepository: sampleSize,
    repositories: packet.repositories.map((repository) => ({
      ...repository,
      sampled: Math.min(sampleSize, packet.rows.filter((row) => row.repository === repository.repository).length),
    })),
    rows,
    summary: summarizeCalibration(rows),
  };
  const baseName = `${runId}-${packet.language}-${packet.detector}-resampled`;
  const jsonPath = join(outDir, `${baseName}.json`);
  const markdownPath = join(outDir, `${baseName}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(resampled, null, 2)}\n`);
  writeFileSync(markdownPath, renderDeadPacket(resampled));
  console.log(jsonPath);
  console.log(markdownPath);
}

function runSummarizeMode(rawArgs) {
  const [packetArg, verdictArg] = rawArgs;
  if (!packetArg || !verdictArg) throw new Error('summarize requires <packet.json> <verdicts.json>');
  const packet = JSON.parse(readFileSync(resolve(packetArg), 'utf8'));
  const verdicts = JSON.parse(readFileSync(resolve(verdictArg), 'utf8'));
  if (packet.schemaVersion !== CALIBRATION_SCHEMA_VERSION) {
    throw new Error(`unsupported calibration packet schema: ${packet.schemaVersion}`);
  }
  const rows = applyVerdictGroups(packet.rows, verdicts.groups ?? []);
  const reviewed = {
    ...packet,
    reviewedAt: new Date().toISOString(),
    verdictSource: resolve(verdictArg),
    rows,
    summary: summarizeCalibration(rows, {
      knownPositiveRecallCases: verdicts.knownPositiveRecallCases ?? 0,
    }),
  };
  const baseName = `${runId}-${packet.language}-${packet.detector}-reviewed`;
  const jsonPath = join(outDir, `${baseName}.json`);
  const markdownPath = join(outDir, `${baseName}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(reviewed, null, 2)}\n`);
  writeFileSync(markdownPath, renderDeadPacket(reviewed));
  console.log(jsonPath);
  console.log(markdownPath);
}

function runNavigationMode(rawRoots) {
  const requestedRoots = rawRoots.map((entry) => resolve(entry));
  const cases =
    requestedRoots.length > 0
      ? navigationCases.filter((testCase) => requestedRoots.includes(resolve(testCase.projectRoot)))
      : navigationCases;
  const outPath = join(outDir, `${runId}-generated-real-repo-calibration.md`);
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
      const checks = runNavigationCase(testCase, projectRoot, cacheDir);
      for (const check of checks) {
        if (!check.pass) failures += 1;
        sections.push(`- ${check.pass ? 'PASS' : 'FAIL'} ${check.name}`);
        if (check.evidence) sections.push('', '```text', check.evidence.trimEnd(), '```');
      }
      sections.push('');
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }

  sections.push(
    `Summary: ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failure(s), ${skipped} skipped repo(s))`,
    '',
  );
  writeFileSync(outPath, sections.join('\n'));
  console.log(outPath);
  if (failures > 0) process.exitCode = 1;
}

function runHealthDeadMode(rawArgs) {
  const options = parseHealthDeadArgs(rawArgs);
  const rows = [];
  const repositories = [];
  let failures = 0;

  for (const sourceRoot of options.roots) {
    const repository = basename(sourceRoot);
    if (!existsSync(join(sourceRoot, '.git'))) {
      failures += 1;
      repositories.push({ repository, sourceRoot, error: 'repository is missing or is not a Git checkout' });
      continue;
    }

    const isolated = createDetachedWorktree(sourceRoot);
    const cacheDir = mkdtempSync(join(tmpdir(), 'scip-query-health-calibrate-'));
    try {
      const env = {
        ...process.env,
        SCIP_QUERY_PROJECT_ROOT: isolated.root,
        SCIP_QUERY_CACHE_DIR: cacheDir,
        SCIP_QUERY_SKIP_WATCH_SERVICE: '1',
      };
      const reindex = runCli(['reindex', '--force', '--language', 'typescript'], isolated.root, env, 300_000);
      if (reindex.status !== 0) {
        failures += 1;
        repositories.push({
          repository,
          sourceRoot,
          commit: isolated.commit,
          error: commandError('reindex', reindex),
        });
        continue;
      }

      const status = runCli(['status', '--capabilities', '--json'], isolated.root, env, 60_000);
      const dead = runCli(['dead', '--full', '--json'], isolated.root, env, 300_000);
      if (status.status !== 0 || dead.status !== 0) {
        failures += 1;
        repositories.push({
          repository,
          sourceRoot,
          commit: isolated.commit,
          reindexDurationMs: reindex.durationMs,
          error: status.status !== 0 ? commandError('status', status) : commandError('dead', dead),
        });
        continue;
      }

      const statusEnvelope = parseEnvelope(status.stdout, 'status');
      const deadEnvelope = parseEnvelope(dead.stdout, 'dead');
      const capability = statusEnvelope.result.capabilities?.matrix?.find((entry) => entry.language === 'typescript');
      const candidates = (deadEnvelope.result.symbols ?? []).filter((candidate) => candidate.kind === 'dead-code');
      const normalized = candidates.map((candidate) =>
        normalizeDeadCandidate(candidate, {
          language: 'typescript',
          repository,
          commit: isolated.commit,
          evidence: deadEnvelope.evidence,
          capabilityStatus: capability ?? null,
          sourceExcerpt: (entry) => sourceExcerpt(isolated.root, entry.relativePath, entry.startLine, entry.endLine),
        }),
      );
      const sampled = deterministicSample(
        normalized,
        Math.min(options.sampleSize, normalized.length),
        `${options.seed}:${repository}`,
      );
      rows.push(...sampled);
      repositories.push({
        repository,
        sourceRoot,
        commit: isolated.commit,
        language: 'typescript',
        capability: capability ?? null,
        reindexDurationMs: reindex.durationMs,
        deadDurationMs: dead.durationMs,
        totalDeadCandidates: candidates.length,
        sampled: sampled.length,
      });
    } catch (error) {
      failures += 1;
      repositories.push({ repository, sourceRoot, commit: isolated.commit, error: errorMessage(error) });
    } finally {
      isolated.remove();
      rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  const packet = {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    detector: 'dead',
    language: 'typescript',
    truthRule:
      'No production, public API, framework, generated, reflective, configured, or test-required consumer exists; certified deletion additionally requires an applicable checker.',
    seed: options.seed,
    sampleSizePerRepository: options.sampleSize,
    repositories,
    rows,
    summary: summarizeCalibration(rows),
  };
  const baseName = `${runId}-typescript-dead-calibration`;
  const jsonPath = join(outDir, `${baseName}.json`);
  const markdownPath = join(outDir, `${baseName}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(packet, null, 2)}\n`);
  writeFileSync(markdownPath, renderDeadPacket(packet));
  console.log(jsonPath);
  console.log(markdownPath);
  if (failures > 0) process.exitCode = 1;
}

function parseHealthDeadArgs(rawArgs) {
  let sampleSize = 25;
  let seed = 'typescript-dead-v1';
  const roots = [];
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === '--sample-size') {
      const value = Number(rawArgs[index + 1]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--sample-size must be a positive integer');
      sampleSize = value;
      index += 1;
    } else if (arg === '--seed') {
      const value = rawArgs[index + 1];
      if (!value) throw new Error('--seed requires a value');
      seed = value;
      index += 1;
    } else {
      roots.push(resolve(arg));
    }
  }
  return { sampleSize, seed, roots: roots.length > 0 ? roots : defaultDeadRepos };
}

function createDetachedWorktree(sourceRoot) {
  const root = mkdtempSync(join(tmpdir(), `scip-query-${basename(sourceRoot)}-`));
  const add = runProcess('git', ['worktree', 'add', '--detach', root, 'HEAD'], sourceRoot, 120_000);
  if (add.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(commandError('git worktree add', add));
  }
  const commit = runProcess('git', ['rev-parse', 'HEAD'], root, 30_000).stdout.trim();
  const sourceNodeModules = join(sourceRoot, 'node_modules');
  const worktreeNodeModules = join(root, 'node_modules');
  if (existsSync(sourceNodeModules) && !existsSync(worktreeNodeModules)) {
    symlinkSync(sourceNodeModules, worktreeNodeModules, 'dir');
  }
  return {
    root,
    commit,
    remove() {
      const removed = runProcess('git', ['worktree', 'remove', '--force', root], sourceRoot, 120_000);
      if (removed.status !== 0) rmSync(root, { recursive: true, force: true });
    },
  };
}

function runNavigationCase(testCase, projectRoot, cacheDir) {
  const checks = [];
  const env = { ...process.env, SCIP_QUERY_PROJECT_ROOT: projectRoot, SCIP_QUERY_CACHE_DIR: cacheDir };
  env.SCIP_QUERY_SKIP_WATCH_SERVICE = '1';
  const reindex = runCli(['reindex', '--force', '--language', testCase.language], projectRoot, env, 180_000);
  checks.push(checkExit('reindex', reindex));
  if (reindex.status !== 0) return checks;
  checks.push(performanceMetadata(cacheDir, { reindex }));

  const source = readFileSync(join(projectRoot, testCase.file), 'utf8');
  checks.push(assertIncludes('source oracle', source, testCase.sourceIncludes));
  const commands = {
    symbols: runCli(['symbols', testCase.file], projectRoot, env, 60_000),
    code: runCli(['code', testCase.symbol], projectRoot, env, 60_000),
    refs: runCli(['refs', testCase.symbol], projectRoot, env, 60_000),
    trace: runCli(['trace', testCase.symbol], projectRoot, env, 60_000),
    callGraph: runCli(['call-graph', testCase.symbol], projectRoot, env, 60_000),
    complexity: runCli(['complexity', testCase.symbol], projectRoot, env, 60_000),
    dataflow: runCli(['dataflow', testCase.symbol], projectRoot, env, 60_000),
    slice: runCli(['slice', testCase.symbol, ...(testCase.sliceArgs ?? [])], projectRoot, env, 60_000),
  };
  for (const [name, result] of Object.entries(commands)) checks.push(checkExit(name, result));
  checks.push(assertIncludes('symbols output', commands.symbols.stdout, [testCase.symbol]));
  checks.push(assertIncludes('code output', commands.code.stdout, testCase.sourceIncludes));
  checks.push(assertIncludes('refs output', commands.refs.stdout, testCase.expectedRefs));
  checks.push(assertIncludes('trace output', commands.trace.stdout, ['═══ DEFINITION ═══', testCase.file]));
  checks.push(assertIncludes('call-graph output', commands.callGraph.stdout, testCase.expectedCallGraph));
  checks.push(assertIncludes('complexity output', commands.complexity.stdout, ['Cyclomatic', 'Fan-in', 'Fan-out']));
  checks.push(assertIncludes('dataflow output', commands.dataflow.stdout, testCase.expectedDataflow));
  checks.push(assertIncludes('slice output', commands.slice.stdout, testCase.expectedSlice));
  checks.push(commandDurations(commands));
  return checks;
}

function runCli(args, cwd, env, timeout) {
  const startMs = Date.now();
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return processResult(result, startMs);
}

function runProcess(command, args, cwd, timeout) {
  const startMs = Date.now();
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  return processResult(result, startMs);
}

function processResult(result, startMs) {
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? '',
    durationMs: Date.now() - startMs,
  };
}

function parseEnvelope(text, command) {
  try {
    const envelope = JSON.parse(text);
    if (!envelope || envelope.command !== command || typeof envelope.result !== 'object') {
      throw new Error(`unexpected ${command} envelope`);
    }
    return envelope;
  } catch (error) {
    throw new Error(`could not parse ${command} JSON: ${errorMessage(error)}`);
  }
}

function sourceExcerpt(projectRoot, relativePath, startLine, endLine) {
  const path = join(projectRoot, relativePath);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n');
  const from = Math.max(0, startLine - 3);
  const to = Math.min(lines.length, Math.max(endLine + 2, startLine + 4));
  return lines
    .slice(from, to)
    .map((line, index) => `${String(from + index + 1).padStart(5)} | ${line}`)
    .join('\n');
}

function renderDeadPacket(packet) {
  const lines = [
    '# TypeScript Dead-Code Calibration Packet',
    '',
    `Generated: ${packet.generatedAt}`,
    `Schema: ${packet.schemaVersion}`,
    `Seed: \`${packet.seed}\``,
    '',
    'Truth rule:',
    '',
    `> ${packet.truthRule}`,
    '',
    '## Repository Inventory',
    '',
    '| Repository | Commit | Candidates | Sampled | TypeScript semantic | Error |',
    '| --- | --- | ---: | ---: | --- | --- |',
  ];
  for (const repo of packet.repositories) {
    lines.push(
      `| ${repo.repository} | ${repo.commit ?? '-'} | ${repo.totalDeadCandidates ?? '-'} | ${repo.sampled ?? '-'} | ${repo.capability?.semantic?.status ?? '-'} | ${escapeTable(repo.error ?? '')} |`,
    );
  }
  lines.push('', '## Current Summary', '', '```json', JSON.stringify(packet.summary, null, 2), '```', '');
  for (const [index, row] of packet.rows.entries()) {
    lines.push(
      `## ${index + 1}. ${row.repository}: ${row.shortName}`,
      '',
      `- Calibration ID: \`${row.calibrationId}\``,
      `- Commit: \`${row.commit}\``,
      `- Location: \`${row.relativePath}:${row.startLine + 1}-${row.endLine + 1}\``,
      `- Evidence: ${row.evidence}`,
      `- Verdict: **${row.verdict?.toUpperCase() ?? 'PENDING'}**`,
      `- Noise archetype: ${row.noiseArchetype ?? '-'}`,
      `- Evidence note: ${row.evidenceNote ?? '-'}`,
      '',
      '````text',
      row.sourceExcerpt ?? '(source unavailable)',
      '````',
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

function escapeTable(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function checkExit(name, result) {
  return { name, pass: result.status === 0, evidence: result.status === 0 ? '' : commandError(name, result) };
}

function commandError(name, result) {
  return `${name} failed (${result.status}):\n${result.stdout}${result.stderr}${result.error}`.trim();
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
    evidence: missing.length === 0 ? '' : `Missing: ${missing.join(', ')}\n\nOutput:\n${text.slice(0, 2_000)}`,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
