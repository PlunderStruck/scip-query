#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createExplorationSandbox } from './codex-exploration-sandbox.mjs';
import { evaluateExplorationTrial, validateExplorationBenchmarkDefinition } from './exploration-benchmark-core.mjs';
import {
  controlPrompt,
  disciplinedControlPrompt,
  minimalTreatmentPrompt,
  parseCodexJsonl,
  treatmentPrompt,
} from './codex-exploration-trial-core.mjs';

const MODES = new Set(['treatment', 'treatment-minimal', 'control', 'control-disciplined']);
const ISOLATION_MODES = new Set(['detached', 'live']);

main().catch(fail);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const definition = validateExplorationBenchmarkDefinition(readJson(options.definition));
  const prompt = promptForMode(options.mode, definition.question);
  const sessionId = `benchmark-${definition.id}-${options.mode}-${randomUUID()}`;
  const sandbox =
    options.isolation === 'detached'
      ? createExplorationSandbox(options.repo, { ref: options.ref })
      : liveRepository(options.repo);
  let indexSetup = null;
  let artifact;

  try {
    const environment = benchmarkEnvironment(sandbox, sessionId);
    if (isTreatment(options.mode) && sandbox.kind === 'detached-worktree') {
      indexSetup = await prepareTreatmentIndex(sandbox.repository, environment);
    }

    const startedAt = Date.now();
    const execution = await runCodex({
      repository: sandbox.repository,
      environment,
      model: options.model,
      reasoning: options.reasoning,
      prompt,
    });
    const trial = parseCodexJsonl(execution.stdout, {
      benchmarkId: definition.id,
      mode: options.mode,
      model: options.model,
      reasoningEffort: options.reasoning,
      repository: sandbox.sourceRepository,
      observedRepository: sandbox.repository,
      observedCommit: sandbox.commit,
      sessionId,
      durationMs: Date.now() - startedAt,
      stderrCharacters: execution.stderr.length,
    });
    const evaluation = evaluateExplorationTrial(definition, trial);
    artifact = {
      trial,
      evaluation,
      isolation: {
        kind: sandbox.kind,
        sourceRepository: sandbox.sourceRepository,
        observedCommit: sandbox.commit,
        indexPrepared: indexSetup !== null,
        indexDurationMs: indexSetup?.durationMs ?? null,
        cleaned: sandbox.kind === 'live-repository',
      },
    };
  } finally {
    sandbox.remove();
  }

  artifact.isolation.cleaned = true;
  writeFileSync(options.output, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

function parseArgs(args) {
  const [definition, mode, ...rest] = args;
  if (!definition || !MODES.has(mode)) usage();
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!['--repo', '--output', '--model', '--reasoning', '--isolation', '--ref'].includes(flag) || value === undefined)
      usage();
    values.set(flag, value);
  }
  const repo = values.get('--repo');
  const output = values.get('--output');
  if (!repo || !output) usage();
  return {
    definition: resolve(definition),
    mode,
    repo: resolve(repo),
    output: resolve(output),
    model: values.get('--model') ?? 'gpt-5.6-luna',
    reasoning: values.get('--reasoning') ?? 'max',
    isolation: isolationMode(values.get('--isolation')),
    ref: values.get('--ref') ?? 'HEAD',
  };
}

function usage() {
  process.stderr.write(
    'Usage: node scripts/codex-exploration-trial.mjs <definition.json> <treatment|treatment-minimal|control|control-disciplined> --repo <path> --output <path> [--model <model>] [--reasoning <effort>] [--isolation <detached|live>] [--ref <git-ref>]\n',
  );
  process.exit(2);
}

function promptForMode(mode, question) {
  switch (mode) {
    case 'treatment':
      return treatmentPrompt(question);
    case 'treatment-minimal':
      return minimalTreatmentPrompt(question);
    case 'control':
      return controlPrompt(question);
    case 'control-disciplined':
      return disciplinedControlPrompt(question);
    default:
      throw new Error(`unsupported benchmark mode: ${mode}`);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fail(error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function isolationMode(value) {
  const mode = value ?? 'detached';
  if (!ISOLATION_MODES.has(mode)) usage();
  return mode;
}

function isTreatment(mode) {
  return mode === 'treatment' || mode === 'treatment-minimal';
}

function liveRepository(repository) {
  return {
    kind: 'live-repository',
    sourceRepository: repository,
    repository,
    cacheDir: null,
    commit: null,
    remove() {},
  };
}

function benchmarkEnvironment(sandbox, sessionId) {
  return {
    ...process.env,
    SCIP_QUERY_SESSION: sessionId,
    SCIP_QUERY_PROJECT_ROOT: sandbox.repository,
    SCIP_QUERY_SKIP_WATCH_SERVICE: '1',
    ...(sandbox.cacheDir ? { SCIP_QUERY_CACHE_DIR: sandbox.cacheDir } : {}),
  };
}

async function prepareTreatmentIndex(repository, environment) {
  const startedAt = Date.now();
  const execution = await runProcess('scip-query', ['reindex', '--force'], {
    cwd: repository,
    env: environment,
    forwardStderr: true,
  });
  return { durationMs: Date.now() - startedAt, stderrCharacters: execution.stderr.length };
}

function runCodex({ repository, environment, model, reasoning, prompt }) {
  const args = [
    'exec',
    '--ephemeral',
    '--json',
    '--ignore-user-config',
    '--ignore-rules',
    '-c',
    'project_doc_max_bytes=0',
    '-m',
    model,
    '-c',
    `model_reasoning_effort=${JSON.stringify(reasoning)}`,
    '-s',
    'danger-full-access',
    '-C',
    repository,
    '-',
  ];
  return runProcess('codex', args, {
    cwd: repository,
    env: environment,
    input: prompt,
    forwardStderr: true,
  });
}

function runProcess(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (options.forwardStderr) process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${command} exited ${String(code)}${signal ? ` from ${signal}` : ''}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });
}
