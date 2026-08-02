#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CLI = join(ROOT, 'dist/cli.js');
const DEFAULT_RUN_HISTORY = join(ROOT, 'docs/benchmarks/runs/2026-07-08-semantic-command-calibration.jsonl');

const REPOS = {
  'scip-query': {
    cwd: ROOT,
    env: {},
    target: {
      file: 'src/semantic/shared-primitives.ts',
      rustFile: 'crates/scip-query-kernels/src/lib.rs',
      module: 'src/semantic',
      symbol: 'semanticEvidenceProduct',
      secondSymbol: 'semanticReferences',
      rustSymbol: 'leaf_name',
      className: 'src/semantic/rust/lsp-session.ts/RustAnalyzerSessionResolver',
      kind: 'function',
      doc: 'docs/architecture/rust-semantic-performance-ledger.md',
    },
  },
  OpenCode: {
    cwd: '/Users/aydansalois/Documents/GitHub/opencode',
    env: {},
    target: {
      file: 'packages/opencode/src/index.ts',
      rustFile: 'packages/opencode/src/index.ts',
      module: 'packages/opencode/src',
      symbol: 'toRequestError',
      secondSymbol: 'fromUnknownDefect',
      rustSymbol: 'toRequestError',
      className: 'NamedError',
      kind: 'function',
      doc: 'README.md',
    },
  },
  VegaAssistant: {
    cwd: '/Users/aydansalois/Documents/GitHub/VegaAssistant',
    env: {},
    target: {
      file: 'src-tauri/src/gateway_agent_runtime.rs',
      rustFile: 'src-tauri/src/gateway_agent_runtime.rs',
      module: 'src-tauri/src',
      symbol: 'build_system_prompt_with_options',
      secondSymbol: 'build_tool_prompt_injection',
      rustSymbol: 'build_system_prompt_with_options',
      className: 'GatewayAgentLoop',
      kind: 'function',
      doc: 'README.md',
    },
  },
  'Vega_2.0': {
    cwd: '/Users/aydansalois/Documents/GitHub/Vega_2.0',
    env: {},
    target: {
      file: 'apps/api/src/services/websocket-inbound-message-router.ts',
      rustFile: 'apps/api/src/services/websocket-inbound-message-router.ts',
      module: 'apps/api/src/services',
      symbol: 'routeInboundWebSocketMessage',
      secondSymbol: 'normalizeAccessScope',
      rustSymbol: 'routeInboundWebSocketMessage',
      className: 'apps/api/src/modules/coding-agents/coding-agents.service.ts/CodingAgentsService',
      kind: 'function',
      doc: 'README.md',
    },
  },
  'codex-rs': {
    cwd: '/Users/aydansalois/Documents/GitHub/codex/codex-rs',
    env: { RUSTUP_TOOLCHAIN: 'stable' },
    target: {
      file: 'core/src/client.rs',
      rustFile: 'core/src/client.rs',
      module: 'core/src',
      symbol: 'ModelClient::new',
      secondSymbol: 'ModelClient::new_session',
      rustSymbol: 'ModelClient::new',
      className: 'ModelClient',
      kind: 'function',
      doc: 'README.md',
    },
  },
};

