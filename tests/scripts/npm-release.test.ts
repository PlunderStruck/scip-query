import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createNpmReleaseRuntime,
  formatNpmReleaseError,
  runNpmRelease,
  type NpmReleaseRuntime,
} from '../../scripts/npm-release.js';
import {
  NPM_RELEASE_STATE_KIND,
  parseNpmReleaseStateJson,
  type NpmReleaseStage,
  type NpmReleaseState,
} from '../../scripts/npm-release-state.js';
import { hashTarball } from '../../scripts/scip-windows-package-identity.js';
import {
  createWindowsSidecarProvenance,
  WINDOWS_SIDECAR_PROVENANCE_FILE,
} from '../../scripts/scip-windows-provenance.mjs';
import { WindowsSidecarCommandError, type WindowsSidecarCommandOptions } from '../../scripts/scip-windows-release.js';
import { writeNpmPackFixture } from './scip-windows-package-fixture.js';

const SOURCE_COMMIT = 'bf70486060b71bed40f3d6dd19c96da4b3239ead';

type PackageRole = 'sidecar' | 'main';
type RegistryState = 'absent' | 'same' | 'different' | 'ambiguous';
type PublishBehavior = 'succeed' | 'succeed-invisible' | 'fail-absent' | 'conflict-same' | 'conflict-different';

interface RecordedCommand {
  name: string;
  args: string[];
  options: WindowsSidecarCommandOptions;
}

