import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
      suppressions: [
        { reason: '' },
        { check: 'echo', reason: 'accepted duplicate', expiresAt: 'not-a-date' },
      ],
    });

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'error', path: 'suppressions[0].reason' }),
      expect.objectContaining({ level: 'error', path: 'suppressions[0]' }),
      expect.objectContaining({ level: 'error', path: 'suppressions[1].expiresAt' }),
    ]));
  });

  it('warns when a structured suppression has expired', () => {
    const diagnostics = validateProjectConfig({
      suppressions: [{ id: 'SQABC123DEF456', reason: 'temporary', expiresAt: '2020-01-01T00:00:00.000Z' }],
    }, { now: new Date('2026-06-13T00:00:00.000Z') });

    expect(diagnostics).toEqual([
      expect.objectContaining({ level: 'warning', path: 'suppressions[0].expiresAt' }),
    ]);
  });

  it('requires declared coupling groups to name at least two files', () => {
    const diagnostics = validateProjectConfig({
      declaredCouplings: [
        { name: '', files: ['src/a.ts'], reason: '' },
        { name: 'blank path', files: ['src/a.ts', ''] },
      ],
    });

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'error', path: 'declaredCouplings[0].name' }),
      expect.objectContaining({ level: 'error', path: 'declaredCouplings[0].files' }),
      expect.objectContaining({ level: 'error', path: 'declaredCouplings[0].reason' }),
      expect.objectContaining({ level: 'error', path: 'declaredCouplings[1].files[1]' }),
    ]));
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

    expect(() => addFindingSuppression(projectRoot, {
      id: 'SQABC123DEF456',
      reason: '',
    })).toThrow(/reason is required/);
  });
});
