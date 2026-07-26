import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveIndexStoragePaths } from '../../src/platform/cache-layout.js';
import {
  CURRENT_PROJECT_CONFIG_SCHEMA_VERSION,
  LEGACY_PROJECT_CONFIG_SCHEMA_VERSION,
  PROJECT_CONFIG_SCHEMA_PATH,
} from '../../src/domain/project-config.js';
import { handleDoctor, handleStatus, handleWatch } from '../../src/runtime/commands/command-handlers.js';
import {
  configureProjectAutomaticRefresh,
  initProjectConfig,
  loadProjectConfig,
  resolveWatchConfig,
  validateProjectConfig,
} from '../../src/runtime/config.js';
import type { ProjectConfig } from '../../src/domain/types.js';
import { resolveGitWorktreeIdentity } from '../../src/platform/git-worktree.js';
import {
  WATCH_LOCK_FILE,
  WATCH_SERVICE_PROTOCOL_VERSION,
  watchServicePaths,
} from '../../src/platform/watch-service-state.js';
import { acquireWatchProcessLock, writeWatchServiceState } from '../../src/runtime/watch-service.js';
import { cliVersion } from '../../src/runtime/cli-support.js';
import { enqueueWatchRefreshRequest } from '../../src/storage/watch-refresh-requests.js';

const tempDirs: string[] = [];
const CURRENT_CONFIG_FORMAT = {
  $schema: PROJECT_CONFIG_SCHEMA_PATH,
  schemaVersion: CURRENT_PROJECT_CONFIG_SCHEMA_VERSION,
} as const;

function currentConfig<T extends Record<string, unknown>>(fields: T): typeof CURRENT_CONFIG_FORMAT & T {
  return { ...CURRENT_CONFIG_FORMAT, ...fields };
}

function createProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scip-query-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadProjectConfig', () => {
  it('uses the calibrated demand-service timing defaults', () => {
    expect(resolveWatchConfig({})).toMatchObject({
      enabled: false,
      debounceMs: 250,
      cooldownMs: 0,
      gitPollMs: 2_000,
      idleTimeoutMs: 600_000,
      autoRefresh: true,
    });
  });

  it('returns an empty config when no project config exists', () => {
    expect(loadProjectConfig(createProject())).toEqual({});
  });

  it('loads valid project config', () => {
    const projectRoot = createProject();
    writeFileSync(join(projectRoot, '.scipquery.json'), '{ "languages": ["typescript"] }\n');

    expect(loadProjectConfig(projectRoot)).toEqual(currentConfig({ languages: ['typescript'] }));
  });

  it('loads explicit legacy v1 and rejects unsupported future versions without changing bytes', () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.scipquery.json');
    writeFileSync(
      configPath,
      `${JSON.stringify({ schemaVersion: LEGACY_PROJECT_CONFIG_SCHEMA_VERSION, languages: ['rust'] })}\n`,
    );
    expect(loadProjectConfig(projectRoot)).toEqual(currentConfig({ languages: ['rust'] }));

    const future = '{ "schemaVersion": 3, "watch": { "enabled": true }, "futureOption": 1 }\n';
    writeFileSync(configPath, future);
    expect(() => loadProjectConfig(projectRoot)).toThrow(/unsupported future schemaVersion 3/);
    expect(readFileSync(configPath, 'utf8')).toBe(future);
  });

  it('rejects malformed schema versions without changing bytes', () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.scipquery.json');
    const malformed = '{ "schemaVersion": "2", "watch": { "enabled": true } }\n';
    writeFileSync(configPath, malformed);

    expect(() => loadProjectConfig(projectRoot)).toThrow(/schemaVersion must be an integer/);
    expect(readFileSync(configPath, 'utf8')).toBe(malformed);
  });

  it('throws when project config is invalid JSON', () => {
    const projectRoot = createProject();
    writeFileSync(join(projectRoot, '.scipquery.json'), '{\n');

    expect(() => loadProjectConfig(projectRoot)).toThrow(/invalid \.scipquery\.json/);
  });

  it('throws when project config cannot be read', () => {
    const projectRoot = createProject();
    const configPath = join(projectRoot, '.scipquery.json');
    writeFileSync(configPath, '{}\n');
    chmodSync(configPath, 0o000);

    try {
      expect(() => loadProjectConfig(projectRoot)).toThrow(/unable to read \.scipquery\.json/);
    } finally {
      chmodSync(configPath, 0o600);
    }
  });
});

