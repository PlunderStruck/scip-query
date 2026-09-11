import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { it, vi } from 'vitest';
import { compilerFacts, IndexerHistoryFixture } from '../properties/indexer-history-fixture.js';
import { isTypeScriptCompilerShardConfigPath } from '../../src/platform/typescript-projects.js';

const require = createRequire(import.meta.url);
const compilerRoot = dirname(require.resolve('@sourcegraph/scip-typescript/package.json'));
const failureSource = [
  "import { value } from './owner.js';",
  'export function before() { return value(7); }',
  'export function tripwire() { return before(); }',
  'export function after() { return tripwire(); }',
  '',
].join('\n');

class FailureFixture extends IndexerHistoryFixture {
  readonly modePath = join(this.cache, 'visitor-failure-mode');
  readonly receiptPath = join(this.cache, 'visitor-failures.jsonl');
  readonly preloadPath = join(this.cache, 'visitor-failure.cjs');

  constructor() {
    super();
    this.write('z-failure.ts', failureSource);
    writeFileSync(join(this.root, '.scipquery.json'), JSON.stringify({ dbPath: '.cache', watch: { enabled: false } }));
    mkdirSync(this.cache, { recursive: true });
    writeFileSync(this.modePath, 'off');
    // Inject a real visitor exception, never a forged compiler result or database.
    // A mutable mode file lets the same watcher recover without restarting it.
    writeFileSync(
      this.preloadPath,
      `const fs = require('node:fs');
const { FileIndexer } = require(${JSON.stringify(join(compilerRoot, 'dist/src/FileIndexer.js'))});
const projects = require(${JSON.stringify(join(compilerRoot, 'dist/src/ProjectIndexer.js'))});
const OriginalProject = projects.ProjectIndexer;
projects.ProjectIndexer = class extends OriginalProject {
  constructor(config, options, cache) {
    const previous = new Map(cache.sources);
    super(config, options, cache);
    fs.appendFileSync(${JSON.stringify(this.receiptPath)}, JSON.stringify({
      kind: 'compiler-project', process: process.argv[1], file: options.projectRoot, occurrences: 0,
      rootFiles: config.fileNames.length,
      reusedSources: this.program.getSourceFiles().filter(source => previous.get(source.fileName)?.[0] === source).length,
    }) + '\\n');
  }
};
const mode = () => fs.readFileSync(${JSON.stringify(this.modePath)}, 'utf8');
const record = (indexer, kind) => fs.appendFileSync(${JSON.stringify(this.receiptPath)}, JSON.stringify({
  kind, process: process.argv[1], file: indexer.sourceFile.fileName,
  occurrences: indexer.document.occurrences.length,
}) + '\\n');
const fail = indexer => {
  record(indexer, 'failed');
  throw new Error('INJECTED_TYPESCRIPT_VISITOR_FAILURE');
};
const originalIndex = FileIndexer.prototype.index;
FileIndexer.prototype.index = function() {
  const target = this.sourceFile.fileName.endsWith('/z-failure.ts');
  if (target && mode() === 'before-file') fail(this);
  originalIndex.call(this);
  if (target && mode() === 'after-file') fail(this);
  if (target && mode() === 'warning') console.error('unexpected error indexing: harmless test diagnostic');
  record(this, 'completed');
};
const originalVisit = FileIndexer.prototype.visit;
FileIndexer.prototype.visit = function(node) {
  if (this.sourceFile.fileName.endsWith('/z-failure.ts') && mode() === 'mid-file' && node.text === 'tripwire') fail(this);
  return originalVisit.call(this, node);
};
`,
    );
  }

  runCli(args: string[], inject = false) {
    const env = { ...process.env };
    delete env['SCIP_QUERY_CACHE_DIR'];
    delete env['SCIP_QUERY_SESSION'];
    if (inject) env['NODE_OPTIONS'] = `${env['NODE_OPTIONS'] ?? ''} --require=${JSON.stringify(this.preloadPath)}`;
    const result = spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], {
      cwd: this.root,
      env,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
  }

