import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('search CLI identity and materialization contract', { timeout: 10_000 }, () => {
  const repositoryRoot = process.cwd();
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'scip-query-search-cli-'));
  const dbPath = join(fixtureRoot, 'index.db');

  beforeAll(() => {
    const fixture = evidenceFixtureDb(dbPath);
    const files: Record<string, string> = {};
    for (let index = 1; index <= 30; index += 1) {
      const relativePath = `src/group-${String(index).padStart(2, '0')}/match.ts`;
      files[relativePath] = `export const value${index} = 'needle';\n`;
      fixture.document(index, 'typescript', relativePath);
    }
    for (let index = 31; index <= 180; index += 1) {
      const group = String(Math.floor((index - 31) / 15) + 1).padStart(2, '0');
      const relativePath = `src/broad-${group}/match-${String(index).padStart(3, '0')}.ts`;
      files[relativePath] = `export const broadValue${index} = 'broad_selector_token';\n`;
      fixture.document(index, 'typescript', relativePath);
    }
    files['src/object-commands.ts'] = [
      'export const commands = {',
      '  async sourceOwnedCommand(input: unknown) {',
      '    return input;',
      '  },',
      '};',
      '',
    ].join('\n');
    fixture.document(181, 'typescript', 'src/object-commands.ts');
    files['src/anchor-download.ts'] = [
      "import { persistPaper } from './anchor-store.js';",
      'export async function executeDownload(fetchedPaper: Buffer) {',
      '  return await persistPaper(fetchedPaper);',
      '}',
      '',
    ].join('\n');
    files['src/anchor-store.ts'] = [
      "import { withMutex } from './anchor-mutex.js';",
      'export async function persistPaper(paper: Buffer) {',
      "  const localState = 'duplicate';",
      '  return await withMutex(() => reconcileInterruptedUpdate(paper));',
      '}',
      'export async function reconcileInterruptedUpdate(paper: Buffer) { return paper; }',
      '',
    ].join('\n');
    files['src/anchor-mutex.ts'] = [
      'export async function withMutex<T>(work: () => Promise<T>) {',
      '  return await work();',
      '}',
      '',
    ].join('\n');
    const expansiveFlow = [
      'export function expansiveFlow() {',
      ...Array.from(
        { length: 600 },
        (_, index) => `  // mechanically irrelevant padding ${String(index).padStart(3, '0')} ${'x'.repeat(32)}`,
      ),
      '  return true;',
      '}',
      '',
    ];
    files['src/expansive-flow.ts'] = expansiveFlow.join('\n');
    const expansiveBehavior = [
      'export function expansiveBehavior(input: number) {',
      '  let result = 0;',
      ...Array.from({ length: 650 }, (_, index) => `  if (input === ${index}) result += ${index};`),
      '  return result;',
      '}',
      '',
    ];
    files['src/expansive-behavior.ts'] = expansiveBehavior.join('\n');
    fixture
      .document(182, 'typescript', 'src/anchor-download.ts')
      .document(183, 'typescript', 'src/anchor-store.ts')
      .document(184, 'typescript', 'src/anchor-mutex.ts')
      .document(185, 'typescript', 'src/expansive-flow.ts')
      .document(186, 'typescript', 'src/expansive-behavior.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`anchor-download.ts`/executeDownload().', 'executeDownload', 12)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`anchor-store.ts`/persistPaper().', 'persistPaper', 12)
      .symbol(
        3,
        'scip-typescript npm fixture 1.0.0 src/`anchor-store.ts`/reconcileInterruptedUpdate().',
        'reconcileInterruptedUpdate',
        12,
      )
      .symbol(4, 'scip-typescript npm fixture 1.0.0 src/`anchor-mutex.ts`/withMutex().', 'withMutex', 12)
      .symbol(5, 'scip-typescript npm fixture 1.0.0 src/`expansive-flow.ts`/expansiveFlow().', 'expansiveFlow', 12)
      .symbol(
        6,
        'scip-typescript npm fixture 1.0.0 src/`expansive-behavior.ts`/expansiveBehavior().',
        'expansiveBehavior',
        12,
      )
      .definition(1, 182, 1, 1, 0, 3, 1)
      .definition(2, 183, 2, 1, 0, 4, 1)
      .definition(3, 183, 3, 5, 0, 5, 88)
      .definition(4, 184, 4, 0, 0, 2, 1)
      .definition(5, 185, 5, 0, 0, expansiveFlow.length - 2, 1)
      .definition(6, 186, 6, 0, 0, expansiveBehavior.length - 2, 1);
    writeFixtureFiles(fixtureRoot, files);
    fixture.write();
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('reports every identity while materializing only the requested representative windows', () => {
    const invocation = runSearch(['needle', '--limit', '2', '--context', '0']);

    expect(invocation.status).toBe(0);
    expect(invocation.stderr).toBe('');
    expect(invocation.stdout).toContain('MATCH IDENTITIES (30/30, COMPLETE)');
    expect(invocation.stdout).toContain('REPRESENTATIVE SOURCE (2/30 WINDOWS)');
    expect(invocation.stdout).toContain('Exact cardinality: 30 matching line(s) across 30 file(s).');
    expect(invocation.stdout).toContain('Identity manifest: 30/30 matching line(s); complete.');
    expect(invocation.stdout).toContain('Recover every unmaterialized owning unit in 2 bounded batch command(s)');
    expect(invocation.stdout).toContain('src/group-30/match.ts');
    expect(invocation.stdout).not.toContain('[scip-query output page:');
  });

  it('keeps the default locator view small while preserving the complete identity manifest', () => {
    const invocation = runSearch(['needle']);

    expect(invocation.status).toBe(0);
    expect(invocation.stdout).toContain('MATCH IDENTITIES (30/30, COMPLETE)');
    expect(invocation.stdout).toContain('REPRESENTATIVE SOURCE (6/30 WINDOWS)');
    expect(invocation.stdout).toContain('Identity manifest: 30/30 matching line(s); complete.');
  });

  it('keeps machine-readable identity coverage separate from source materialization', () => {
    const invocation = runSearch(['needle', '--limit', '2', '--context', '0', '--json']);

    expect(invocation.status).toBe(0);
    const envelope = JSON.parse(invocation.stdout);
    expect(envelope.result.identities).toHaveLength(30);
    expect(envelope.result.identityManifest).toBeUndefined();
    expect(envelope.result.matches).toHaveLength(2);
    expect(envelope.coverage).toMatchObject({ complete: true, returned: 30, total: 30, omitted: 0 });
  });

  it('uses --full only to materialize every already-known identity', () => {
    const invocation = runSearch(['needle', '--full', '--context', '0']);

    expect(invocation.status).toBe(0);
    expect(invocation.stdout).toContain('MATCH IDENTITIES (30/30, COMPLETE)');
    expect(invocation.stdout).toContain('REPRESENTATIVE SOURCE (30/30 WINDOWS)');
    expect(invocation.stdout).toContain('Every matching source window was materialized; no drilldown remains.');
  });

  it('bounds an accidentally broad identity selector before transport while preserving exact recovery scopes', () => {
    const invocation = runSearch(['broad_selector_token', '--limit', '2', '--context', '0']);

    expect(invocation.status).toBe(0);
    expect(invocation.stderr).toBe('');
    expect(invocation.stdout).toContain('MATCH IDENTITIES (64/150, BOUNDED)');
    expect(invocation.stdout).toContain('Exact cardinality: 150 matching line(s) across 150 file(s).');
    expect(invocation.stdout).toContain('Broad selector: identity enumeration stopped before output transport');
    expect(invocation.stdout).toContain("scip-query search 'broad_selector_token' --scope 'src/broad-");
    expect(invocation.stdout).not.toContain('[scip-query output page:');
    expect(invocation.stdout.length).toBeLessThan(32_000);
  });

  it('reports bounded machine-readable coverage for a broad selector', () => {
    const invocation = runSearch(['broad_selector_token', '--limit', '2', '--context', '0', '--json']);

    expect(invocation.status).toBe(0);
    const envelope = JSON.parse(invocation.stdout);
    expect(envelope.result.identities).toHaveLength(150);
    expect(envelope.result.identityManifest).toHaveLength(64);
    expect(envelope.result.identityCoverage).toEqual({ mode: 'bounded', returned: 64, total: 150, omitted: 86 });
    expect(envelope.coverage).toMatchObject({ complete: true, returned: 150, total: 150, omitted: 0 });
    expect(envelope.result.scopeHints.length).toBeGreaterThan(0);
  });

  it('attributes an unindexed object method to its exact source callable instead of the module', () => {
    const invocation = runSearch(['sourceOwnedCommand']);

    expect(invocation.status).toBe(0);
    expect(invocation.stdout).toContain('sourceOwnedCommand 2-4 @ 2');
    expect(invocation.stdout).not.toContain('<file scope> @ 2');
  });

  it('returns compact connected anchor sets without materializing function source', () => {
    const invocation = runCommand('anchors', [
      'How does a fetched paper become local state, and what protects duplicates from interrupted updates?',
      '--limit',
      '2',
    ]);

    expect(invocation.status).toBe(0);
    expect(invocation.stderr).toBe('');
    expect(invocation.stdout).toContain('NORMALIZED REPOSITORY VOCABULARY');
    expect(invocation.stdout).toContain('EVIDENCE-GROUNDED ANCHOR SETS');
    expect(invocation.stdout).toContain('executeDownload');
    expect(invocation.stdout).toContain('persistPaper');
    expect(invocation.stdout).toContain('withMutex');
    expect(invocation.stdout).toContain("--symbol 'src/anchor-store.ts:2-5'");
    expect(invocation.stdout).toContain('next abstraction (run to completion before any inspect)');
    expect(invocation.stdout).toContain('Anchor roots are locator evidence, not behavior evidence.');
    expect(invocation.stdout).toContain('Connectivity cannot make a partial set eligible.');
    expect(invocation.stdout).toContain('use the first ranked eligible set');
    expect(invocation.stdout).toContain('Never run a map and inspect concurrently.');
    expect(invocation.stdout).not.toContain('const localState');
  });

  it('mechanically requires the selected map before detail inspection in an explicit session', () => {
    const navigationEnv = {
      SCIP_QUERY_SESSION: 'search-cli-map-order',
      SCIP_QUERY_SESSION_DIR: join(fixtureRoot, '.navigation-sessions'),
    };
    const anchors = runCommand(
      'anchors',
      ['How does a fetched paper become local state, and what protects duplicates from interrupted updates?'],
      navigationEnv,
    );
    expect(anchors.status).toBe(0);

    const premature = runCommand('inspect', ['--at', 'src/anchor-store.ts:2', '--view', 'behavior'], navigationEnv);
    expect(premature.status).toBe(1);
    expect(premature.stdout).toBe('');
    expect(premature.stderr).toContain('NAVIGATION MAP REQUIRED');
    expect(premature.stderr).toContain('map and detail exploration cannot run concurrently');

    const mapped = runCommand(
      'system-map',
      ['--symbol', 'src/anchor-store.ts:2-5', '--symbol', 'src/anchor-mutex.ts:1-3'],
      navigationEnv,
    );
    expect(mapped.status).toBe(0);

    const inspected = runCommand('inspect', ['--at', 'src/anchor-store.ts:2', '--view', 'behavior'], navigationEnv);
    expect(inspected.status).toBe(0);
    expect(inspected.stdout).toContain('persistPaper');
  });

  it('replaces repeated behavior projections with session evidence receipts', () => {
    const sessionEnv = {
      SCIP_QUERY_SESSION: 'search-cli-behavior-ledger',
      SCIP_QUERY_SESSION_DIR: join(fixtureRoot, '.behavior-sessions'),
    };
    const args = ['--at', 'src/expansive-flow.ts:1', '--view', 'behavior'];

    const first = runCommand('inspect', args, sessionEnv);
    const second = runCommand('inspect', args, sessionEnv);

    expect(first.status).toBe(0);
    expect(first.stdout).toContain('expansiveFlow');
    expect(first.stdout).toContain('coverage:');
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('unit evidence previously emitted: receipt');
    expect(second.stdout).not.toContain('coverage:');
    expect(second.stdout.length).toBeLessThan(first.stdout.length);
  });

  it('refuses an accidentally broad exact-source inspect before transport and preserves compact recovery', () => {
    const refused = runCommand('inspect', ['--at', 'src/expansive-flow.ts:1', '--view', 'source']);

    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('INSPECT SOURCE PACKET REFUSED');
    expect(refused.stderr).toContain('No partial source was emitted.');
    expect(refused.stderr).toContain("scip-query inspect --at 'src/expansive-flow.ts:1' --view behavior");
    expect(refused.stderr).toContain('--allow-large-source');

    const compact = runCommand('inspect', ['--at', 'src/expansive-flow.ts:1', '--view', 'behavior']);
    expect(compact.status).toBe(0);
    expect(compact.stderr).toBe('');
    expect(compact.stdout).toContain('expansiveFlow');
    expect(compact.stdout.length).toBeLessThan(5_000);
  });

  it('requires an interior focus for oversized behavior and does not let --full bypass the contract', () => {
    for (const extraArgs of [[], ['--full']]) {
      const refused = runCommand('inspect', [
        '--at',
        'src/expansive-behavior.ts:1',
        '--view',
        'behavior',
        ...extraArgs,
      ]);

      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toContain('INSPECT BEHAVIOR FOCUS REQUIRED');
      expect(refused.stderr).toContain('No partial behavior was emitted');
      expect(refused.stderr).toContain('interior file:line locations');
      expect(refused.stderr).toContain('--allow-large-behavior');
    }
  });

  function runSearch(args: readonly string[]): ReturnType<typeof spawnSync> {
    return runCommand('search', args);
  }

  function runCommand(
    command: string,
    args: readonly string[],
    extraEnvironment: Readonly<Record<string, string>> = {},
  ): ReturnType<typeof spawnSync> {
    return spawnSync(
      join(repositoryRoot, 'node_modules', '.bin', 'vite-node'),
      ['--script', join(repositoryRoot, 'src', 'runtime', 'cli.ts'), command, ...args],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          SCIP_QUERY_PROJECT_ROOT: fixtureRoot,
          SCIP_QUERY_INDEX_DB: dbPath,
          SCIP_QUERY_INDEX_SCIP: join(fixtureRoot, 'index.scip'),
          SCIP_QUERY_CACHE_DIR: join(fixtureRoot, '.cache'),
          SCIP_QUERY_SHARED_CACHE: '0',
          SCIP_QUERY_UPDATE_CHECK: '0',
          XDG_CACHE_HOME: join(fixtureRoot, '.xdg-cache'),
          ...extraEnvironment,
        },
      },
    );
  }
});