describe('automatic indexing config setup', () => {
  it('initializes explicit project configs with demand-started indexing enabled', () => {
    const projectRoot = createProject();

    const configPath = initProjectConfig(projectRoot, ['typescript']);

    expect(configPath).toBe(join(projectRoot, '.scipquery.json'));
    expect(loadProjectConfig(projectRoot)).toMatchObject({
      $schema: PROJECT_CONFIG_SCHEMA_PATH,
      schemaVersion: CURRENT_PROJECT_CONFIG_SCHEMA_VERSION,
      languages: ['typescript'],
      watch: { enabled: true, autoRefresh: true, idleTimeoutMs: 600_000 },
    });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject(CURRENT_CONFIG_FORMAT);
  });

  it('persists setup enablement without replacing unrelated config', () => {
    const projectRoot = createProject();
    const current = {
      languages: ['rust'] as const,
      docs: { snapshotPaths: ['docs/archive/**'] },
      watch: { enabled: false, debounceMs: 500 },
    };

    const result = configureProjectAutomaticRefresh(projectRoot, current, true);

    expect(result.changed).toBe(true);
    expect(loadProjectConfig(projectRoot)).toEqual(
      currentConfig({
        languages: ['rust'],
        docs: { snapshotPaths: ['docs/archive/**'] },
        watch: { enabled: true, debounceMs: 500, autoRefresh: true },
      }),
    );
  });

  it('leaves an already-persisted setup state untouched', () => {
    const projectRoot = createProject();
    const current = currentConfig({ watch: { enabled: true, autoRefresh: false } });
    writeFileSync(join(projectRoot, '.scipquery.json'), `${JSON.stringify(current, null, 2)}\n`);

    const result = configureProjectAutomaticRefresh(projectRoot, current, true);

    expect(result).toMatchObject({ changed: false, config: current });
    expect(loadProjectConfig(projectRoot)).toEqual(current);
  });

  it('upgrades a legacy schema even when the requested setup field is already present', () => {
    const projectRoot = createProject();
    const legacy = { watch: { enabled: true, autoRefresh: false }, futureOption: { retained: true } };
    const configPath = join(projectRoot, '.scipquery.json');
    writeFileSync(configPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const result = configureProjectAutomaticRefresh(projectRoot, legacy, true);

    expect(result.changed).toBe(true);
    expect(loadProjectConfig(projectRoot)).toEqual(
      currentConfig({ watch: { enabled: true, autoRefresh: false }, futureOption: { retained: true } }),
    );
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(result.config);
  });

  it('merges unrelated edits made after the caller loaded its config', () => {
    const projectRoot = createProject();
    const stale = { watch: { enabled: false, debounceMs: 500 } };
    writeFileSync(
      join(projectRoot, '.scipquery.json'),
      `${JSON.stringify({ ...stale, futureOption: { retained: true } }, null, 2)}\n`,
    );

    configureProjectAutomaticRefresh(projectRoot, stale, true);

    expect(loadProjectConfig(projectRoot)).toEqual(
      currentConfig({
        watch: { enabled: true, debounceMs: 500, autoRefresh: true },
        futureOption: { retained: true },
      }),
    );
  });

  it('rejects a stale same-field update and preserves the latest config', () => {
    const projectRoot = createProject();
    const stale = { watch: { enabled: false } };
    const latest = { watch: { enabled: true }, futureOption: 'latest' };
    const path = join(projectRoot, '.scipquery.json');
    writeFileSync(path, `${JSON.stringify(latest, null, 2)}\n`);

    expect(() => configureProjectAutomaticRefresh(projectRoot, stale, false)).toThrow(
      /watch\.enabled changed since it was read/,
    );
    expect(loadProjectConfig(projectRoot)).toEqual(currentConfig(latest));
  });

  it('refuses to rewrite a malformed latest config', () => {
    const projectRoot = createProject();
    const path = join(projectRoot, '.scipquery.json');
    writeFileSync(path, '{broken\n');

    expect(() => configureProjectAutomaticRefresh(projectRoot, {}, true)).toThrow(
      /latest project config is invalid JSON/,
    );
    expect(readFileSync(path, 'utf8')).toBe('{broken\n');
  });

  it('refuses to rewrite a future latest config', () => {
    const projectRoot = createProject();
    const path = join(projectRoot, '.scipquery.json');
    const future = '{\n  "schemaVersion": 3,\n  "watch": { "enabled": false },\n  "futureOption": true\n}\n';
    writeFileSync(path, future);

    expect(() => configureProjectAutomaticRefresh(projectRoot, { watch: { enabled: false } }, true)).toThrow(
      /unsupported future schemaVersion 3/,
    );
    expect(readFileSync(path, 'utf8')).toBe(future);
  });
});

describe('setup language selection', () => {
  it('persists selected indexers without replacing unrelated config', async () => {
    const projectRoot = createProject();
    const current = { docs: { snapshotPaths: ['docs/**'] }, watch: { enabled: true } };
    writeFileSync(join(projectRoot, '.scipquery.json'), `${JSON.stringify(current, null, 2)}\n`);
    const { configureProjectLanguages } = await import('../../src/runtime/config.js');

    const result = configureProjectLanguages(projectRoot, current, ['typescript', 'python']);

    expect(result.changed).toBe(true);
    expect(loadProjectConfig(projectRoot)).toEqual(
      currentConfig({
        docs: { snapshotPaths: ['docs/**'] },
        watch: { enabled: true },
        languages: ['typescript', 'python'],
      }),
    );
  });

  it('rejects a concurrent language choice rather than replacing it', async () => {
    const projectRoot = createProject();
    const stale = { languages: ['rust'] as const };
    const latest = { languages: ['python'] as const, retained: true };
    const path = join(projectRoot, '.scipquery.json');
    writeFileSync(path, `${JSON.stringify(latest, null, 2)}\n`);
    const { configureProjectLanguages } = await import('../../src/runtime/config.js');

    expect(() => configureProjectLanguages(projectRoot, stale, ['typescript'])).toThrow(
      /languages changed since it was read/,
    );
    expect(loadProjectConfig(projectRoot)).toEqual(currentConfig(latest));
  });
});

describe('validateProjectConfig', () => {
  it('accepts legacy metadata omission and rejects invalid persisted metadata', () => {
    expect(validateProjectConfig({ languages: ['typescript'] })).toEqual([]);
    expect(
      validateProjectConfig({
        schemaVersion: 3,
        $schema: '   ',
      } as unknown as ProjectConfig),
    ).toEqual([
      expect.objectContaining({ level: 'error', path: 'schemaVersion' }),
      expect.objectContaining({ level: 'error', path: '$schema' }),
    ]);
  });

  it('requires structured suppressions to include an identity and reason', () => {
    const diagnostics = validateProjectConfig({
      suppressions: [
        { reason: '' },
        { check: 'echo', reason: 'accepted duplicate', expiresAt: 'not-a-date' },
        { check: 'echo', file: 'src/example.ts', reason: 'accepted duplicate class' },
      ],
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'error', path: 'suppressions[0].reason' }),
        expect.objectContaining({ level: 'error', path: 'suppressions[0]' }),
        expect.objectContaining({
          level: 'error',
          path: 'suppressions[1]',
          message: 'Suppression must include id or both check and file.',
        }),
        expect.objectContaining({ level: 'error', path: 'suppressions[1].expiresAt' }),
        expect.objectContaining({
          level: 'warning',
          path: 'suppressions[2]',
          message:
            'Check+file suppressions waive every matching finding in that file; prefer a stable id when available.',
        }),
      ]),
    );
  });

  it('warns about unknown config keys at every level', () => {
    const diagnostics = validateProjectConfig({
      autoRefres: true,
      watch: { enabled: false, autoRefres: true },
      hooks: { router: 'single', routers: true },
      indexer: { typescript: { projectMode: 'single', packageManager: 'pnpm' } },
      entryRoots: { files: [], extra: [] },
      semantic: {
        typescript: { tsconfigs: [], project: 'tsconfig.json' },
        rust: { rustAnalyzerPath: 'rust-analyzer', extra: true },
        ruby: {},
      },
      locality: { architecturalBoundarySegments: [], boundarySegments: [] },
      declaredCouplings: [{ name: 'pair', files: ['a.ts', 'b.ts'], owner: 'runtime' }],
      suppressions: [{ id: 'SQABC123DEF456', reason: 'accepted', owner: 'runtime' }],
    } as unknown as ProjectConfig);

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'warning', path: 'autoRefres', message: 'Unknown config key.' }),
        expect.objectContaining({ level: 'warning', path: 'watch.autoRefres', message: 'Unknown config key.' }),
        expect.objectContaining({ level: 'warning', path: 'hooks.routers', message: 'Unknown config key.' }),
        expect.objectContaining({
          level: 'warning',
          path: 'indexer.typescript.packageManager',
          message: 'Unknown config key.',
        }),
        expect.objectContaining({ level: 'warning', path: 'entryRoots.extra', message: 'Unknown config key.' }),
        expect.objectContaining({ level: 'warning', path: 'semantic.ruby', message: 'Unknown config key.' }),
        expect.objectContaining({
          level: 'warning',
          path: 'semantic.typescript.project',
          message: 'Unknown config key.',
        }),
        expect.objectContaining({
          level: 'warning',
          path: 'semantic.rust.extra',
          message: 'Unknown config key.',
        }),
        expect.objectContaining({
          level: 'warning',
          path: 'locality.boundarySegments',
          message: 'Unknown config key.',
        }),
        expect.objectContaining({
          level: 'warning',
          path: 'declaredCouplings[0].owner',
          message: 'Unknown config key.',
        }),
        expect.objectContaining({
          level: 'warning',
          path: 'suppressions[0].owner',
          message: 'Unknown config key.',
        }),
      ]),
    );
  });

  it('validates Rust semantic config shape', () => {
    const diagnostics = validateProjectConfig({
      semantic: { rust: { rustAnalyzerPath: '  ' } },
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        level: 'error',
        path: 'semantic.rust.rustAnalyzerPath',
        message: 'Rust analyzer path must be a non-empty string.',
      }),
    ]);
  });

  it('warns when a structured suppression has expired', () => {
    const diagnostics = validateProjectConfig(
      {
        suppressions: [{ id: 'SQABC123DEF456', reason: 'temporary', expiresAt: '2020-01-01T00:00:00.000Z' }],
      },
      { now: new Date('2026-06-13T00:00:00.000Z') },
    );

    expect(diagnostics).toEqual([expect.objectContaining({ level: 'warning', path: 'suppressions[0].expiresAt' })]);
  });

  it('validates structured suppression file paths', () => {
    const projectRoot = createProject();
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src/example.ts'), 'export const example = 1;\n');

    const diagnostics = validateProjectConfig(
      {
        suppressions: [
          { id: 'SQABC123DEF456', reason: 'accepted', file: 'src/example.ts' },
          { id: 'SQDEF456ABC789', reason: 'blank file', file: '  ' },
          { id: 'SQFED654CBA987', reason: 'stale file', file: 'src/missing.ts' },
        ],
      },
      { projectRoot },
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        level: 'error',
        path: 'suppressions[1].file',
        message: 'Suppression file path cannot be blank.',
      }),
      expect.objectContaining({
        level: 'warning',
        path: 'suppressions[2].file',
        message: 'Suppression file does not exist: src/missing.ts',
      }),
    ]);
  });

  it('requires declared coupling groups to name at least two files', () => {
    const diagnostics = validateProjectConfig({
      declaredCouplings: [
        { name: '', files: ['src/a.ts'], reason: '' },
        { name: 'blank path', files: ['src/a.ts', ''] },
      ],
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'error', path: 'declaredCouplings[0].name' }),
        expect.objectContaining({ level: 'error', path: 'declaredCouplings[0].files' }),
        expect.objectContaining({ level: 'error', path: 'declaredCouplings[0].reason' }),
        expect.objectContaining({ level: 'error', path: 'declaredCouplings[1].files[1]' }),
      ]),
    );
  });

  it('rejects unknown coverage-contract key extractor and ground-truth source types', () => {
    const diagnostics = validateProjectConfig({
      coverageContracts: [
        {
          name: 'bad contract',
          file: 'src/runtime/setup.ts',
          keys: { type: 'regex-scan', identifier: 'x' } as never,
          mustEqual: { type: 'live-registry-lookup' } as never,
        },
      ],
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'error', path: 'coverageContracts[0].keys.type' }),
        expect.objectContaining({ level: 'error', path: 'coverageContracts[0].mustEqual.type' }),
      ]),
    );
  });

  it('accepts a well-formed coverage contract', () => {
    const diagnostics = validateProjectConfig({
      coverageContracts: [
        {
          name: 'built-in skills match skill directories',
          file: 'src/runtime/setup.ts',
          keys: { type: 'string-array', identifier: 'BUILTIN_SKILLS' },
          mustEqual: { type: 'builtin-skills' },
          allowExtra: false,
        },
      ],
    });

    expect(diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([]);
  });

  it('requires coverage contract name and file', () => {
    const diagnostics = validateProjectConfig({
      coverageContracts: [
        {
          name: '',
          file: '',
          keys: { type: 'string-array', identifier: 'X' },
          mustEqual: { type: 'builtin-skills' },
        } as never,
      ],
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'error', path: 'coverageContracts[0].name' }),
        expect.objectContaining({ level: 'error', path: 'coverageContracts[0].file' }),
      ]),
    );
  });

  it('validates docs.snapshotPaths entries are non-empty strings', () => {
    const diagnostics = validateProjectConfig({
      docs: { snapshotPaths: ['docs/plans/**', '', 42 as unknown as string] },
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'error', path: 'docs.snapshotPaths[1]' }),
        expect.objectContaining({ level: 'error', path: 'docs.snapshotPaths[2]' }),
      ]),
    );
  });

  it('accepts well-formed docs.snapshotPaths', () => {
    const diagnostics = validateProjectConfig({
      docs: { snapshotPaths: ['docs/benchmarks/**', 'docs/validation/**'] },
    });

    expect(diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([]);
  });

  it('warns about unknown docs config keys', () => {
    const diagnostics = validateProjectConfig({
      docs: { snapshotPaths: [], extra: true } as never,
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ level: 'warning', path: 'docs.extra' })]),
    );
  });

  it('validates locality architectural boundary segments', () => {
    const diagnostics = validateProjectConfig({
      locality: {
        architecturalBoundarySegments: ['policies', '', 'workflow/helpers'],
      },
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        level: 'error',
        path: 'locality.architecturalBoundarySegments[1]',
        message: 'Boundary segment must be a non-empty string.',
      }),
      expect.objectContaining({
        level: 'error',
        path: 'locality.architecturalBoundarySegments[2]',
        message: 'Boundary segment must be a single folder name, not a path.',
      }),
    ]);
  });

  it('accepts a partially declared architecture policy', () => {
    const diagnostics = validateProjectConfig({
      architecture: {
        boundaries: [
          { name: 'domain', paths: ['src/domain/**'] },
          { name: 'runtime', paths: ['src/runtime/**'] },
        ],
        allowedDependencies: {
          domain: [],
        },
        requireCompletePolicy: false,
        requireAcyclic: false,
      },
    });

    expect(diagnostics).toEqual([]);
  });

  // A typo here is silent by construction: detection treats every value other
  // than 'file' as directory granularity, so an unvalidated `subUnits: "files"`
  // would disable the same-directory cycle enforcement it was meant to enable.
  it('rejects a subUnits value outside the supported set', () => {
    const diagnostics = validateProjectConfig({
      architecture: {
        boundaries: [{ name: 'app', paths: ['src/app/**'], subUnits: 'files' as unknown as 'file' }],
      },
    });

    expect(diagnostics).toContainEqual(
      expect.objectContaining({ level: 'error', path: 'architecture.boundaries[0].subUnits' }),
    );
  });

  it('accepts the supported subUnits values and an omitted one', () => {
    const diagnostics = validateProjectConfig({
      architecture: {
        boundaries: [
          { name: 'app', paths: ['src/app/**'], subUnits: 'file' },
          { name: 'lib', paths: ['src/lib/**'], subUnits: 'directory' },
          { name: 'util', paths: ['src/util/**'] },
        ],
      },
    });

    expect(diagnostics.filter((entry) => entry.path.includes('subUnits'))).toEqual([]);
  });

  it('validates a boundary-specific file ceiling', () => {
    const invalid = validateProjectConfig({
      architecture: {
        boundaries: [{ name: 'app', paths: ['src/app/**'], maxFiles: 1.5 }],
      },
    });
    expect(invalid).toContainEqual(
      expect.objectContaining({ level: 'error', path: 'architecture.boundaries[0].maxFiles' }),
    );

    const valid = validateProjectConfig({
      architecture: {
        boundaries: [{ name: 'app', paths: ['src/app/**'], maxFiles: 2 }],
      },
    });
    expect(valid.filter((entry) => entry.path.endsWith('.maxFiles'))).toEqual([]);
  });

  it('validates the boundary growth limits and test roots', () => {
    const diagnostics = validateProjectConfig({
      architecture: {
        boundaries: [{ name: 'app', paths: ['src/app/**'] }],
        maxBoundaryFanOut: -1,
        maxBoundaryFiles: 1.5 as unknown as number,
        testPaths: [7] as unknown as string[],
        requireMinimalPolicy: 'yes' as unknown as boolean,
      },
    });

    for (const path of [
      'architecture.maxBoundaryFanOut',
      'architecture.maxBoundaryFiles',
      'architecture.testPaths',
      'architecture.requireMinimalPolicy',
    ]) {
      expect(diagnostics).toContainEqual(expect.objectContaining({ level: 'error', path }));
    }
  });

  it('validates architecture boundary and dependency references', () => {
    const diagnostics = validateProjectConfig({
      architecture: {
        boundaries: [
          { name: 'domain', paths: ['src/domain/**'] },
          { name: 'domain', paths: ['src/domain/**'] },
          { name: 'runtime', paths: ['../runtime/**', 'src/runtime/*/nested'] },
        ],
        allowedDependencies: {
          missing: ['domain'],
          domain: ['missing', 'missing'],
        },
        requireCompletePolicy: 'yes' as unknown as boolean,
        requireAcyclic: 'yes' as unknown as boolean,
        extra: true,
      } as never,
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'warning', path: 'architecture.extra' }),
        expect.objectContaining({ level: 'error', path: 'architecture.boundaries[1].name' }),
        expect.objectContaining({ level: 'error', path: 'architecture.boundaries[1].paths[0]' }),
        expect.objectContaining({ level: 'error', path: 'architecture.boundaries[2].paths[0]' }),
        expect.objectContaining({ level: 'error', path: 'architecture.boundaries[2].paths[1]' }),
        expect.objectContaining({ level: 'error', path: 'architecture.allowedDependencies.missing' }),
        expect.objectContaining({ level: 'error', path: 'architecture.allowedDependencies.domain[0]' }),
        expect.objectContaining({ level: 'error', path: 'architecture.allowedDependencies.domain[1]' }),
        expect.objectContaining({ level: 'error', path: 'architecture.requireCompletePolicy' }),
        expect.objectContaining({ level: 'error', path: 'architecture.requireAcyclic' }),
      ]),
    );
  });

  it('requires one dependency row per boundary when complete architecture policy is enabled', () => {
    const diagnostics = validateProjectConfig({
      architecture: {
        boundaries: [
          { name: 'domain', paths: ['src/domain/**'] },
          { name: 'runtime', paths: ['src/runtime/**'] },
        ],
        allowedDependencies: {
          domain: [],
        },
        requireCompletePolicy: true,
      },
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        level: 'error',
        path: 'architecture.allowedDependencies.runtime',
        message: 'A dependency row is required by architecture.requireCompletePolicy.',
      }),
    ]);
  });

  it('requires positive refresh timings and a non-negative integer idle timeout', () => {
    const diagnostics = validateProjectConfig({
      watch: {
        debounceMs: 0,
        cooldownMs: -1,
        gitPollMs: 0,
        idleTimeoutMs: -1,
        autoRefresh: 'yes' as unknown as boolean,
      },
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({ level: 'error', path: 'watch.debounceMs' }),
      expect.objectContaining({ level: 'error', path: 'watch.cooldownMs' }),
      expect.objectContaining({ level: 'error', path: 'watch.gitPollMs' }),
      expect.objectContaining({ level: 'error', path: 'watch.idleTimeoutMs' }),
      expect.objectContaining({ level: 'error', path: 'watch.autoRefresh' }),
    ]);

    expect(validateProjectConfig({ watch: { idleTimeoutMs: 0 } })).toEqual([]);
    expect(validateProjectConfig({ watch: { cooldownMs: 0 } })).toEqual([]);
  });

  it('requires positive integer indexer concurrency', () => {
    const diagnostics = validateProjectConfig({
      indexerConcurrency: 1.5,
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        level: 'error',
        path: 'indexerConcurrency',
        message: 'Must be a positive integer.',
      }),
    ]);
  });

  it('validates TypeScript project indexer settings', () => {
    const projectRoot = createProject();
    mkdirSync(join(projectRoot, 'packages/web'), { recursive: true });
    writeFileSync(join(projectRoot, 'packages/web/tsconfig.json'), '{}\n');

    const diagnostics = validateProjectConfig(
      {
        indexer: {
          typescript: {
            projectMode: 'many' as 'workspace',
            projects: ['packages/web', '../outside', 'missing'],
            pnpmWorkspaces: true,
          },
        },
      },
      { projectRoot },
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'error', path: 'indexer.typescript.projectMode' }),
        expect.objectContaining({
          level: 'error',
          path: 'indexer.typescript.projects[1]',
          message: 'Project path must stay inside the project root.',
        }),
        expect.objectContaining({
          level: 'warning',
          path: 'indexer.typescript.projects[2]',
          message: 'TypeScript project path does not exist: missing',
        }),
      ]),
    );
  });

  it('accepts Clojure as a configured language and validates its indexer config path', () => {
    const projectRoot = createProject();
    writeFileSync(join(projectRoot, '.scip-clojure.json'), '{}\n');

    expect(
      validateProjectConfig(
        {
          languages: ['clojure'],
          indexer: { clojure: { configPath: '.scip-clojure.json' } },
        },
        { projectRoot },
      ),
    ).toEqual([]);

    expect(
      validateProjectConfig(
        {
          indexer: { clojure: { configPath: '  ' } },
        },
        { projectRoot },
      ),
    ).toEqual([
      expect.objectContaining({
        level: 'error',
        path: 'indexer.clojure.configPath',
        message: 'Config path must be a non-empty string.',
      }),
    ]);

    expect(
      validateProjectConfig(
        {
          indexer: { clojure: { configPath: '../outside.json' } },
        },
        { projectRoot },
      ),
    ).toEqual([
      expect.objectContaining({
        level: 'error',
        path: 'indexer.clojure.configPath',
        message: 'Config path must stay inside the project root.',
      }),
    ]);

    expect(
      validateProjectConfig(
        {
          indexer: { clojure: { configPath: 'missing.json' } },
        },
        { projectRoot },
      ),
    ).toEqual([
      expect.objectContaining({
        level: 'warning',
        path: 'indexer.clojure.configPath',
        message: 'Clojure indexer config path does not exist: missing.json',
      }),
    ]);
  });

  it('warns that pnpm workspace mode is ignored by explicit TypeScript project sharding', () => {
    const diagnostics = validateProjectConfig({
      indexer: {
        typescript: {
          projectMode: 'workspace',
          pnpmWorkspaces: true,
        },
      },
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        level: 'warning',
        path: 'indexer.typescript.pnpmWorkspaces',
      }),
    ]);
  });

  it('warns when declared coupling file paths do not exist', () => {
    const projectRoot = createProject();
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src/a.ts'), 'export const a = 1;\n');

    const diagnostics = validateProjectConfig(
      {
        declaredCouplings: [{ name: 'freshness', files: ['src/a.ts', 'src/missing.ts'] }],
      },
      { projectRoot },
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        level: 'warning',
        path: 'declaredCouplings[0].files[1]',
        message: 'Declared coupling file does not exist: src/missing.ts',
      }),
    ]);
  });
});