describe('ordered npm release coordinator', () => {
  it('preflights and packs both packages before a dry-run reads registry state without publishing', async () => {
    await withFixture(async (fixture) => {
      const result = runNpmRelease(fixture.runtime, { mode: 'dry-run' });

      expect(fixture.commandNames()).toEqual([
        'git-revision',
        'git-status',
        'registry-config',
        'preflight-typecheck',
        'preflight-audit',
        'preflight-test',
        'preflight-lint',
        'pack-sidecar',
        'pack-main',
        'git-revision',
        'git-status',
        'view-sidecar',
        'view-main',
      ]);
      expect(result.state.completedStages).toEqual(['local-preflight-complete']);
      expect(result.state.source.gitRevision).toBe(fixture.gitRevision);
      expect(result.state.source.registry).toBe(fixture.registryUrl);
      expect(fixture.logs.join('\n')).toContain('no registry mutation performed');
      expect(fixture.stateWrites()).toHaveLength(1);
    });
  });

  it('publishes and verifies the sidecar before publishing and verifying the main package', async () => {
    await withFixture(async (fixture) => {
      const result = runNpmRelease(fixture.runtime);
      const names = fixture.commandNames();

      expect(names.indexOf('pack-main')).toBeLessThan(names.indexOf('publish-sidecar'));
      expect(names.indexOf('publish-sidecar')).toBeLessThan(names.lastIndexOf('view-sidecar'));
      expect(names.lastIndexOf('view-sidecar')).toBeLessThan(names.indexOf('publish-main'));
      expect(names.indexOf('publish-main')).toBeLessThan(names.lastIndexOf('view-main'));
      expect(result.state.completedStages).toEqual([
        'local-preflight-complete',
        'sidecar-registry-verified',
        'main-registry-verified',
      ]);
      expect(fixture.registry).toEqual({ sidecar: 'same', main: 'same' });
      expect(fixture.published).toEqual(['sidecar', 'main']);
      expect(fixture.calls.every((call) => call.options.timeoutMs > 0)).toBe(true);
      for (const call of fixture.calls.filter(
        (candidate) =>
          candidate.name.startsWith('view-') ||
          candidate.name.startsWith('pack-registry-') ||
          candidate.name.startsWith('publish-'),
      )) {
        expect(call.args.slice(-2)).toEqual(['--registry', fixture.registryUrl]);
      }
    });
  });

  it('makes a main-pack failure occur before state publication or registry mutation', async () => {
    await withFixture(async (fixture) => {
      fixture.failMainPack = true;

      expect(() => runNpmRelease(fixture.runtime)).toThrow('injected main pack failure');
      expect(fixture.commandNames()).not.toContain('view-sidecar');
      expect(fixture.commandNames().some((name) => name.startsWith('publish-'))).toBe(false);
      expect(fixture.stateWrites()).toHaveLength(0);
    });
  });

  it('requires the packed main package to carry the exact reviewed sidecar pin', async () => {
    await withFixture(async (fixture) => {
      fixture.packedMainSidecarPin = '0.13.0';

      expect(() => runNpmRelease(fixture.runtime)).toThrow(
        'optionalDependencies pin (0.13.0) != packages/scip-windows version (0.13.1)',
      );
      expect(fixture.commandNames().some((name) => name.startsWith('view-'))).toBe(false);
      expect(fixture.stateWrites()).toHaveLength(0);
    });
  });

  it('requires one clean unchanged Git revision before registry work', async () => {
    await withFixture(async (fixture) => {
      fixture.workingTreeChanges = ' M src/changed.ts\n';

      expect(() => runNpmRelease(fixture.runtime)).toThrow('The working tree is dirty');
      expect(fixture.commandNames()).toEqual(['git-revision', 'git-status']);
      expect(fixture.stateWrites()).toHaveLength(0);
    });

    await withFixture(async (fixture) => {
      fixture.postPackGitRevision = 'e'.repeat(40);

      expect(() => runNpmRelease(fixture.runtime)).toThrow('Git HEAD changed during release preflight');
      expect(fixture.commandNames().some((name) => name.startsWith('view-'))).toBe(false);
      expect(fixture.stateWrites()).toHaveLength(0);
    });
  });

  it('rejects untracked package inputs that the recorded Git revision cannot identify', async () => {
    await withFixture(async (fixture) => {
      fixture.workingTreeChanges = '?? skills/unreviewed/SKILL.md\n';

      expect(() => runNpmRelease(fixture.runtime)).toThrow('The working tree is dirty');
      const status = fixture.calls.find((call) => call.name === 'git-status');
      expect(status?.args).toEqual(['status', '--porcelain=v1', '--untracked-files=all']);
      expect(fixture.commandNames()).toEqual(['git-revision', 'git-status']);
      expect(fixture.stateWrites()).toHaveLength(0);
    });
  });

  it('pins one credential-free HTTPS registry before preflight or mutation', async () => {
    await withFixture(async (fixture) => {
      fixture.registryUrl = 'http://registry.example.test/';

      expect(() => runNpmRelease(fixture.runtime)).toThrow('npm registry must be a credential-free HTTPS URL');
      expect(fixture.commandNames()).toEqual(['git-revision', 'git-status', 'registry-config']);
      expect(fixture.stateWrites()).toHaveLength(0);
    });
  });

  it('checks both existing identities before the first publish', async () => {
    await withFixture(async (fixture) => {
      fixture.registry.main = 'different';

      expect(() => runNpmRelease(fixture.runtime)).toThrow('main package content changed, so bump its version');
      expect(fixture.commandNames().some((name) => name.startsWith('publish-'))).toBe(false);
    });
  });

  it.each(['sidecar', 'main'] as const)(
    'fails closed on ambiguous %s registry state before the first publish',
    async (role) => {
      await withFixture(async (fixture) => {
        fixture.registry[role] = 'ambiguous';

        expect(() => runNpmRelease(fixture.runtime)).toThrow(
          `Could not determine registry identity for ${packageCoordinate(role).name}`,
        );
        expect(fixture.commandNames().some((name) => name.startsWith('publish-'))).toBe(false);
      });
    },
  );

  it('records sidecar success, survives main failure, and resumes without republishing the sidecar', async () => {
    await withFixture(async (fixture) => {
      fixture.publishBehavior.main = 'fail-absent';

      expect(() => runNpmRelease(fixture.runtime)).toThrow('injected main publish failure');
      expect(fixture.currentState().completedStages).toEqual(['local-preflight-complete', 'sidecar-registry-verified']);
      expect(fixture.published).toEqual(['sidecar']);

      fixture.publishBehavior.main = 'succeed';
      fixture.resetCalls();
      const retried = runNpmRelease(fixture.runtime);

      expect(fixture.commandNames()).not.toContain('publish-sidecar');
      expect(fixture.commandNames()).toContain('publish-main');
      expect(retried.state.completedStages).toEqual([
        'local-preflight-complete',
        'sidecar-registry-verified',
        'main-registry-verified',
      ]);
      expect(fixture.published).toEqual(['sidecar', 'main']);
    });
  });

  it('accepts an identical concurrent sidecar winner and rejects a different winner before main publication', async () => {
    await withFixture(async (fixture) => {
      fixture.registry.main = 'same';
      fixture.publishBehavior.sidecar = 'conflict-same';

      const result = runNpmRelease(fixture.runtime);

      expect(result.state.completedStages).toEqual([
        'local-preflight-complete',
        'sidecar-registry-verified',
        'main-registry-verified',
      ]);
      expect(fixture.logs.join('\n')).toContain('winning registry identity is exact');
    });

    await withFixture(async (fixture) => {
      fixture.registry.main = 'same';
      fixture.publishBehavior.sidecar = 'conflict-different';

      expect(() => runNpmRelease(fixture.runtime)).toThrow('sidecar content changed, so bump its version');
      expect(fixture.commandNames()).not.toContain('publish-main');
    });
  });

  it('reconciles an identical main-package conflict and rejects a different one', async () => {
    await withFixture(async (fixture) => {
      fixture.registry.sidecar = 'same';
      fixture.publishBehavior.main = 'conflict-same';
      expect(runNpmRelease(fixture.runtime).state.completedStages).toContain('main-registry-verified');
    });

    await withFixture(async (fixture) => {
      fixture.registry.sidecar = 'same';
      fixture.publishBehavior.main = 'conflict-different';
      expect(() => runNpmRelease(fixture.runtime)).toThrow('main package content changed, so bump its version');
    });
  });

  it('preserves both an ambiguous publish failure and its failed registry reconciliation', async () => {
    await withFixture(async (fixture) => {
      fixture.registry.main = 'same';
      fixture.publishBehavior.sidecar = 'conflict-same';
      fixture.crashOnPostPublishView = 'sidecar';

      let observed: unknown;
      try {
        runNpmRelease(fixture.runtime);
      } catch (error) {
        observed = error;
      }

      expect(observed).toBeInstanceOf(AggregateError);
      expect(formatNpmReleaseError(observed)).toContain('injected sidecar publish conflict');
      expect(formatNpmReleaseError(observed)).toContain('simulated crash after sidecar publication');
      expect(fixture.commandNames()).not.toContain('publish-main');
    });
  });

  it.each<[string, { stateStage?: NpmReleaseStage; postPublishRole?: PackageRole }]>([
    ['after durable preflight state', { stateStage: 'local-preflight-complete' }],
    ['after sidecar publication', { postPublishRole: 'sidecar' }],
    ['after durable sidecar state', { stateStage: 'sidecar-registry-verified' }],
    ['after main publication', { postPublishRole: 'main' }],
    ['after durable main state', { stateStage: 'main-registry-verified' }],
  ])('recovers a simulated crash %s', async (_label, crash) => {
    await withFixture(async (fixture) => {
      fixture.crashAfterStateStage = crash.stateStage;
      fixture.crashOnPostPublishView = crash.postPublishRole;

      expect(() => runNpmRelease(fixture.runtime)).toThrow('simulated crash');
      fixture.resetCalls();
      const retried = runNpmRelease(fixture.runtime);

      expect(retried.state.completedStages).toEqual([
        'local-preflight-complete',
        'sidecar-registry-verified',
        'main-registry-verified',
      ]);
      expect(fixture.published.filter((role) => role === 'sidecar')).toHaveLength(1);
      expect(fixture.published.filter((role) => role === 'main')).toHaveLength(1);
    });
  });

  it.each([
    ['malformed', Buffer.from('{'), 'not valid JSON'],
    [
      'future',
      Buffer.from(JSON.stringify({ kind: NPM_RELEASE_STATE_KIND, schemaVersion: 2 })),
      'Unsupported npm release state schema 2',
    ],
  ])('fails closed on a %s local release-state artifact', async (_label, corrupt, expected) => {
    await withFixture(async (fixture) => {
      const initial = runNpmRelease(fixture.runtime, { mode: 'dry-run' });
      fixture.states.set(initial.statePath, corrupt);
      fixture.resetCalls();

      expect(() => runNpmRelease(fixture.runtime)).toThrow(expected);
      expect(fixture.commandNames().some((name) => name.startsWith('view-'))).toBe(false);
      expect(fixture.commandNames().some((name) => name.startsWith('publish-'))).toBe(false);
    });
  });

  it('rejects changed same-version local bytes against the prior state before registry work', async () => {
    await withFixture(async (fixture) => {
      runNpmRelease(fixture.runtime, { mode: 'dry-run' });
      fixture.mainPayload = 'changed-same-version-main';
      fixture.resetCalls();

      expect(() => runNpmRelease(fixture.runtime)).toThrow('records different source or package bytes');
      expect(fixture.commandNames().some((name) => name.startsWith('view-'))).toBe(false);
    });
  });

  it('stops before registry reads when the initial durable-state write fails', async () => {
    await withFixture(async (fixture) => {
      fixture.failStateWriteAt = 1;

      expect(() => runNpmRelease(fixture.runtime)).toThrow('injected release-state write failure');
      expect(fixture.commandNames().some((name) => name.startsWith('view-'))).toBe(false);
      expect(fixture.commandNames().some((name) => name.startsWith('publish-'))).toBe(false);
      expect(fixture.states.size).toBe(0);
    });
  });

  it('reconciles sidecar registry truth after a post-publish state write fails', async () => {
    await withFixture(async (fixture) => {
      fixture.failStateWriteAt = 2;

      expect(() => runNpmRelease(fixture.runtime)).toThrow('injected release-state write failure');
      expect(fixture.published).toEqual(['sidecar']);
      expect(fixture.currentState().completedStages).toEqual(['local-preflight-complete']);

      fixture.failStateWriteAt = undefined;
      fixture.resetCalls();
      const retried = runNpmRelease(fixture.runtime);

      expect(fixture.commandNames()).not.toContain('publish-sidecar');
      expect(fixture.published).toEqual(['sidecar', 'main']);
      expect(retried.state.completedStages).toEqual([
        'local-preflight-complete',
        'sidecar-registry-verified',
        'main-registry-verified',
      ]);
    });
  });

  it('rejects lock contention before preflight', async () => {
    await withFixture(async (fixture) => {
      fixture.lockContended = true;

      expect(() => runNpmRelease(fixture.runtime)).toThrow('another release owns the lock');
      expect(fixture.calls).toHaveLength(0);
    });
  });

  it.each(['temporary-directory creation', 'temporary-directory cleanup'] as const)(
    'releases ownership even when %s fails',
    async (failure) => {
      await withFixture(async (fixture) => {
        fixture.failTempDirectory = failure === 'temporary-directory creation';
        fixture.failCleanup = failure === 'temporary-directory cleanup';

        expect(() => runNpmRelease(fixture.runtime, { mode: 'dry-run' })).toThrow('injected temporary');
        expect(fixture.lockReleaseCount).toBe(1);
      });
    },
  );

  it('preserves the primary failure when cleanup also fails', async () => {
    await withFixture(async (fixture) => {
      fixture.failMainPack = true;
      fixture.failCleanup = true;

      let observed: unknown;
      try {
        runNpmRelease(fixture.runtime);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(AggregateError);
      expect((observed as AggregateError).errors.map(String).join('\n')).toContain('injected main pack failure');
      expect((observed as AggregateError).errors.map(String).join('\n')).toContain(
        'injected temporary-directory cleanup failure',
      );
      expect(formatNpmReleaseError(observed)).toContain('injected main pack failure');
      expect(formatNpmReleaseError(observed)).toContain('injected temporary-directory cleanup failure');
      expect(fixture.lockReleaseCount).toBe(1);
    });
  });

  it('fails the command if release-lock ownership changes during finalization', async () => {
    await withFixture(async (fixture) => {
      fixture.lockReleaseSucceeds = false;

      expect(() => runNpmRelease(fixture.runtime, { mode: 'dry-run' })).toThrow('npm release lock ownership changed');
    });
  });

  it('uses bounded visibility retries after an apparently successful but not-yet-visible publish', async () => {
    await withFixture(async (fixture) => {
      fixture.publishBehavior.sidecar = 'succeed-invisible';
      fixture.registry.main = 'same';

      expect(() => runNpmRelease(fixture.runtime)).toThrow('was not visible with the intended identity');
      expect(fixture.waits).toEqual([0, 500, 1_000, 2_000]);
      expect(fixture.commandNames().filter((name) => name === 'view-sidecar')).toHaveLength(5);
      expect(fixture.commandNames()).not.toContain('publish-main');
    });
  });

  it('recognizes a fully published exact release without republishing either package', async () => {
    await withFixture(async (fixture) => {
      fixture.registry = { sidecar: 'same', main: 'same' };

      const result = runNpmRelease(fixture.runtime);

      expect(fixture.published).toEqual([]);
      expect(result.state.completedStages).toEqual([
        'local-preflight-complete',
        'sidecar-registry-verified',
        'main-registry-verified',
      ]);
    });
  });

  it('builds the production runtime on the shared durable lock and atomic-state mechanisms', () => {
    const runtime = createNpmReleaseRuntime();
    const root = mkdtempSync(join(tmpdir(), 'scip-query-npm-release-runtime-'));
    try {
      const lock = runtime.acquireReleaseLock(join(root, 'nested', 'release.lock'), {});
      expect(runtime.cwd()).toBe(process.cwd());
      expect(lock.release()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

interface ReleaseFixture {
  runtime: NpmReleaseRuntime;
  calls: RecordedCommand[];
  logs: string[];
  states: Map<string, Buffer>;
  registry: Record<PackageRole, RegistryState>;
  publishBehavior: Record<PackageRole, PublishBehavior>;
  published: PackageRole[];
  failMainPack: boolean;
  mainPayload: string;
  packedMainSidecarPin: string;
  crashAfterStateStage?: NpmReleaseStage;
  crashOnPostPublishView?: PackageRole;
  lockContended: boolean;
  lockReleaseCount: number;
  failCleanup: boolean;
  failTempDirectory: boolean;
  failStateWriteAt?: number;
  gitRevision: string;
  lockReleaseSucceeds: boolean;
  postPackGitRevision?: string;
  registryUrl: string;
  workingTreeChanges: string;
  waits: number[];
  commandNames(): string[];
  currentState(): NpmReleaseState;
  resetCalls(): void;
  stateWrites(): string[];
}

function createFixture(root: string): ReleaseFixture {
  const sidecarDir = writeSyntheticPackages(root);
  const provenanceBytes = readFileSync(join(sidecarDir, WINDOWS_SIDECAR_PROVENANCE_FILE));
  const calls: RecordedCommand[] = [];
  const logs: string[] = [];
  const states = new Map<string, Buffer>();
  const stateWritePaths: string[] = [];
  let clock = 0;
  let registrySeed = 0;
  let crashAfterStateStage: NpmReleaseStage | undefined;
  let crashOnPostPublishView: PackageRole | undefined;
  let lockReleased = false;
  let gitRevisionReads = 0;
  let stateWriteCount = 0;

  const fixture: ReleaseFixture = {
    runtime: undefined as unknown as NpmReleaseRuntime,
    calls,
    logs,
    states,
    registry: { sidecar: 'absent', main: 'absent' },
    publishBehavior: { sidecar: 'succeed', main: 'succeed' },
    published: [],
    failMainPack: false,
    mainPayload: 'main-package-content',
    packedMainSidecarPin: '0.13.1',
    lockContended: false,
    lockReleaseCount: 0,
    failCleanup: false,
    failTempDirectory: false,
    gitRevision: 'd'.repeat(40),
    lockReleaseSucceeds: true,
    registryUrl: 'https://registry.npmjs.org/',
    workingTreeChanges: '',
    waits: [],
    commandNames: () => calls.map((call) => call.name),
    currentState: () => {
      const latest = [...states.values()].at(-1);
      if (!latest) throw new Error('release state is missing');
      return parseNpmReleaseStateJson(latest);
    },
    resetCalls: () => calls.splice(0, calls.length),
    stateWrites: () => [...stateWritePaths],
    get crashAfterStateStage() {
      return crashAfterStateStage;
    },
    set crashAfterStateStage(value) {
      crashAfterStateStage = value;
    },
    get crashOnPostPublishView() {
      return crashOnPostPublishView;
    },
    set crashOnPostPublishView(value) {
      crashOnPostPublishView = value;
    },
  };

  fixture.runtime = {
    acquireReleaseLock() {
      if (fixture.lockContended) throw new Error('another release owns the lock');
      lockReleased = false;
      return {
        release: () => {
          if (lockReleased) return false;
          lockReleased = true;
          fixture.lockReleaseCount += 1;
          return fixture.lockReleaseSucceeds;
        },
      };
    },
    cwd: () => root,
    env: {},
    log: (message) => logs.push(message),
    makeTempDirectory: (prefix) => {
      if (fixture.failTempDirectory) throw new Error('injected temporary-directory creation failure');
      return mkdtempSync(prefix);
    },
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    now: () => new Date(Date.UTC(2026, 6, 25, 0, 0, clock++)).toISOString(),
    readFile: readFileSync,
    readOptionalFile: (path) => states.get(path) ?? null,
    removeTree: (path) => {
      if (fixture.failCleanup) throw new Error('injected temporary-directory cleanup failure');
      rmSync(path, { recursive: true, force: true });
    },
    run: (binary, args, options) => {
      const name = commandName(binary, args, options, root, sidecarDir);
      calls.push({ name, args: [...args], options: { ...options } });
      if (binary === 'git') {
        if (name === 'git-revision') {
          gitRevisionReads += 1;
          return gitRevisionReads > 1 && fixture.postPackGitRevision
            ? fixture.postPackGitRevision
            : fixture.gitRevision;
        }
        if (name === 'git-status') return fixture.workingTreeChanges;
        throw new Error(`unexpected Git command ${args.join(' ')}`);
      }
      if (binary !== 'npm') throw new Error(`unexpected binary ${binary}`);
      if (name === 'registry-config') return fixture.registryUrl;
      if (name.startsWith('preflight-')) return '';
      if (name === 'pack-sidecar') {
        return writeNpmPackFixture({
          directory: packDestination(args),
          name: 'scip-query-scip-windows',
          version: '0.13.1',
          provenanceBytes,
          payload: 'sidecar-package-content',
          packageJson: {
            name: 'scip-query-scip-windows',
            version: '0.13.1',
          },
        }).output;
      }
      if (name === 'pack-main') {
        if (fixture.failMainPack) throw new Error('injected main pack failure');
        return writeNpmPackFixture({
          directory: packDestination(args),
          name: 'scip-query',
          version: '0.19.6',
          payload: fixture.mainPayload,
          packageJson: {
            name: 'scip-query',
            version: '0.19.6',
            optionalDependencies: {
              'scip-query-scip-windows': fixture.packedMainSidecarPin,
            },
          },
        }).output;
      }
      if (name.startsWith('view-')) {
        const role = name.endsWith('sidecar') ? 'sidecar' : 'main';
        if (crashOnPostPublishView === role && fixture.published.includes(role)) {
          crashOnPostPublishView = undefined;
          throw new Error(`simulated crash after ${role} publication`);
        }
        return registryDistOutput(fixture, role, root, provenanceBytes, registrySeed++);
      }
      if (name.startsWith('pack-registry-')) {
        const role = name.endsWith('sidecar') ? 'sidecar' : 'main';
        return registryPackOutput(fixture, role, packDestination(args), provenanceBytes);
      }
      if (name.startsWith('publish-')) {
        const role = name.endsWith('sidecar') ? 'sidecar' : 'main';
        const behavior = fixture.publishBehavior[role];
        if (behavior === 'succeed') {
          fixture.registry[role] = 'same';
          fixture.published.push(role);
          return '';
        }
        if (behavior === 'succeed-invisible') {
          fixture.published.push(role);
          return '';
        }
        if (behavior === 'fail-absent') {
          throw commandError(binary, args, `injected ${role} publish failure`);
        }
        fixture.registry[role] = behavior === 'conflict-same' ? 'same' : 'different';
        fixture.published.push(role);
        throw commandError(binary, args, `injected ${role} publish conflict`);
      }
      throw new Error(`unexpected command ${binary} ${args.join(' ')}`);
    },
    tempDirectory: () => root,
    wait: (milliseconds) => fixture.waits.push(milliseconds),
    writeReleaseState(path, bytes) {
      stateWriteCount += 1;
      if (fixture.failStateWriteAt === stateWriteCount) {
        throw new Error('injected release-state write failure');
      }
      states.set(path, Buffer.from(bytes));
      stateWritePaths.push(path);
      const state = parseNpmReleaseStateJson(bytes);
      if (crashAfterStateStage && state.completedStages.includes(crashAfterStateStage)) {
        crashAfterStateStage = undefined;
        throw new Error(`simulated crash after ${state.completedStages.at(-1)} state`);
      }
      return 'synced';
    },
  };
  return fixture;
}

function commandName(
  binary: string,
  args: string[],
  options: WindowsSidecarCommandOptions,
  root: string,
  sidecarDir: string,
): string {
  if (binary === 'git' && args[0] === 'rev-parse') return 'git-revision';
  if (binary === 'git' && args[0] === 'status') return 'git-status';
  if (binary === 'npm' && args[0] === 'config' && args[1] === 'get' && args[2] === 'registry') {
    return 'registry-config';
  }
  if (args[0] === 'run' && args[1] === 'typecheck') return 'preflight-typecheck';
  if (args[0] === 'run' && args[1] === 'audit:prod') return 'preflight-audit';
  if (args[0] === 'test') return 'preflight-test';
  if (args[0] === 'run' && args[1] === 'lint') return 'preflight-lint';
  if (args[0] === 'pack' && options.cwd === sidecarDir) return 'pack-sidecar';
  if (args[0] === 'pack' && options.cwd === root) return 'pack-main';
  if (args[0] === 'view') return args[1].startsWith('scip-query-scip-windows@') ? 'view-sidecar' : 'view-main';
  if (args[0] === 'pack') {
    return args[1].startsWith('scip-query-scip-windows@') ? 'pack-registry-sidecar' : 'pack-registry-main';
  }
  if (args[0] === 'publish') {
    return args[1].includes('scip-query-scip-windows') ? 'publish-sidecar' : 'publish-main';
  }
  return 'unknown';
}

function registryDistOutput(
  fixture: ReleaseFixture,
  role: PackageRole,
  root: string,
  provenanceBytes: Buffer,
  seed: number,
): string {
  if (fixture.registry[role] === 'absent') {
    throw commandError('npm', ['view'], 'npm error code E404');
  }
  if (fixture.registry[role] === 'ambiguous') {
    throw commandError('npm', ['view'], 'npm error code E401 authentication required');
  }
  const packed = registryFixture(fixture, role, join(root, `registry-seed-${role}-${seed}`), provenanceBytes);
  const identity = hashTarball(packed.tarball);
  const { name, version } = packageCoordinate(role);
  return JSON.stringify({
    shasum: identity.shasum,
    integrity: identity.integrity,
    tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
  });
}

function registryPackOutput(
  fixture: ReleaseFixture,
  role: PackageRole,
  destination: string,
  provenanceBytes: Buffer,
): string {
  if (fixture.registry[role] === 'absent') throw new Error(`cannot pack absent ${role}`);
  return registryFixture(fixture, role, destination, provenanceBytes).output;
}

function registryFixture(fixture: ReleaseFixture, role: PackageRole, directory: string, provenanceBytes: Buffer) {
  const coordinate = packageCoordinate(role);
  const payload =
    fixture.registry[role] === 'different'
      ? `different-${role}-content`
      : role === 'sidecar'
        ? 'sidecar-package-content'
        : fixture.mainPayload;
  return writeNpmPackFixture({
    directory,
    ...coordinate,
    ...(role === 'sidecar' ? { provenanceBytes } : {}),
    payload,
    packageJson:
      role === 'sidecar'
        ? {
            name: 'scip-query-scip-windows',
            version: '0.13.1',
          }
        : {
            name: 'scip-query',
            version: '0.19.6',
            optionalDependencies: {
              'scip-query-scip-windows': fixture.packedMainSidecarPin,
            },
          },
  });
}

function packageCoordinate(role: PackageRole): { name: string; version: string } {
  return role === 'sidecar'
    ? { name: 'scip-query-scip-windows', version: '0.13.1' }
    : { name: 'scip-query', version: '0.19.6' };
}

function packDestination(args: string[]): string {
  return args[args.indexOf('--pack-destination') + 1];
}

function commandError(binary: string, args: string[], message: string): WindowsSidecarCommandError {
  return new WindowsSidecarCommandError('exit', binary, args, 1, '', message, message);
}

function writeSyntheticPackages(root: string): string {
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'scip-query',
      version: '0.19.6',
      optionalDependencies: { 'scip-query-scip-windows': '0.13.1' },
    }),
  );
  const sidecarDir = join(root, 'packages', 'scip-windows');
  mkdirSync(sidecarDir, { recursive: true });
  writeFileSync(
    join(sidecarDir, 'package.json'),
    JSON.stringify({ name: 'scip-query-scip-windows', version: '0.13.1' }),
  );
  writeFileSync(join(sidecarDir, 'scip-win32-x64.exe'), syntheticPe(0x8664));
  writeFileSync(join(sidecarDir, 'scip-win32-arm64.exe'), syntheticPe(0xaa64));
  const manifest = createWindowsSidecarProvenance({
    sidecarDir,
    packageName: 'scip-query-scip-windows',
    packageVersion: '0.13.1',
    sourceCommit: SOURCE_COMMIT,
  });
  writeFileSync(join(sidecarDir, WINDOWS_SIDECAR_PROVENANCE_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return sidecarDir;
}

function syntheticPe(machine: number): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'binary');
  bytes.writeUInt16LE(machine, 0x80 + 4);
  bytes.writeUInt16LE(0x20b, 0x80 + 24);
  return bytes;
}

async function withFixture(action: (fixture: ReleaseFixture) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-npm-release-'));
  try {
    await action(createFixture(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
