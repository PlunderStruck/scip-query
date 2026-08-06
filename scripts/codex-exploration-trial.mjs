#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateExplorationTrial, validateExplorationBenchmarkDefinition } from './exploration-benchmark-core.mjs';
import { controlPrompt, parseCodexJsonl, treatmentPrompt } from './codex-exploration-trial-core.mjs';

const options = parseArgs(process.argv.slice(2));
const definition = validateExplorationBenchmarkDefinition(readJson(options.definition));
const prompt = options.mode === 'treatment' ? treatmentPrompt(definition.question) : controlPrompt(definition.question);
const sessionId = `benchmark-${definition.id}-${options.mode}-${randomUUID()}`;
const startedAt = Date.now();

const args = [
  'exec',
  '--ephemeral',
  '--json',
  '--ignore-user-config',
  '--ignore-rules',
  '-c',
  'project_doc_max_bytes=0',
  '-m',
  options.model,
  '-c',
  `model_reasoning_effort=${JSON.stringify(options.reasoning)}`,
  '-s',
  'danger-full-access',
  '-C',
  options.repo,
  '-',
];

const child = spawn('codex', args, {
  cwd: options.repo,
  env: { ...process.env, SCIP_QUERY_SESSION: sessionId },
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
  process.stderr.write(chunk);
});
child.stdin.end(prompt);

child.on('error', fail);
child.on('close', (code, signal) => {
  try {
    if (code !== 0) throw new Error(`codex exited ${String(code)}${signal ? ` from ${signal}` : ''}`);
    const trial = parseCodexJsonl(stdout, {
      benchmarkId: definition.id,
      mode: options.mode,
      model: options.model,
      reasoningEffort: options.reasoning,
      repository: options.repo,
      sessionId,
      durationMs: Date.now() - startedAt,
      stderrCharacters: stderr.length,
    });
    const evaluation = evaluateExplorationTrial(definition, trial);
    const artifact = { trial, evaluation };
    writeFileSync(options.output, `${JSON.stringify(artifact, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  } catch (error) {
    fail(error);
  }
});

function parseArgs(args) {
  const [definition, mode, ...rest] = args;
  if (!definition || !['treatment', 'control'].includes(mode)) usage();
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!['--repo', '--output', '--model', '--reasoning'].includes(flag) || value === undefined) usage();
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
  };
}

function usage() {
  process.stderr.write(
    'Usage: node scripts/codex-exploration-trial.mjs <definition.json> <treatment|control> --repo <path> --output <path> [--model <model>] [--reasoning <effort>]\n',
  );
  process.exit(2);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fail(error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