describe('status config diagnostics', () => {
  it('uses root-aware config validation in status JSON output', () => {
    const projectRoot = createProject();
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(
      join(projectRoot, '.scipquery.json'),
      `${JSON.stringify({
        languages: ['typescript'],
        declaredCouplings: [{ name: 'stale group', files: ['src/a.ts', 'src/missing.ts'] }],
      })}\n`,
    );

    const previousProjectRoot = process.env['SCIP_QUERY_PROJECT_ROOT'];
    const previousRustSession = process.env['SCIP_RUST_SEMANTIC_DURABLE_SESSION'];
    process.env['SCIP_QUERY_PROJECT_ROOT'] = projectRoot;
    delete process.env['SCIP_RUST_SEMANTIC_DURABLE_SESSION'];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      handleStatus({ json: true });
      const payload = JSON.parse(log.mock.calls[0]![0] as string) as {
        result: { affectedSetShadow: unknown; sqliteGeneration: unknown; configDiagnostics: unknown[] };
      };

      expect(payload.result.affectedSetShadow).toMatchObject({
        state: 'unavailable',
        reason: 'telemetry-missing',
        latestPath: join(projectRoot, 'affected-shadow-latest.json'),
      });
      expect(payload.result.configDiagnostics).toEqual([
        expect.objectContaining({
          level: 'warning',
          path: 'declaredCouplings[0].files[1]',
          message: 'Declared coupling file does not exist: src/missing.ts',
        }),
      ]);
      expect(payload.result.sqliteGeneration).toEqual(
        expect.objectContaining({ state: 'legacy', statePath: join(projectRoot, '.scipquery-generations/state.json') }),
      );
    } finally {
      log.mockRestore();
      if (previousProjectRoot === undefined) {
        delete process.env['SCIP_QUERY_PROJECT_ROOT'];
      } else {
        process.env['SCIP_QUERY_PROJECT_ROOT'] = previousProjectRoot;
      }
      if (previousRustSession === undefined) {
        delete process.env['SCIP_RUST_SEMANTIC_DURABLE_SESSION'];
      } else {
        process.env['SCIP_RUST_SEMANTIC_DURABLE_SESSION'] = previousRustSession;
      }
    }
  });

  it('adds a passing shadow summary to status JSON and human output', () => {
    const projectRoot = createProject();
    writeFileSync(join(projectRoot, 'affected-shadow-latest.json'), `${JSON.stringify(passingShadowRecord())}\n`);
    const previousProjectRoot = process.env['SCIP_QUERY_PROJECT_ROOT'];
    const previousRustSession = process.env['SCIP_RUST_SEMANTIC_DURABLE_SESSION'];
    process.env['SCIP_QUERY_PROJECT_ROOT'] = projectRoot;
    delete process.env['SCIP_RUST_SEMANTIC_DURABLE_SESSION'];
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      handleStatus({ json: true });
      const payload = JSON.parse(log.mock.calls[0]![0] as string) as {
        result: {
          affectedSetShadow: unknown;
          sqliteGeneration: unknown;
          rustSemanticSession: unknown;
          sharedCache: unknown;
        };
      };
      expect(payload.result.affectedSetShadow).toMatchObject({
        state: 'passing',
        mode: 'closure',
        recall: 1,
        affectedRatio: 0.25,
        predictedFiles: ['src/a.ts'],
        actualFiles: ['src/a.ts'],
      });
      expect(payload.result.sqliteGeneration).toEqual(expect.objectContaining({ state: 'legacy' }));
      expect(payload.result.sharedCache).toEqual(
        expect.objectContaining({ state: 'unavailable', reason: 'Git worktree identity is unavailable' }),
      );
      expect(payload.result.rustSemanticSession).toEqual(
        expect.objectContaining({
          transport: 'durable',
          state: 'stopped',
          source: 'default',
          fallback: 'worker',
          valid: true,
        }),
      );

      log.mockClear();
      handleStatus({});
      const output = log.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('Shadow:   passing, 100.0% recall, 1 predicted / 1 changed, 25.0% of project');
      expect(output).toContain('DB gen:   legacy (no generation record)');
      expect(output).toContain('Shared:   unavailable (Git worktree identity is unavailable)');
      expect(output).toContain(
        'Rust sess: durable/stopped (default; worker fallback; opt out with SCIP_RUST_SEMANTIC_DURABLE_SESSION=0)',
      );
      expect(output).toContain(`Latest:   ${join(projectRoot, 'affected-shadow-latest.json')}`);
    } finally {
      log.mockRestore();
      if (previousProjectRoot === undefined) {
        delete process.env['SCIP_QUERY_PROJECT_ROOT'];
      } else {
        process.env['SCIP_QUERY_PROJECT_ROOT'] = previousProjectRoot;
      }
      if (previousRustSession === undefined) {
        delete process.env['SCIP_RUST_SEMANTIC_DURABLE_SESSION'];
      } else {
        process.env['SCIP_RUST_SEMANTIC_DURABLE_SESSION'] = previousRustSession;
      }
    }
  });
});