const COMMANDS = [
  c('status-json', ['status', '--json']),
  c('status-capabilities', ['status', '--capabilities']),
  c('capabilities-json', ['capabilities', '--json']),
  c('capability-matrix-json', ['capability-matrix', '--json']),
  c('doctor-json', ['doctor', '--json']),
  c('check-deps', ['check-deps']),
  c('config-validate-json', ['config-validate', '--json']),
  c('stats-json', ['stats', '--json']),
  c('kind-counts-json', ['kind-counts', '--json']),
  c('files-symbol', ({ target }) => ['files', target.symbol, '--json']),
  c('methods-class', ({ target }) => ['methods', target.className, '--json']),
  c('refs-symbol', ({ target }) => ['refs', target.symbol, '--json']),
  c('trace-symbol', ({ target }) => ['trace', target.symbol, '--json']),
  c('deps-file', ({ target }) => ['deps', target.file, '--json']),
  c('rdeps-file', ({ target }) => ['rdeps', target.file, '--json']),
  c('system-module', ({ target }) => ['system', target.module, '--json']),
  c('surface-module', ({ target }) => ['surface', target.module, '--json']),
  c('dead-default', ['dead', '--json']),
  c('dead-full', ['dead', '--json', '--full']),
  c('hotspots-json', ['hotspots', '--json']),
  c('imports-file', ({ target }) => ['imports', target.rustFile, '--json']),
  c('imports-file-full', ({ target }) => ['imports', target.rustFile, '--full', '--json']),
  c('imported-by-symbol', ({ target }) => ['imported-by', target.symbol, '--json']),
  c('unused-imports-file', ({ target }) => ['unused-imports', target.file, '--json']),
  c('unused-imports-file-full', ({ target }) => ['unused-imports', target.file, '--full', '--json']),
  c('outline-file', ({ target }) => ['outline', target.rustFile, '--json']),
  c('outline-file-signatures', ({ target }) => ['outline', target.rustFile, '--signatures', '--json']),
  c('members-symbol', ({ target }) => ['members', target.symbol, '--json']),
  c('fan-in-symbol', ({ target }) => ['fan-in', target.symbol, '--json']),
  c('fan-out-file', ({ target }) => ['fan-out', target.file, '--json']),
  c('coupling-file', ({ target }) => ['coupling', target.file, '--json']),
  c('cycles-json', ['cycles', '--json']),
  c('bottlenecks-json', ['bottlenecks', '--json']),
  c('isolated-default', ['isolated', '--json']),
  c('isolated-full', ['isolated', '--json', '--full']),
  c('by-kind-function', ({ target }) => ['by-kind', target.kind, '--json']),
  c('deep-chains-json', ['deep-chains', '--json']),
  c('hierarchy-symbol', ({ target }) => ['hierarchy', target.symbol, '--json']),
  c('call-graph-symbol', ({ target }) => ['call-graph', target.rustSymbol, '--json']),
  c('call-graph-symbol-full', ({ target }) => ['call-graph', target.rustSymbol, '--full', '--json']),
  c('similar-symbol', ({ target }) => ['similar', target.symbol, '--json']),
  c('similar-full', ['similar', '--json', '--full']),
  c('similar-files-file', ({ target }) => ['similar-files', target.file, '--json']),
  c('similar-files-full', ['similar-files', '--json', '--full']),
  c('react-component-duplicates', ['react-component-duplicates', '--json']),
  c('react-hook-candidates', ['react-hook-candidates', '--json']),
  c('react-large-component-pressure', ['react-large-component-pressure', '--json']),
  c('vue-component-duplicates', ['vue-component-duplicates', '--json']),
  c('vue-composable-candidates', ['vue-composable-candidates', '--json']),
  c('vue-large-view-pressure', ['vue-large-view-pressure', '--json']),
  c('similar-chains-json', ['similar-chains', '--json']),
  c('extract-candidates-json', ['extract-candidates', '--json']),
  c('locality-candidates-symbol', ({ target }) => ['locality-candidates', target.symbol, '--json']),
  c('affected-symbol', ({ target }) => ['affected', target.symbol, '--json']),
  c('change-surface-file', ({ target }) => ['change-surface', target.file, '--json']),
  c('cleanup-plan-json', ['cleanup-plan', '--json']),
  c('cleanup-plan-verify-json', ['cleanup-plan', '--verify', '--json']),
  c('co-change-file', ({ target }) => ['co-change', target.file, '--json']),
  c('recent-duplicates-default', ['recent-duplicates', '--json']),
  c('recent-duplicates-full', ['recent-duplicates', '--json', '--full']),
  c('doc-drift-doc', ({ target }) => ['doc-drift', target.doc, '--json']),
  c('doc-drift-full', ['doc-drift', '--json', '--full']),
  c('unused-params-default', ['unused-params', '--json']),
  c('unused-params-full', ['unused-params', '--json', '--full']),
  c('diff-impact-json', ['diff-impact', '--json']),
  c('incomplete-migration-default', ['incomplete-migration', '--json']),
  c('incomplete-migration-full', ['incomplete-migration', '--json', '--full']),
  c('context-symbol', ({ target }) => ['context', target.symbol, '--json']),
  c('drift-module', ({ target }) => ['drift', target.module, '--json']),
  c('wrapper-candidates-default', ['wrapper-candidates', '--json']),
  c('wrapper-candidates-full', ['wrapper-candidates', '--json', '--full']),
  c('passthrough-candidates-default', ['passthrough-candidates', '--json']),
  c('passthrough-candidates-full', ['passthrough-candidates', '--json', '--full']),
  c('stale-abstractions-default', ['stale-abstractions', '--json']),
  c('stale-abstractions-full', ['stale-abstractions', '--json', '--full']),
  c('complexity-hotspots-default', ['complexity-hotspots', '--json']),
  c('complexity-hotspots-full', ['complexity-hotspots', '--json', '--full']),
  c('self-audit-json', ['self-audit', '--json']),
  c('health-json', ['health', '--json']),
  c('health-full-json', ['health', '--full', '--json']),
  c('redundant-reexports-json', ['redundant-reexports', '--json']),
  c('duplicate-bodies-json', ['duplicate-bodies', '--json']),
  c('twin-drift-json', ['twin-drift', '--json']),
  c('not-implemented-json', ['not-implemented', '--json']),
  c('decorative-checkers-json', ['decorative-checkers', '--json']),
  c('test-quality-json', ['test-quality', '--json']),
  c('similar-signatures-json', ['similar-signatures', '--json']),
  c('code-symbol', ({ target }) => ['code', target.symbol, '--json']),
  c('complexity-symbol', ({ target }) => ['complexity', target.symbol, '--json']),
  c('dataflow-symbol', ({ target }) => ['dataflow', target.symbol, '--json']),
  c('slice-symbol', ({ target }) => ['slice', target.symbol, '--json']),
  c('slice-symbol-forward', ({ target }) => ['slice', target.symbol, '--forward', '--json']),
];

