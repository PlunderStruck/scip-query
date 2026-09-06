#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createExplorationSandbox } from './codex-exploration-sandbox.mjs';
import { codexExplorationExecArgs, parseCodexJsonl } from './codex-exploration-trial-core.mjs';
import {
  CHANGE_BENCHMARK_ROOT,
  CHANGE_PHASES,
  changePrompt,
  changeSuite,
  compareChangeTrials,
  directoryDigest,
  evaluateChange,
  fileInventory,
  materializeChangeFixture,
} from './change-benchmark-core.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_GIT_DATE = '2026-09-05T00:00:00Z';

export async function runChangeTrial(options) {
  if (process.platform === 'win32')
    throw new Error(
      'The Codex trial launcher currently requires a POSIX shell; the source evaluators can run independently.',
    );
  const suite = changeSuite();
  const task = suite.tasks.find((item) => item.id === options.task);
  if (!task || !['control', 'treatment'].includes(options.mode)) throw new Error('Unknown task or mode');
  const output = resolve(options.output);
  if (existsSync(output)) throw new Error(`Refusing to overwrite trial directory: ${output}`);
  mkdirSync(output, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'scip-change-trial-'));
  const source = join(work, 'source');
  let sandbox;
  const artifact = newChangeTrialArtifact(suite, task, options);
  const save = () => writeFileSync(join(output, 'trial.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  save();
  try {
    const { codex, cli } = resolveTrialTools(options, artifact);
    materializeChangeFixture(source, task.id);
    symlinkSync(join(PROJECT_ROOT, 'node_modules'), join(source, 'node_modules'), 'dir');
    git(source, ['init', '--initial-branch=main']);
    git(source, ['add', '--all']);
    git(source, ['commit', '-m', 'Frozen change benchmark fixture']);
    sandbox = createExplorationSandbox(source);
    artifact.baselineCommit = sandbox.commit;
    artifact.isolation.repository = sandbox.repository;
    artifact.isolation.sourceRepository = sandbox.sourceRepository;
    const environment = changeTrialEnvironment(work, sandbox, cli, options.mode);
    if (options.mode === 'treatment') {
      const started = Date.now();
      await runLogged(process.execPath, [cli, 'reindex', '--force'], {
        cwd: sandbox.repository,
        env: environment,
        output,
        prefix: 'index',
        timeoutMs: 120_000,
      });
      artifact.indexDurationMs = Date.now() - started;
    }
    for (const phase of CHANGE_PHASES) {
      const result = await runChangePhase({ task, phase, output, options, artifact, sandbox, environment, codex });
      artifact.phases.push(result);
      save();
      git(sandbox.repository, ['commit', '--allow-empty', '-m', `Checkpoint ${phase} result`]);
    }
    artifact.status = 'completed';
  } catch (error) {
    artifact.status = 'failed';
    artifact.error = error.message;
  } finally {
    try {
      sandbox?.remove();
      rmSync(work, { recursive: true, force: true });
      artifact.isolation.cleaned = true;
    } catch (error) {
      artifact.status = 'failed';
      artifact.cleanupError = error.message;
    }
    save();
  }
  return artifact;
}

function resolveTrialTools(options, artifact) {
  const codex = options.codex ?? resolveExecutable('codex');
  const cli = resolve(options.cli ?? join(PROJECT_ROOT, 'dist/cli.js'));
  artifact.runtime.codex = runSync(codex, ['--version'], PROJECT_ROOT).trim();
  const cliDirectory = dirname(cli);
  const toolHash = createHash('sha256');
  for (const path of fileInventory(cliDirectory).filter((path) => path.endsWith('.js')))
    toolHash.update(path).update(readFileSync(join(cliDirectory, path)));
  artifact.toolDigest = toolHash.digest('hex');
  return { codex, cli };
}

async function runChangePhase({ task, phase, output, options, artifact, sandbox, environment, codex }) {
  const phaseOutput = join(output, phase);
  mkdirSync(phaseOutput);
  const prompt = changePrompt(task, options.mode, phase);
  writeFileSync(join(phaseOutput, 'prompt.txt'), prompt);
  environment.SCIP_QUERY_SESSION = `change-${task.id}-${options.mode}-${phase}-${artifact.repetition}`;
  const started = Date.now();
  const execution = await runLogged(
    codex,
    codexExplorationExecArgs({
      repository: sandbox.repository,
      model: artifact.model,
      reasoning: artifact.reasoning,
    }),
    {
      cwd: sandbox.repository,
      env: environment,
      input: prompt,
      output: phaseOutput,
      prefix: 'agent',
      timeoutMs: options.timeoutMs ?? 300_000,
    },
  );
  const parsed = parseCodexJsonl(execution.stdout);
  const durationMs = Date.now() - started;
  if (directoryDigest(CHANGE_BENCHMARK_ROOT) !== artifact.suiteDigest)
    throw new Error('Frozen benchmark inputs changed during a trial');
  if (
    createHash('sha256')
      .update(readFileSync(join(PROJECT_ROOT, 'scripts/change-benchmark-core.mjs')))
      .digest('hex') !== artifact.evaluatorDigest
  )
    throw new Error('Frozen evaluator changed during a trial');
  git(sandbox.repository, ['add', '--all']);
  const patch = git(sandbox.repository, ['diff', '--cached', '--binary', 'HEAD']);
  writeFileSync(join(phaseOutput, 'change.patch'), patch);
  const numstat = git(sandbox.repository, ['diff', '--cached', '--numstat', 'HEAD']);
  const changedFiles = numstat
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, removed, path] = line.split('\t');
      return {
        path,
        added: added === '-' ? null : Number(added),
        removed: removed === '-' ? null : Number(removed),
      };
    });
  cpSync(join(sandbox.repository, 'src'), join(phaseOutput, 'source'), { recursive: true });
  const evaluation = evaluateChange(sandbox.repository, task.id, phase);
  return {
    phase,
    durationMs,
    execution: parsed,
    changedFiles,
    evaluation,
    protocol: {
      scipQueryCommands: parsed.calls.filter((call) => call.surface === 'scip-query').length,
      nativeExplorationCommands: parsed.calls.filter(
        (call) => call.surface === 'native-read' || call.surface === 'native-search',
      ).length,
      note: 'Command classification is an audit aid; scripts may combine permitted edits and reads. Review raw events before judging adherence.',
    },
  };
}