function passingShadowRecord(): object {
  return {
    version: 1,
    status: 'evaluated',
    refreshResult: 'rebuilt',
    recordedAt: '2026-07-10T00:00:00.000Z',
    durationMs: 12,
    manifest: {},
    plan: { mode: 'closure', affectedFiles: ['src/a.ts'], reasons: [] },
    comparison: { changedFiles: ['src/a.ts'] },
    evaluation: {
      passed: true,
      recall: 1,
      affectedRatio: 0.25,
      predictedFiles: ['src/a.ts'],
      actualFiles: ['src/a.ts'],
      missingFiles: [],
    },
  };
}

describe('doctor diagnostics', () => {
  it('exits 0 when the only problem is a stale index', () => {
    const projectRoot = createProject();
    const cacheDir = join(projectRoot, '.scipquery-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(projectRoot, '.scipquery.json'), '{ "languages": [], "dbPath": ".scipquery-cache" }\n');
    writeFileSync(join(cacheDir, 'index.db'), '');
    writeFileSync(
      join(cacheDir, 'meta.json'),
      `${JSON.stringify({
        version: 2,
        status: 'complete',
        indexedLanguages: [],
        fingerprint: { version: 2, languages: [], files: [{ path: 'old.ts', size: 1, hash: 'old' }] },
      })}\n`,
    );

    const previousProjectRoot = process.env['SCIP_QUERY_PROJECT_ROOT'];
    const previousExitCode = process.exitCode;
    process.env['SCIP_QUERY_PROJECT_ROOT'] = projectRoot;
    process.exitCode = undefined;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      handleDoctor({});

      expect(process.exitCode).toBe(0);
      expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain('Freshness: stale');
    } finally {
      log.mockRestore();
      process.exitCode = previousExitCode;
      if (previousProjectRoot === undefined) {
        delete process.env['SCIP_QUERY_PROJECT_ROOT'];
      } else {
        process.env['SCIP_QUERY_PROJECT_ROOT'] = previousProjectRoot;
      }
    }
  });
});