  receipts(): {
    kind: string;
    process: string;
    file: string;
    occurrences: number;
    rootFiles?: number;
    reusedSources?: number;
  }[] {
    return readFileSync(this.receiptPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  }

  assertDefinitions(): void {
    const db = new Database(join(this.cache, 'index.db'), { readonly: true });
    try {
      const symbols = db
        .prepare(
          `SELECT s.symbol FROM defn_enclosing_ranges r
        JOIN documents d ON d.id = r.document_id JOIN global_symbols s ON s.id = r.symbol_id
        WHERE d.relative_path = ? ORDER BY s.symbol`,
        )
        .pluck()
        .all('z-failure.ts');
      assert.deepEqual(symbols, [
        'scip-typescript npm history-fixture 1.0.0 `z-failure.ts`/',
        'scip-typescript npm history-fixture 1.0.0 `z-failure.ts`/after().',
        'scip-typescript npm history-fixture 1.0.0 `z-failure.ts`/before().',
        'scip-typescript npm history-fixture 1.0.0 `z-failure.ts`/tripwire().',
      ]);
    } finally {
      db.close();
    }
    const indexed = this.open();
    try {
      const file = compilerFacts(indexed).find((document) => document.path === 'z-failure.ts');
      assert.ok(file);
      // These expected call bindings come from the fixture source, not a
      // second compiler execution that could repeat the same omission.
      const calls = file.occurrences.filter((occurrence) => occurrence.roles === 0 && occurrence.range[0] >= 1);
      assert.deepEqual(
        calls.map(({ symbol, range }) => ({ symbol, line: range[0] })).sort((a, b) => a.line - b.line),
        [
          { symbol: 'scip-typescript npm history-fixture 1.0.0 `owner.ts`/value().', line: 1 },
          { symbol: 'scip-typescript npm history-fixture 1.0.0 `z-failure.ts`/before().', line: 2 },
          { symbol: 'scip-typescript npm history-fixture 1.0.0 `z-failure.ts`/tripwire().', line: 3 },
        ],
      );
    } finally {
      indexed.close();
    }
  }

  databaseDigest(): string {
    return createHash('sha256')
      .update(readFileSync(join(this.cache, 'index.db')))
      .digest('hex');
  }
}

it.each(['before-file', 'mid-file', 'after-file'])(
  'rejects a full compiler failure %s on first build and replacement, then recovers',
  async (mode) => {
    const fixture = new FailureFixture();
    try {
      writeFileSync(fixture.modePath, mode);
      const failed = fixture.runCli(['reindex', '--force', '--allow-expensive-rebuild'], true);
      assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
      assert.match(failed.stdout + failed.stderr, /z-failure\.ts/);
      assert.match(failed.stdout + failed.stderr, /INJECTED_TYPESCRIPT_VISITOR_FAILURE/);
      assert.equal(existsSync(join(fixture.cache, 'index.db')), false);
      assert.equal(fixture.publication(), null);
      const receipts = fixture.receipts();
      const failure = receipts.find((record) => record.kind === 'failed');
      assert.ok(failure);
      assert.equal(failure.occurrences > 0, mode !== 'before-file');
      assert.ok(receipts.some((record) => record.kind === 'completed' && record.file.endsWith('/owner.ts')));

      await fixture.index();
      fixture.assertDefinitions();
      const generation = fixture.publication()!.currentGeneration;
      const digest = fixture.databaseDigest();
      fixture.write('z-failure.ts', failureSource.replace('value(7)', 'value(8)'));
      // Even explicit partial-language permission must not accept a broken
      // TypeScript artifact when no language completed successfully.
      const replacement = fixture.runCli(['reindex', '--force', '--allow-expensive-rebuild', '--allow-partial'], true);
      assert.notEqual(replacement.status, 0, replacement.stdout + replacement.stderr);
      assert.equal(fixture.publication()!.currentGeneration, generation);
      assert.equal(fixture.databaseDigest(), digest);
      fixture.assertDefinitions();

      const recovered = fixture.runCli(['reindex', '--allow-expensive-rebuild']);
      assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
      assert.notEqual(fixture.publication()!.currentGeneration, generation);
      fixture.assertDefinitions();
      fixture.assertCurrent();
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);

it('rejects the complete language output when one real compiler shard fails', async () => {
  const fixture = new FailureFixture();
  vi.stubEnv('SCIP_QUERY_TS_COMPILER_SHARD_FILES', '1');
  vi.stubEnv('SCIP_QUERY_TS_COMPILER_SHARD_CONCURRENCY', '2');
  try {
    await fixture.index();
    const generation = fixture.publication()!.currentGeneration;
    const digest = fixture.databaseDigest();
    writeFileSync(fixture.modePath, 'mid-file');
    const result = fixture.runCli(['reindex', '--force', '--allow-expensive-rebuild'], true);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /compiler worker/);
    assert.equal(fixture.publication()!.currentGeneration, generation);
    assert.equal(fixture.databaseDigest(), digest);
    assert.deepEqual(readdirSync(fixture.root).filter(isTypeScriptCompilerShardConfigPath), []);
    const receipts = fixture.receipts();
    assert.ok(receipts.some((record) => record.kind === 'completed'));
    assert.ok(
      receipts.some((record) => record.kind === 'failed' && basename(record.process) === 'typescript-indexer.js'),
    );
    writeFileSync(fixture.modePath, 'off');
    const recovered = fixture.runCli(['reindex', '--force', '--allow-expensive-rebuild'], true);
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    assert.deepEqual(readdirSync(fixture.root).filter(isTypeScriptCompilerShardConfigPath), []);
    const projects = fixture.receipts().filter((record) => record.kind === 'compiler-project');
    assert.ok(projects.every((record) => record.rootFiles === fixture.sources.size));
    assert.ok(projects.some((record) => record.reusedSources === fixture.sources.size));
    fixture.assertDefinitions();
    fixture.assertCurrent();
  } finally {
    await fixture.dispose();
    vi.unstubAllEnvs();
  }
}, 120_000);

it('accepts completed compiler traversal even when stderr contains an error-like diagnostic', async () => {
  const fixture = new FailureFixture();
  try {
    writeFileSync(fixture.modePath, 'warning');
    const result = fixture.runCli(['reindex', '--force', '--allow-expensive-rebuild'], true);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    fixture.assertDefinitions();
  } finally {
    await fixture.dispose();
  }
}, 120_000);

it('preserves the accepted generation after incremental visitor failure and failed full fallback, then recovers', async () => {
  const fixture = new FailureFixture();
  writeFileSync(
    join(fixture.root, '.scipquery.json'),
    JSON.stringify({
      dbPath: '.cache',
      watch: { enabled: true, debounceMs: 600_000, idleTimeoutMs: 0, allowExpensiveRebuild: true },
    }),
  );
  try {
    await fixture.index();
    fixture.assertDefinitions();
    const generation = fixture.publication()!.currentGeneration;
    const digest = fixture.databaseDigest();
    vi.stubEnv('NODE_OPTIONS', `${process.env['NODE_OPTIONS'] ?? ''} --require=${JSON.stringify(fixture.preloadPath)}`);
    fixture.startService();
    writeFileSync(fixture.modePath, 'mid-file');
    fixture.write('z-failure.ts', failureSource.replace('value(7)', 'value(8)'));
    await assert.rejects(fixture.index(), /INJECTED_TYPESCRIPT_VISITOR_FAILURE/);
    assert.match(
      fixture.statuses.join('\n'),
      /Incremental TypeScript index unavailable:.*INJECTED_TYPESCRIPT_VISITOR_FAILURE/,
    );
    assert.equal(fixture.publication()!.currentGeneration, generation);
    assert.equal(fixture.databaseDigest(), digest);
    const failures = fixture.receipts().filter((record) => record.kind === 'failed');
    assert.ok(
      failures.some((record) => basename(record.process) === 'typescript-mailbox-worker.js'),
      JSON.stringify(failures),
    );
    assert.ok(failures.some((record) => basename(record.process) === 'typescript-indexer.js'));

    const status = fixture.runCli(['--json-output', join(fixture.cache, 'failed-status.json'), 'status', '--json']);
    assert.equal(status.status, 0, status.stderr);
    const report = JSON.parse(readFileSync(join(fixture.cache, 'failed-status.json'), 'utf8')).result;
    assert.equal(report.ok, false);
    assert.equal(report.freshness.state, 'stale');
    assert.match(report.watchService.typescriptIndex.lastError, /INJECTED_TYPESCRIPT_VISITOR_FAILURE/);

    writeFileSync(fixture.modePath, 'off');
    await fixture.index();
    assert.equal(fixture.publication()!.publication?.mode, 'incremental');
    assert.notEqual(fixture.publication()!.currentGeneration, generation);
    fixture.assertDefinitions();
    fixture.assertCurrent();
  } finally {
    await fixture.dispose();
    vi.unstubAllEnvs();
  }
}, 120_000);
