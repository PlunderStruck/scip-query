import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleDoctor, handleStatus, handleWatch } from '../../src/runtime/commands/command-handlers.js';
import { loadProjectConfig, validateProjectConfig } from '../../src/runtime/config.js';
import type { ProjectConfig } from '../../src/domain/types.js';

const tempDirs: string[] = [];

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
  it('returns an empty config when no project config exists', () => {
    expect(loadProjectConfig(createProject())).toEqual({});
  });

  it('loads valid project config', () => {
    const projectRoot = createProject();
    writeFileSync(join(projectRoot, '.scipquery.json'), '{ "languages": ["typescript"] }\n');

    expect(loadProjectConfig(projectRoot)).toEqual({ languages: ['typescript'] });
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

describe('validateProjectConfig', () => {
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
          file: 'src/queries/cleanup/drift-policy.ts',
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
          name: 'drift layer policy covers src dirs',
          file: 'src/queries/cleanup/drift-policy.ts',
          keys: { type: 'object-literal-keys', identifier: 'SRC_LAYER_DEPENDENCIES' },
          mustEqual: { type: 'top-level-dirs', path: 'src' },
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

  it('requires positive watch timing values', () => {
    const diagnostics = validateProjectConfig({
      watch: {
        debounceMs: 0,
        cooldownMs: -1,
        gitPollMs: 0,
        autoRefresh: 'yes' as unknown as boolean,
      },
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({ level: 'error', path: 'watch.debounceMs' }),
      expect.objectContaining({ level: 'error', path: 'watch.cooldownMs' }),
      expect.objectContaining({ level: 'error', path: 'watch.gitPollMs' }),
      expect.objectContaining({ level: 'error', path: 'watch.autoRefresh' }),
    ]);
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
    process.env['SCIP_QUERY_PROJECT_ROOT'] = projectRoot;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      handleStatus({ json: true });
      const payload = JSON.parse(log.mock.calls[0]![0] as string) as {
        result: { configDiagnostics: unknown[] };
      };

      expect(payload.result.configDiagnostics).toEqual([
        expect.objectContaining({
          level: 'warning',
          path: 'declaredCouplings[0].files[1]',
          message: 'Declared coupling file does not exist: src/missing.ts',
        }),
      ]);
    } finally {
      log.mockRestore();
      if (previousProjectRoot === undefined) {
        delete process.env['SCIP_QUERY_PROJECT_ROOT'];
      } else {
        process.env['SCIP_QUERY_PROJECT_ROOT'] = previousProjectRoot;
      }
    }
  });
});

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
