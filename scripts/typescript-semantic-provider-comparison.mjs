#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CLI = join(ROOT, 'dist/cli.js');
const DEFAULT_RUN_HISTORY = join(ROOT, 'docs/benchmarks/runs/2026-07-09-typescript-semantic-provider-comparison.jsonl');

const REPOS = {
  'scip-query': {
    cwd: ROOT,
    env: {},
  },
  VegaAssistant: {
    cwd: '/Users/aydansalois/Documents/GitHub/VegaAssistant',
    env: {},
  },
};

function parseArgs(argv) {
  const out = {
    repos: ['scip-query'],
    limit: 200,
    maxMismatches: 10,
    scope: null,
    full: false,
    reindex: false,
    timeoutMs: 180_000,
    out: DEFAULT_RUN_HISTORY,
    append: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') out.repos = mustValue(argv, ++i, arg).split(',');
    else if (arg === '--limit') out.limit = Number(mustValue(argv, ++i, arg));
    else if (arg === '--max-mismatches') out.maxMismatches = Number(mustValue(argv, ++i, arg));
    else if (arg === '--scope') out.scope = mustValue(argv, ++i, arg);
    else if (arg === '--full') out.full = true;
    else if (arg === '--reindex') out.reindex = true;
    else if (arg === '--timeout-ms') out.timeoutMs = Number(mustValue(argv, ++i, arg));
    else if (arg === '--out') out.out = resolve(mustValue(argv, ++i, arg));
    else if (arg === '--append') out.append = true;
    else if (arg === '--list') {
      console.log(JSON.stringify({ repos: Object.keys(REPOS) }, null, 2));
      process.exit(0);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(out.limit) || out.limit < 1) throw new Error('--limit must be >= 1');
  if (!Number.isFinite(out.maxMismatches) || out.maxMismatches < 0) {
    throw new Error('--max-mismatches must be >= 0');
  }
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 1000) throw new Error('--timeout-ms must be >= 1000');
  return out;
}

function mustValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/typescript-semantic-provider-comparison.mjs [options]

Options:
  --repo <names>          Comma-separated repos: ${Object.keys(REPOS).join(', ')}
  --limit <n>             Definitions to compare unless --full is set. Default: 200.
  --max-mismatches <n>    Mismatch detail rows to keep. Default: 10.
  --scope <path>          Limit compared definitions to files matching path.
  --full                  Compare every indexed TypeScript-like definition.
  --reindex               Run scip-query reindex --json before comparing.
  --timeout-ms <n>        Per-command timeout. Default: 180000.
  --out <path>            JSONL run history path. Default: ${DEFAULT_RUN_HISTORY}
  --append                Append instead of replacing the run history.
  --list                  Print supported repos.
`);
}

function compareArgs(opts) {
  const args = ['typescript-semantic-compare', '--json', '--max-mismatches', String(opts.maxMismatches)];
  if (opts.full) args.push('--full');
  else args.push('--limit', String(opts.limit));
  if (opts.scope) args.push('--scope', opts.scope);
  return args;
}

function runCommand(repo, args, timeoutMs) {
  const started = process.hrtime.bigint();
  const child = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo.cwd,
    env: { ...process.env, ...repo.env },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 120 * 1024 * 1024,
  });
  const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
  let parsed = null;
  let parseError = null;
  try {
    parsed = child.stdout.trim() ? JSON.parse(child.stdout) : null;
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  return {
    args,
    durationMs,
    exitCode: child.status,
    signal: child.signal,
    timedOut: child.error?.code === 'ETIMEDOUT' || child.signal === 'SIGTERM',
    stdoutBytes: Buffer.byteLength(child.stdout ?? ''),
    stderrBytes: Buffer.byteLength(child.stderr ?? ''),
    stdoutSha256: hashText(child.stdout ?? ''),
    stderrTail: child.stderr ? child.stderr.slice(-1000) : '',
    jsonParsed: parseError === null,
    parseError,
    summary: parsed ? summarize(parsed) : null,
  };
}

function summarize(parsed) {
  const result = parsed.result ?? parsed;
  return {
    command: parsed.command,
    evidence: parsed.evidence,
    comparedDefinitions: result.selection?.comparedDefinitions,
    totalTypeScriptDefinitions: result.selection?.totalTypeScriptDefinitions,
    matches: result.comparison?.matches,
    mismatchCount: result.comparison?.mismatchCount,
    missingReferenceCount: result.comparison?.missingReferenceCount,
    extraReferenceCount: result.comparison?.extraReferenceCount,
    baselineCreateMs: result.baseline?.createMs,
    candidateCreateMs: result.candidate?.createMs,
    baselineMs: result.comparison?.baselineMs,
    candidateMs: result.comparison?.candidateMs,
    baselineReferenceCount: result.comparison?.baselineReferenceCount,
    candidateReferenceCount: result.comparison?.candidateReferenceCount,
  };
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function appendJsonLine(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: 'a' });
}

function currentCommit() {
  const result = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(opts.out), { recursive: true });
  if (!opts.append) writeFileSync(opts.out, '');
  const repos = opts.repos.map((repoName) => {
    const repo = REPOS[repoName];
    if (!repo) throw new Error(`Unknown repo: ${repoName}`);
    if (!existsSync(repo.cwd)) throw new Error(`Repo path does not exist for ${repoName}: ${repo.cwd}`);
    return [repoName, repo];
  });
  appendJsonLine(opts.out, {
    schemaVersion: 1,
    kind: 'manifest',
    timestamp: new Date().toISOString(),
    commit: currentCommit(),
    repos: opts.repos,
    limit: opts.limit,
    full: opts.full,
    scope: opts.scope,
    reindex: opts.reindex,
    timeoutMs: opts.timeoutMs,
  });

  for (const [repoName, repo] of repos) {
    if (opts.reindex) {
      const reindex = runCommand(repo, ['reindex', '--json'], opts.timeoutMs);
      appendJsonLine(opts.out, {
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        commit: currentCommit(),
        repo: repoName,
        cwd: repo.cwd,
        commandId: 'reindex',
        ...reindex,
      });
      console.error(`${repoName}\treindex\texit=${reindex.exitCode}\t${reindex.durationMs}ms`);
      if (reindex.exitCode !== 0) continue;
    }

    const comparison = runCommand(repo, compareArgs(opts), opts.timeoutMs);
    appendJsonLine(opts.out, {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      commit: currentCommit(),
      repo: repoName,
      cwd: repo.cwd,
      commandId: 'typescript-semantic-compare',
      ...comparison,
    });
    console.error(`${repoName}\ttypescript-semantic-compare\texit=${comparison.exitCode}\t${comparison.durationMs}ms`);
  }
}

main();
