import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleStatus } from '../../src/runtime/commands/command-handlers.js';
import { addFindingSuppression, loadProjectConfig, validateProjectConfig } from '../../src/runtime/config.js';

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
      suppressions: [{ reason: '' }, { check: 'echo', reason: 'accepted duplicate', expiresAt: 'not-a-date' }],
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'error', path: 'suppressions[0].reason' }),
        expect.objectContaining({ level: 'error', path: 'suppressions[0]' }),
        expect.objectContaining({ level: 'error', path: 'suppressions[1].expiresAt' }),
      ]),
    );
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

describe('addFindingSuppression', () => {
  it('appends a reasoned suppression to project config', () => {
    const projectRoot = createProject();
    writeFileSync(join(projectRoot, '.scipquery.json'), '{ "languages": ["typescript"] }\n');

    const result = addFindingSuppression(projectRoot, {
      id: 'SQABC123DEF456',
      check: 'echo',
      file: 'src/example.ts',
      reason: 'intentional fixture overlap',
    });

    expect(result).toEqual({
      path: join(projectRoot, '.scipquery.json'),
      suppressionCount: 1,
    });
    expect(loadProjectConfig(projectRoot).suppressions).toEqual([
      {
        id: 'SQABC123DEF456',
        check: 'echo',
        file: 'src/example.ts',
        reason: 'intentional fixture overlap',
      },
    ]);
  });

  it('rejects suppressions without a reason', () => {
    const projectRoot = createProject();

    expect(() =>
      addFindingSuppression(projectRoot, {
        id: 'SQABC123DEF456',
        reason: '',
      }),
    ).toThrow(/reason is required/);
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