function changeTrialEnvironment(work, sandbox, cli, mode) {
  const bin = join(work, 'bin');
  mkdirSync(bin);
  const shim = join(bin, 'scip-query');
  writeFileSync(
    shim,
    mode === 'treatment'
      ? `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"\n`
      : '#!/bin/sh\necho "scip-query is unavailable in the native control condition" >&2\nexit 126\n',
  );
  chmodSync(shim, 0o755);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('SCIP_QUERY_') && !key.startsWith('SCIP_EXPLORE_')),
  );
  environment.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  Object.assign(environment, {
    SCIP_QUERY_PROJECT_ROOT: sandbox.repository,
    SCIP_QUERY_CACHE_DIR: sandbox.cacheDir,
    SCIP_QUERY_SKIP_WATCH_SERVICE: '1',
  });
  return environment;
}

function newChangeTrialArtifact(suite, task, options) {
  return {
    schemaVersion: 1,
    suiteId: suite.id,
    suiteDigest: directoryDigest(CHANGE_BENCHMARK_ROOT),
    evaluatorDigest: createHash('sha256')
      .update(readFileSync(join(PROJECT_ROOT, 'scripts/change-benchmark-core.mjs')))
      .digest('hex'),
    taskId: task.id,
    mode: options.mode,
    model: options.model ?? 'gpt-5.6-sol',
    reasoning: options.reasoning ?? 'medium',
    timeoutMs: options.timeoutMs ?? 300_000,
    repetition: options.repetition ?? 1,
    baselineCommit: null,
    status: 'running',
    indexDurationMs: null,
    phases: [],
    isolation: { kind: 'detached-worktree', cleaned: false, securityBoundary: false },
    runtime: { node: process.version },
  };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolveExecutable(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const path = join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    if (existsSync(path)) return path;
  }
  throw new Error(`Executable is unavailable: ${name}`);
}