const MUTATING_OR_UNBOUNDED_COMMANDS = [
  'reindex',
  'augment-sources',
  'augment-vue',
  'cleanup-apply',
  'install-skills',
  'init',
  'suppress',
  'setup',
  'setup-agent',
  'twin-ab',
  'uninstall',
  'watch',
  'tla',
];

function c(id, args) {
  return { id, args };
}

function parseArgs(argv) {
  const out = {
    repos: Object.keys(REPOS),
    commandIds: null,
    iterations: 2,
    timeoutMs: 180_000,
    out: DEFAULT_RUN_HISTORY,
    profileDir: join(tmpdir(), `scip-semantic-command-calibration-${Date.now()}`),
    append: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo') out.repos = mustValue(argv, ++i, arg).split(',');
    else if (arg === '--command') out.commandIds = mustValue(argv, ++i, arg).split(',');
    else if (arg === '--iterations') out.iterations = Number(mustValue(argv, ++i, arg));
    else if (arg === '--timeout-ms') out.timeoutMs = Number(mustValue(argv, ++i, arg));
    else if (arg === '--out') out.out = resolve(mustValue(argv, ++i, arg));
    else if (arg === '--profile-dir') out.profileDir = resolve(mustValue(argv, ++i, arg));
    else if (arg === '--append') out.append = true;
    else if (arg === '--list') {
      printMatrix();
      process.exit(0);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(out.iterations) || out.iterations < 1) throw new Error('--iterations must be >= 1');
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 1000) throw new Error('--timeout-ms must be >= 1000');
  return out;
}

function mustValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/semantic-command-calibration.mjs [options]

Options:
  --repo <names>          Comma-separated repos: ${Object.keys(REPOS).join(', ')}
  --command <ids>         Comma-separated command ids. Use --list to inspect.
  --iterations <n>        Runs per command per repo. Default: 2.
  --timeout-ms <n>        Per-command timeout. Default: 180000.
  --out <path>            JSONL run history path. Default: ${DEFAULT_RUN_HISTORY}
  --profile-dir <path>    Directory for profile JSONL sidecars.
  --append                Append instead of replacing the run history.
  --list                  Print command matrix and excluded mutating commands.
