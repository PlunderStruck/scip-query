import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { afterAll, beforeAll } from 'vitest';
import { reindex, type ReindexOptions } from '../../src/reindex/index.js';
import { loadTypeScriptDocumentRuntime } from '../../src/reindex/typescript-document-emitter.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { readSqliteGenerationState } from '../../src/storage/sqlite-generation.js';
import { ensureWatchService, stopWatchService } from '../../src/runtime/watch-service.js';
import { resolveCacheDir } from '../../src/platform/cache-layout.js';
import { cleanOracle } from '../fixtures/typescript-oracle.js';

// An interactive checkout may override its cache globally. Tests and their
// children must always use the disposable repository's configured cache.
const originalCacheOverride = process.env['SCIP_QUERY_CACHE_DIR'];
beforeAll(() => {
  delete process.env['SCIP_QUERY_CACHE_DIR'];
});
afterAll(() => {
  if (originalCacheOverride === undefined) delete process.env['SCIP_QUERY_CACHE_DIR'];
  else process.env['SCIP_QUERY_CACHE_DIR'] = originalCacheOverride;
});

export const initialSources: Record<string, string> = {
  'owner.ts': 'export function value(input: number) { return input + 1; }\n',
  'bridge.ts': "export { value as shared } from './owner.js';\n",
  'consumer.ts': "import { shared } from './bridge.js';\nexport const result = shared(2);\n",
  'quiet.ts': 'export const untouched = 17;\n',
};

export class IndexerHistoryFixture {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-query-indexer-history-')));
  readonly cache: string;
  readonly sources = new Map(Object.entries(initialSources));
  readonly statuses: string[] = [];
  private watching = false;

  constructor(private readonly debounceMs = 600_000) {
    writeFileSync(join(this.root, 'package.json'), JSON.stringify({ name: 'history-fixture', version: '1.0.0' }));
    writeFileSync(
      join(this.root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          types: [],
          noLib: true,
        },
        include: ['*.ts'],
      }),
    );
    writeFileSync(
      join(this.root, '.scipquery.json'),
      JSON.stringify({
        dbPath: '.cache',
        watch: { enabled: true, debounceMs, idleTimeoutMs: 0, allowExpensiveRebuild: true },
      }),
    );
    writeFileSync(join(this.root, '.gitignore'), '.cache/\noracle.scip\n');
    for (const [file, source] of this.sources) writeFileSync(join(this.root, file), source);
    execFileSync('git', ['init', '-q', this.root]);
    execFileSync('git', ['-C', this.root, 'add', '.']);
    execFileSync('git', [
      '-C',
      this.root,
      '-c',
      'user.name=Indexer Test',
      '-c',
      'user.email=indexer@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ]);
    this.cache = resolveCacheDir(this.root, { dbPath: '.cache' });
  }

  get options(): ReindexOptions {
    return {
      projectRoot: this.root,
      outputDb: join(this.cache, 'index.db'),
      outputScip: join(this.cache, 'index.scip'),
      languages: ['typescript'],
      skipAutoInstall: true,
      onStatus: (message) => this.statuses.push(message),
    };
  }

  async index(overrides: Partial<ReindexOptions> = {}) {
    this.statuses.length = 0;
    return reindex({ ...this.options, ...overrides });
  }

  startService(): void {
    // The actual daemon and worker serve compiler requests. The long debounce
    // lets each test choose when to index without disabling file observation.
    this.watching = true;
    ensureWatchService({
      projectRoot: this.root,
      cacheDir: this.cache,
      cliVersion: '0.25.0',
      serverPath: resolve('dist/watch-server.js'),
      startupTimeoutMs: 20_000,
      watchOverrides: { debounceMs: this.debounceMs, idleTimeoutMs: 0 },
    });
  }

  async restartService(): Promise<void> {
    await this.stopService();
    this.startService();
  }

  async stopService(): Promise<void> {
    if (!this.watching) return;
    const { inspectWatchService } = await import('../../src/runtime/watch-service.js');
    const opts = { projectRoot: this.root, cacheDir: this.cache, cliVersion: '0.25.0' };
    const state = inspectWatchService(opts).classification;
    if (state.kind === 'live') {
      process.kill(state.state.pid, 'SIGTERM');
      for (let attempt = 0; attempt < 200; attempt++) {
        await delay(25);
        try {
          process.kill(state.state.pid, 0);
        } catch {
          break;
        }
      }
    }
    stopWatchService(opts);
    this.watching = false;
  }

  write(file: string, source: string | null): void {
    if (source === null) {
      this.sources.delete(file);
      rmSync(join(this.root, file), { force: true });
    } else {
      this.sources.set(file, source);
      writeFileSync(join(this.root, file), source);
    }
  }

  open(): ScipDatabase {
    return new ScipDatabase({
      projectRoot: this.root,
      dbPath: join(this.cache, 'index.db'),
      indexPath: join(this.cache, 'index.scip'),
    });
  }

  publication() {
    return readSqliteGenerationState(join(this.cache, 'index.db'));
  }

  assertCurrent(): void {
    const loaded = loadTypeScriptDocumentRuntime();
    assert.ok(loaded.available, loaded.available ? undefined : loaded.reason);
    const fresh = cleanOracle(this.root, loaded.runtime);
    const db = this.open();
    try {
      const actual = compilerFacts(db);
      const expected = [...fresh]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, bytes]) => {
          const document = loaded.runtime.Document.deserializeBinary(bytes);
          return { path, occurrences: normalizeOccurrences(document.occurrences) };
        });
      assert.deepEqual(actual, expected, 'Published compiler facts must match a clean external compiler build');
      assert.deepEqual(actual.map((document) => document.path).sort(), [...this.sources.keys()].sort());
      assert.deepEqual(db.db.prepare('PRAGMA integrity_check').all(), [{ integrity_check: 'ok' }]);
      assert.deepEqual(db.db.prepare('PRAGMA foreign_key_check').all(), []);
      const quiet = actual.find((document) => document.path === 'quiet.ts');
      assert.ok(
        quiet?.occurrences.some(
          (occurrence) => occurrence.symbol.includes('untouched.') && (occurrence.roles & 1) === 1,
        ),
      );
    } finally {
      db.close();
    }
  }

  async dispose(): Promise<void> {
    await this.stopService();
    rmSync(this.root, { recursive: true, force: true });
  }
}

function normalizeOccurrences(
  occurrences: readonly { symbol: string; symbol_roles: number; range: number[]; enclosing_range?: number[] }[],
) {
  return occurrences
    .map((occurrence) => ({
      symbol: occurrence.symbol,
      roles: occurrence.symbol_roles,
      range: occurrence.range,
      enclosing: occurrence.enclosing_range ?? [],
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function compilerFacts(db: ScipDatabase) {
  const loaded = loadTypeScriptDocumentRuntime();
  assert.ok(loaded.available, loaded.available ? undefined : loaded.reason);
  const documents = db.db
    .prepare<
      [],
      { path: string; id: number }
    >("SELECT id, relative_path AS path FROM documents WHERE relative_path LIKE '%.ts' ORDER BY relative_path")
    .all();
  return documents
    .map(({ path, id }) => {
      const chunks = db.db
        .prepare<
          [number],
          { occurrences: Buffer }
        >('SELECT occurrences FROM chunks WHERE document_id=? ORDER BY chunk_index')
        .all(id);
      const occurrences = chunks.flatMap(
        (chunk) => loaded.runtime.Document.deserializeBinary(zstdDecompressSync(chunk.occurrences)).occurrences,
      );
      return { path, occurrences: normalizeOccurrences(occurrences) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