function runSync(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0 || result.error)
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

function git(cwd, args) {
  return runSync(
    'git',
    [
      '-c',
      'user.name=Change benchmark',
      '-c',
      'user.email=benchmark@example.test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    cwd,
    { ...process.env, GIT_AUTHOR_DATE: FIXED_GIT_DATE, GIT_COMMITTER_DATE: FIXED_GIT_DATE },
  );
}

function runLogged(command, args, options) {
  writeFileSync(
    join(options.output, `${options.prefix}-invocation.json`),
    JSON.stringify({ command, args, timeoutMs: options.timeoutMs }, null, 2),
  );
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer;
    const stop = (signal) => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        /* The process may have exited between the timer and kill. */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      killTimer = setTimeout(() => stop('SIGKILL'), 5000);
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const persist = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      writeFileSync(join(options.output, `${options.prefix}.jsonl`), stdout);
      writeFileSync(join(options.output, `${options.prefix}.stderr.log`), stderr);
    };
    child.on('error', (error) => {
      persist();
      reject(error);
    });
    child.on('close', (code, signal) => {
      persist();
      if (code !== 0 || timedOut)
        reject(new Error(`${command} exited ${code}, signal ${signal}, timedOut=${timedOut}; raw logs retained`));
      else resolvePromise({ stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'compare') {
    const trials = rest.map((path) => JSON.parse(readFileSync(resolve(path), 'utf8')));
    process.stdout.write(`${JSON.stringify(compareChangeTrials(trials), null, 2)}\n`);
    return;
  }
  if (command !== 'run' && command !== 'pilot')
    throw new Error(
      'Usage: node scripts/codex-change-trial.mjs run --task <id> --mode <control|treatment> --output <new-directory> [--model gpt-5.6-sol] [--reasoning medium] | pilot --output <new-directory> | compare <trial.json>...',
    );
  const options = changeTrialOptions(rest);
  if (command === 'run') {
    const result = await runChangeTrial(options);
    process.stdout.write(
      `${JSON.stringify({ taskId: result.taskId, mode: result.mode, status: result.status, output: options.output, error: result.error })}\n`,
    );
    if (result.status !== 'completed') process.exitCode = 1;
    return;
  }
  await runChangePilot(options);
}

function changeTrialOptions(rest) {
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (
      ![
        '--task',
        '--mode',
        '--output',
        '--model',
        '--reasoning',
        '--repetition',
        '--cli',
        '--codex',
        '--timeout-ms',
      ].includes(key) ||
      value === undefined
    )
      throw new Error(`Invalid option: ${key}`);
    options[key.slice(2)] = value;
  }
  if (!options.output) throw new Error('--output is required');
  if (options.repetition !== undefined) options.repetition = positiveInteger(options.repetition);
  if (options['timeout-ms'] !== undefined) options.timeoutMs = positiveInteger(options['timeout-ms']);
  if (options.reasoning && !['low', 'medium', 'high', 'xhigh'].includes(options.reasoning))
    throw new Error('Invalid reasoning effort');
  return options;
}

async function runChangePilot(options) {
  if (existsSync(options.output)) throw new Error('Pilot output directory must not exist');
  mkdirSync(options.output, { recursive: true });
  const trials = [];
  for (const [index, task] of changeSuite().tasks.entries()) {
    // Alternate condition order to avoid always giving one condition the warm host.
    for (const mode of index % 2 === 0 ? ['control', 'treatment'] : ['treatment', 'control']) {
      process.stdout.write(`Starting ${task.id} ${mode}\n`);
      const result = await runChangeTrial({
        ...options,
        task: task.id,
        mode,
        output: join(options.output, `${task.id}-${mode}`),
      });
      trials.push(result);
      process.stdout.write(`Finished ${task.id} ${mode}: ${result.status}\n`);
    }
  }
  writeFileSync(join(options.output, 'comparison.json'), `${JSON.stringify(compareChangeTrials(trials), null, 2)}\n`);
  if (trials.some((trial) => trial.status !== 'completed')) process.exitCode = 1;
}

function positiveInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Expected positive integer: ${value}`);
  return number;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
