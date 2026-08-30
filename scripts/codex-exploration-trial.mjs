#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExplorationSandbox } from './codex-exploration-sandbox.mjs';
import { evaluateExplorationTrial, validateExplorationBenchmarkDefinition } from './exploration-benchmark-core.mjs';
import {
  codexExplorationExecArgs,
  combineCodexPhases,
  controlPrompt,
  directGraphTreatmentPrompt,
  disciplinedControlPrompt,
  externalLedgerExplorationPrompt,
  externalLedgerSynthesisPrompt,
  minimalTreatmentPrompt,
  parseCodexJsonl,
  parseExternalLedgerSignal,
  pathWithoutExecutable,
  treatmentPrompt,
} from './codex-exploration-trial-core.mjs';

const MODES = new Set([
  'treatment',
  'treatment-direct',
  'treatment-minimal',
  'treatment-ledger',
  'control',
  'control-disciplined',
]);
const ISOLATION_MODES = new Set(['detached', 'live']);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

main().catch(fail);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const definition = validateExplorationBenchmarkDefinition(readJson(options.definition));
  const sessionId = `benchmark-${definition.id}-${options.mode}-${randomUUID()}`;
  const externalState = options.mode === 'treatment-ledger' ? createExternalEvidenceState() : null;
  const sandbox =
    options.isolation === 'detached'
      ? createExplorationSandbox(options.repo, { ref: options.ref })
      : liveRepository(options.repo);
  let cli;
  let indexSetup = null;
  let artifact;

  try {
    cli = isTreatment(options.mode) ? createCliShim(options.cli) : null;
    const environment = benchmarkEnvironment(sandbox, sessionId, cli?.directory ?? null, externalState);
    if (isTreatment(options.mode) && sandbox.kind === 'detached-worktree') {
      indexSetup = await prepareTreatmentIndex(sandbox.repository, environment);
    }

    const completed = await executeBenchmarkMode({
      definition,
      options,
      sandbox,
      environment,
      sessionId,
      externalState,
    });
    const trial = completed.trial;
    const evaluation = evaluateExplorationTrial(definition, trial);
    artifact = {
      trial,
      evaluation,
      ...(completed.externalEvidence ? { externalEvidence: completed.externalEvidence } : {}),
      isolation: {
        kind: sandbox.kind,
        sourceRepository: sandbox.sourceRepository,
        observedCommit: sandbox.commit,
        indexPrepared: indexSetup !== null,
        indexDurationMs: indexSetup?.durationMs ?? null,
        agentGuidancePrepared: indexSetup?.agentGuidancePrepared ?? false,
        cleaned: sandbox.kind === 'live-repository',
      },
      tool: {
        available: cli !== null,
        cliPath: cli?.path ?? null,
        cliSha256: cli?.sha256 ?? null,
        pathIsolation: cli === null ? 'scip-query-executable-directories-removed' : 'treatment-shim-prepended',
      },
    };
  } finally {
    try {
      sandbox.remove();
    } finally {
      try {
        cli?.remove();
      } finally {
        externalState?.remove();
      }
    }
  }

  artifact.isolation.cleaned = true;
  writeFileSync(options.output, `${JSON.stringify(artifact, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

async function executeBenchmarkMode({ definition, options, sandbox, environment, sessionId, externalState }) {
  const metadata = {
    benchmarkId: definition.id,
    mode: options.mode,
    model: options.model,
    reasoningEffort: options.reasoning,
    repository: sandbox.sourceRepository,
    observedRepository: sandbox.repository,
    observedCommit: sandbox.commit,
    sessionId,
  };
  const startedAt = Date.now();
  if (externalState === null) {
    const execution = await runCodex({
      repository: sandbox.repository,
      environment,
      model: options.model,
      reasoning: options.reasoning,
      prompt: promptForMode(options.mode, definition),
    });
    return {
      trial: parseCodexJsonl(execution.stdout, {
        ...metadata,
        durationMs: Date.now() - startedAt,
        stderrCharacters: execution.stderr.length,
      }),
    };
  }

  const explorationStartedAt = Date.now();
  const explorationExecution = await runCodex({
    repository: sandbox.repository,
    environment,
    model: options.model,
    reasoning: options.reasoning,
    prompt: externalLedgerExplorationPrompt(definition.question, externalState.ledgerPath),
  });
  const exploration = parseCodexJsonl(explorationExecution.stdout, {
    durationMs: Date.now() - explorationStartedAt,
    stderrCharacters: explorationExecution.stderr.length,
  });
  const ledgerSignal = parseExternalLedgerSignal(exploration.answer);
  const ledger = readExternalLedger(externalState.ledgerPath);
  if (ledgerSignal === 'blocked') throw new Error('External evidence phase reported LEDGER_BLOCKED.');

  const synthesisStartedAt = Date.now();
  const synthesisExecution = await runCodex({
    repository: sandbox.repository,
    environment,
    model: options.model,
    reasoning: options.reasoning,
    prompt: externalLedgerSynthesisPrompt(definition.question, ledger),
  });
  const synthesis = parseCodexJsonl(synthesisExecution.stdout, {
    durationMs: Date.now() - synthesisStartedAt,
    stderrCharacters: synthesisExecution.stderr.length,
  });
  return {
    trial: combineCodexPhases(exploration, synthesis, {
      ...metadata,
      durationMs: Date.now() - startedAt,
      stderrCharacters: explorationExecution.stderr.length + synthesisExecution.stderr.length,
    }),
    externalEvidence: summarizeExternalEvidence(externalState.evidenceDir, ledger),
  };
}

function createExternalEvidenceState() {
  const root = mkdtempSync(join(tmpdir(), 'scip-explore-external-evidence-'));
  const evidenceDir = join(root, 'packets');
  mkdirSync(evidenceDir, { mode: 0o700 });
  return {
    root,
    evidenceDir,
    ledgerPath: join(root, 'ledger.md'),
    remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function readExternalLedger(path) {
  if (!existsSync(path)) throw new Error(`External evidence phase did not write its ledger: ${path}`);
  const ledger = readFileSync(path, 'utf8');
  if (ledger.trim() === '') throw new Error('External evidence ledger is empty.');
  if (ledger.length > 120_000) throw new Error('External evidence ledger exceeds 120,000 characters.');
  return ledger;
}

function summarizeExternalEvidence(evidenceDir, ledger) {
  const entries = readdirSync(evidenceDir);
  const packets = entries.filter((name) => name.endsWith('.json') && !name.endsWith('.receipt.json'));
  const receipts = entries.filter((name) => name.endsWith('.receipt.json'));
  return {
    packetCount: packets.length,
    receiptCount: receipts.length,
    rawEvidenceBytes: packets.reduce((total, name) => total + statSync(join(evidenceDir, name)).size, 0),
    receiptBytes: receipts.reduce((total, name) => total + statSync(join(evidenceDir, name)).size, 0),
    ledgerCharacters: ledger.length,
    ledger,
  };
}

function parseArgs(args) {
  const [definition, mode, ...rest] = args;
  if (!definition || !MODES.has(mode)) usage();
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (
      !['--repo', '--output', '--model', '--reasoning', '--isolation', '--ref', '--cli'].includes(flag) ||
      value === undefined
    )
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
    cli: resolve(values.get('--cli') ?? join(PROJECT_ROOT, 'dist', 'cli.js')),
  };
}

function usage() {
  process.stderr.write(
    'Usage: node scripts/codex-exploration-trial.mjs <definition.json> <treatment|treatment-direct|treatment-minimal|treatment-ledger|control|control-disciplined> --repo <path> --output <path> [--model <model>] [--reasoning <effort>] [--isolation <detached|live>] [--ref <git-ref>] [--cli <executable>]\n',
  );
  process.exit(2);
}

function promptForMode(mode, definition) {
  const { question } = definition;
  switch (mode) {
    case 'treatment':
      return treatmentPrompt(question);
    case 'treatment-direct':
      return directGraphTreatmentPrompt(question);
    case 'treatment-minimal':
      return minimalTreatmentPrompt(question);
    case 'treatment-ledger':
      throw new Error('treatment-ledger uses separate acquisition and synthesis prompts');
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
  return (
    mode === 'treatment' || mode === 'treatment-direct' || mode === 'treatment-minimal' || mode === 'treatment-ledger'
  );
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

function benchmarkEnvironment(sandbox, sessionId, cliDirectory, externalState = null) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('SCIP_QUERY_') && !key.startsWith('SCIP_EXPLORE_')),
  );
  const inheritedPath = process.env.PATH ?? '';
  if (cliDirectory === null) {
    return {
      ...environment,
      PATH: pathWithoutExecutable(inheritedPath, 'scip-query'),
    };
  }
  return {
    ...environment,
    PATH: `${cliDirectory}:${inheritedPath}`,
    SCIP_QUERY_SESSION: sessionId,
    SCIP_QUERY_PROJECT_ROOT: sandbox.repository,
    SCIP_QUERY_SKIP_WATCH_SERVICE: '1',
    ...(externalState
      ? {
          SCIP_EXPLORE_EVIDENCE_DIR: externalState.evidenceDir,
          SCIP_EXPLORE_LEDGER: externalState.ledgerPath,
        }
      : {}),
    ...(sandbox.cacheDir ? { SCIP_QUERY_CACHE_DIR: sandbox.cacheDir } : {}),
  };
}

function createCliShim(cliPath) {
  if (!existsSync(cliPath)) {
    throw new Error(`scip-query benchmark CLI does not exist: ${cliPath}. Run npm run build first or pass --cli.`);
  }
  const directory = mkdtempSync(join(tmpdir(), 'scip-query-benchmark-cli-'));
  const shim = join(directory, 'scip-query');
  symlinkSync(cliPath, shim);
  return {
    path: cliPath,
    directory,
    sha256: createHash('sha256').update(readFileSync(cliPath)).digest('hex'),
    remove() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function prepareTreatmentIndex(repository, environment) {
  const startedAt = Date.now();
  const indexExecution = await runProcess('scip-query', ['reindex', '--force'], {
    cwd: repository,
    env: environment,
    forwardStderr: true,
  });
  const guidanceExecution = await runProcess('scip-query', ['setup-agent'], {
    cwd: repository,
    env: environment,
    forwardStderr: true,
  });
  return {
    durationMs: Date.now() - startedAt,
    stderrCharacters: indexExecution.stderr.length + guidanceExecution.stderr.length,
    agentGuidancePrepared: true,
  };
}

function runCodex({ repository, environment, model, reasoning, prompt }) {
  const args = codexExplorationExecArgs({ repository, model, reasoning });
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