describe('watch command config gate', () => {
  it('exposes the idle watcher database generation in JSON and text status', () => {
    const projectRoot = createProject();
    execFileSync('git', ['-C', projectRoot, 'init', '-q']);
    writeFileSync(
      join(projectRoot, '.scipquery.json'),
      `${JSON.stringify({ dbPath: '.cache', watch: { enabled: true } })}\n`,
    );
    const identity = resolveGitWorktreeIdentity(projectRoot);
    if (identity.kind !== 'worktree') throw new Error(`Expected Git worktree, received ${identity.kind}`);
    const servicePaths = watchServicePaths(
      resolveIndexStoragePaths(projectRoot, loadProjectConfig(projectRoot)).cacheDir,
    );
    const now = new Date().toISOString();
    const indexGeneration = 'a'.repeat(64);
    enqueueWatchRefreshRequest(servicePaths.refreshRequestsPath, 'first pending request', {
      idempotencyKey: 'first',
    });
    enqueueWatchRefreshRequest(servicePaths.refreshRequestsPath, 'second pending request', {
      idempotencyKey: 'second',
    });
    writeWatchServiceState(servicePaths.statePath, {
      version: 1,
      protocolVersion: WATCH_SERVICE_PROTOCOL_VERSION,
      pid: process.pid,
      projectRoot: realpathSync(projectRoot),
      worktreeId: identity.identity.worktreeId,
      cliVersion,
      startedAt: now,
      heartbeatAt: now,
      lastActivityAt: now,
      watcher: { state: 'idle' },
      indexGeneration,
      refreshRequests: {
        pending: 2,
        claimed: 0,
        completed: 0,
        expired: 0,
        invalid: 0,
        oldestPendingAt: now,
      },
    });
    const previousProjectRoot = process.env['SCIP_QUERY_PROJECT_ROOT'];
    process.env['SCIP_QUERY_PROJECT_ROOT'] = projectRoot;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      handleWatch({ status: true, json: true });
      const payload = JSON.parse(String(log.mock.calls[0]?.[0])) as { result: Record<string, unknown> };
      expect(payload.result.indexGeneration).toBe(indexGeneration);
      expect(payload.result.refreshRequests).toMatchObject({ pending: 2, claimed: 0, completed: 0, expired: 0 });

      log.mockClear();
      handleWatch({ status: true });
      expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain('Index generation: aaaaaaaaaaaa');
      expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        'Refresh requests: 2 pending, 0 claimed, 0 completed, 0 expired',
      );
    } finally {
      log.mockRestore();
      if (previousProjectRoot === undefined) delete process.env['SCIP_QUERY_PROJECT_ROOT'];
      else process.env['SCIP_QUERY_PROJECT_ROOT'] = previousProjectRoot;
    }
  });

  it('reports canonical worktree identity while only a foreground lock is live', () => {
    const projectRoot = createProject();
    execFileSync('git', ['-C', projectRoot, 'init', '-q']);
    writeFileSync(join(projectRoot, '.scipquery.json'), '{ "watch": { "enabled": true } }\n');
    const identity = resolveGitWorktreeIdentity(projectRoot);
    if (identity.kind !== 'worktree') throw new Error(`Expected Git worktree, received ${identity.kind}`);
    const paths = resolveIndexStoragePaths(projectRoot, loadProjectConfig(projectRoot));
    const lock = acquireWatchProcessLock(join(paths.cacheDir, WATCH_LOCK_FILE), projectRoot);
    const previousProjectRoot = process.env['SCIP_QUERY_PROJECT_ROOT'];
    process.env['SCIP_QUERY_PROJECT_ROOT'] = projectRoot;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      expect(lock.acquired).toBe(true);
      handleWatch({ status: true, json: true });
      const payload = JSON.parse(String(log.mock.calls[0]?.[0])) as { result: Record<string, unknown> };
      expect(payload.result).toEqual(
        expect.objectContaining({
          state: 'running',
          mode: 'foreground-or-starting',
          projectRoot: realpathSync(projectRoot),
          worktreeId: identity.identity.worktreeId,
        }),
      );

      log.mockClear();
      handleWatch({ status: true });
      expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        `Worktree: ${realpathSync(projectRoot)} [${identity.identity.worktreeId.slice(0, 12)}]`,
      );
    } finally {
      log.mockRestore();
      lock.release();
      if (previousProjectRoot === undefined) delete process.env['SCIP_QUERY_PROJECT_ROOT'];
      else process.env['SCIP_QUERY_PROJECT_ROOT'] = previousProjectRoot;
    }
  });

  it('reports stopped service state even when watching is disabled', () => {
    const projectRoot = createProject();
    writeFileSync(join(projectRoot, '.scipquery.json'), '{ "watch": { "enabled": false } }\n');
    const previousProjectRoot = process.env['SCIP_QUERY_PROJECT_ROOT'];
    process.env['SCIP_QUERY_PROJECT_ROOT'] = projectRoot;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      handleWatch({ status: true, json: true });
      const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(payload.result).toEqual({
        enabled: false,
        state: 'stopped',
        mode: 'none',
        refreshRequests: {
          pending: 0,
          claimed: 0,
          completed: 0,
          expired: 0,
          invalid: 0,
        },
      });
    } finally {
      log.mockRestore();
      if (previousProjectRoot === undefined) delete process.env['SCIP_QUERY_PROJECT_ROOT'];
      else process.env['SCIP_QUERY_PROJECT_ROOT'] = previousProjectRoot;
    }
  });

  it('rejects conflicting watch lifecycle actions', () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      handleWatch({ daemon: true, status: true });
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith('error: choose only one of --daemon, --status, or --stop.');
    } finally {
      error.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it('refuses to start unless watch.enabled is true', () => {
    const projectRoot = createProject();
    writeFileSync(join(projectRoot, '.scipquery.json'), '{ "languages": [], "watch": { "enabled": false } }\n');

    const previousProjectRoot = process.env['SCIP_QUERY_PROJECT_ROOT'];
    const previousExitCode = process.exitCode;
    process.env['SCIP_QUERY_PROJECT_ROOT'] = projectRoot;
    process.exitCode = undefined;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      handleWatch({});

      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(
        'error: watch mode is disabled. Set "watch.enabled": true in .scipquery.json to start it.',
      );
    } finally {
      error.mockRestore();
      process.exitCode = previousExitCode;
      if (previousProjectRoot === undefined) {
        delete process.env['SCIP_QUERY_PROJECT_ROOT'];
      } else {
        process.env['SCIP_QUERY_PROJECT_ROOT'] = previousProjectRoot;
      }
    }
  });
});