`);
}

function printMatrix() {
  console.log(
    JSON.stringify(
      {
        repos: Object.keys(REPOS),
        commands: COMMANDS.map((entry) => entry.id),
        excluded: MUTATING_OR_UNBOUNDED_COMMANDS,
      },
      null,
      2,
    ),
  );
}

function commandArgs(entry, repo) {
  return typeof entry.args === 'function' ? entry.args(repo) : entry.args;
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function summarizeParsedJson(parsed) {
  const result = parsed?.result ?? parsed;
  const summary = {
    command: parsed?.command,
    evidence: parsed?.evidence,
    semanticEnrichment: parsed?.analysisBudget?.semanticEnrichment ?? result?.overview?.budget?.semanticEnrichment,
  };
  if (Array.isArray(result)) {
    summary.resultKind = 'array';
    summary.resultCount = result.length;
  } else if (result && typeof result === 'object') {
    summary.resultKind = 'object';
    summary.resultKeys = Object.keys(result).slice(0, 20);
    if (typeof result.score === 'number') summary.healthScore = result.score;
    if (typeof result.riskScore === 'number') summary.riskScore = result.riskScore;
    if (typeof result.hygieneScore === 'number') summary.hygieneScore = result.hygieneScore;
    if (Array.isArray(result.findings)) summary.findings = result.findings.length;
    if (Array.isArray(result.symbols)) summary.symbols = result.symbols.length;
    if (Array.isArray(result.files)) summary.files = result.files.length;
    if (Array.isArray(result.imports)) summary.imports = result.imports.length;
    const graph = result.callGraph ?? result;
    if (Array.isArray(graph.callers)) summary.callers = graph.callers.length;
    if (Array.isArray(graph.callees)) summary.callees = graph.callees.length;
    if (typeof result.matched === 'boolean') summary.matched = result.matched;
    if (typeof result.totalMatches === 'number') summary.totalMatches = result.totalMatches;
    if (typeof result.exitCode === 'number') summary.innerExitCode = result.exitCode;
  }
  return summary;
}

function summarizeProfile(profilePath) {
  if (!existsSync(profilePath)) return { profileEvents: 0 };
  const raw = readFileSync(profilePath, 'utf8').trim();
  if (!raw) return { profileEvents: 0 };
  const events = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const spanEvents = events.filter((event) => event.type === 'span');
  const profile = {
    profileEvents: events.length,
    spanEvents: spanEvents.length,
    rustSessionRequests: countName(spanEvents, 'rust.semantic.session.request'),
    rustSessionMs: sumName(spanEvents, 'rust.semantic.session.request'),
    rustImportDefinitionRequests: countName(spanEvents, 'rust.semantic.import-definitions.session.request'),
    rustImportDefinitionMs: sumName(spanEvents, 'rust.semantic.import-definitions.session.request'),
    projectCacheReads: countName(spanEvents, 'evidence-product.project.read'),
    projectCacheHits: spanEvents.filter((event) => event.name === 'evidence-product.project.read' && event.hit === true)
      .length,
    projectCacheMisses: spanEvents.filter(
      (event) => event.name === 'evidence-product.project.read' && event.hit === false,
    ).length,
    fileCacheReads: countName(spanEvents, 'evidence-product.file.read'),
    fileCacheHits: spanEvents.filter((event) => event.name === 'evidence-product.file.read' && event.hit === true)
      .length,
    fileCacheMisses: spanEvents.filter((event) => event.name === 'evidence-product.file.read' && event.hit === false)
      .length,
    semanticReferenceCacheHits: sumField(spanEvents, 'semantic.references.cache-scan', 'cacheHits'),
    semanticReferenceMisses: sumField(spanEvents, 'semantic.references.cache-scan', 'misses'),
    semanticCalleeCacheHits: sumField(spanEvents, 'semantic.callees.cache-scan', 'cacheHits'),
    semanticCalleeMisses: sumField(spanEvents, 'semantic.callees.cache-scan', 'misses'),
    typescriptReferenceFragmentHits: sumField(spanEvents, 'typescript.reference-fragments.materialize', 'cacheHits'),
    typescriptReferenceFragmentMisses: sumField(
      spanEvents,
      'typescript.reference-fragments.materialize',
      'cacheMisses',
    ),
    typescriptReferenceFragmentComputations: sumField(
      spanEvents,
      'typescript.reference-fragments.materialize',
      'computedFiles',
    ),
    typescriptImportUsageCacheHits: sumField(spanEvents, 'typescript.import-usage.materialize', 'cacheHits'),
    typescriptImportUsageCacheMisses: sumField(spanEvents, 'typescript.import-usage.materialize', 'cacheMisses'),
    typescriptSignatureCacheHits: sumField(spanEvents, 'typescript.signature.materialize', 'cacheHits'),
    typescriptSignatureCacheMisses: sumField(spanEvents, 'typescript.signature.materialize', 'cacheMisses'),
  };
  profile.topSpans = [...spanEvents]
    .sort((left, right) => (Number(right.durationMs) || 0) - (Number(left.durationMs) || 0))
    .slice(0, 8)
    .map((event) => ({
      name: event.name,
      durationMs: event.durationMs,
      definitions: event.definitions,
      files: event.files,
      rows: event.rows,
      entries: event.entries,
      cacheHits: event.cacheHits,
      cacheMisses: event.cacheMisses,
      computedFiles: event.computedFiles,
      misses: event.misses,
      hit: event.hit,
      kind: event.kind,
    }));
  return profile;
}

function countName(events, name) {
  return events.filter((event) => event.name === name).length;
}

function sumName(events, name) {
  return events
    .filter((event) => event.name === name)
    .reduce((total, event) => total + (Number(event.durationMs) || 0), 0);
}

function sumField(events, name, field) {
  return events.filter((event) => event.name === name).reduce((total, event) => total + (Number(event[field]) || 0), 0);
}

function runOne({ repoName, repo, entry, iteration, timeoutMs, profileDir }) {
  const args = commandArgs(entry, repo);
  const profilePath = join(profileDir, `${repoName}-${entry.id}-${iteration}.jsonl`.replaceAll('/', '_'));
  const env = {
    ...process.env,
    ...repo.env,
    SCIP_QUERY_SKIP_WATCH_SERVICE: '1',
    SCIP_QUERY_PROFILE: '1',
    SCIP_QUERY_PROFILE_OUT: profilePath,
    SCIP_RUST_SEMANTIC_SETTLE_MS: process.env.SCIP_RUST_SEMANTIC_SETTLE_MS ?? '0',
    SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS: process.env.SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS ?? '1000',
  };
  const start = process.hrtime.bigint();
  const child = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo.cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 120 * 1024 * 1024,
  });
  const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
  let parsed = null;
  let parseError = null;
  try {
    parsed = child.stdout.trim() ? JSON.parse(child.stdout) : null;
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  return {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    commit: currentCommit(),
    repo: repoName,
    cwd: repo.cwd,
    commandId: entry.id,
    args,
    iteration,
    timeoutMs,
    timedOut: child.error?.code === 'ETIMEDOUT' || child.signal === 'SIGTERM',
    exitCode: child.status,
    signal: child.signal,
    durationMs,
    stdoutBytes: Buffer.byteLength(child.stdout ?? ''),
    stderrBytes: Buffer.byteLength(child.stderr ?? ''),
    stdoutSha256: hashText(child.stdout ?? ''),
    stderrTail: child.stderr ? child.stderr.slice(-1000) : '',
    jsonParsed: parseError === null,
    parseError,
    summary: parsed ? summarizeParsedJson(parsed) : null,
    profilePath,
    profile: summarizeProfile(profilePath),
  };
}

let commitCache = null;
function currentCommit() {
  if (commitCache) return commitCache;
  const result = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  commitCache = result.status === 0 ? result.stdout.trim() : 'unknown';
  return commitCache;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(opts.out), { recursive: true });
  mkdirSync(opts.profileDir, { recursive: true });
  if (!opts.append) writeFileSync(opts.out, '');
  const commands = opts.commandIds ? COMMANDS.filter((entry) => opts.commandIds.includes(entry.id)) : COMMANDS;
  const missingCommands = (opts.commandIds ?? []).filter((id) => !COMMANDS.some((entry) => entry.id === id));
  if (missingCommands.length > 0) throw new Error(`Unknown command ids: ${missingCommands.join(', ')}`);
  const repos = opts.repos.map((repoName) => {
    const repo = REPOS[repoName];
    if (!repo) throw new Error(`Unknown repo: ${repoName}`);
    if (!existsSync(repo.cwd)) throw new Error(`Repo path does not exist for ${repoName}: ${repo.cwd}`);
    return [repoName, repo];
  });

  const manifest = {
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    kind: 'manifest',
    commit: currentCommit(),
    repos: opts.repos,
    commands: commands.map((entry) => entry.id),
    excludedCommands: MUTATING_OR_UNBOUNDED_COMMANDS,
    iterations: opts.iterations,
    timeoutMs: opts.timeoutMs,
    profileDir: opts.profileDir,
  };
  appendJsonLine(opts.out, manifest);
  for (const [repoName, repo] of repos) {
    for (const entry of commands) {
      for (let iteration = 1; iteration <= opts.iterations; iteration += 1) {
        const record = runOne({
          repoName,
          repo,
          entry,
          iteration,
          timeoutMs: opts.timeoutMs,
          profileDir: opts.profileDir,
        });
        appendJsonLine(opts.out, record);
        console.error(`${repoName}\t${entry.id}\t#${iteration}\texit=${record.exitCode}\t${record.durationMs}ms`);
      }
    }
  }
}

function appendJsonLine(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: 'a' });
}

main();
