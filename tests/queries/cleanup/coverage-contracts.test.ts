import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkCoverageContract,
  coverageContractTouchedByDiff,
  evaluateCoverageContract,
  resolveContractSource,
} from '../../../src/queries/cleanup/coverage-contracts.js';
import type { CoverageContractConfig } from '../../../src/domain/types.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const tempRoots: string[] = [];
const openDbs: ScipDatabase[] = [];

function dbOverFiles(files: Record<string, readonly string[] | string>): ScipDatabase {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-coverage-contracts-'));
  tempRoots.push(tempDir);
  const projectRoot = join(tempDir, 'project');
  writeFixtureFiles(projectRoot, files);
  const dbPath = join(tempDir, 'index.db');
  evidenceFixtureDb(dbPath).write();
  const db = new ScipDatabase({ dbPath, indexPath: join(tempDir, 'index.scip'), projectRoot });
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('checkCoverageContract (pure)', () => {
  it('reports ground-truth entries the declared set is missing', () => {
    const diff = checkCoverageContract(['a', 'b'], ['a', 'b', 'c'], { allowExtra: true });
    expect(diff).toEqual({ missing: ['c'], extra: [] });
  });

  it('reports declared entries with no ground-truth match when allowExtra is false', () => {
    const diff = checkCoverageContract(['a', 'b', 'stale'], ['a', 'b'], { allowExtra: false });
    expect(diff).toEqual({ missing: [], extra: ['stale'] });
  });

  it('is clean when the sets match exactly', () => {
    const diff = checkCoverageContract(['a', 'b'], ['b', 'a'], { allowExtra: false });
    expect(diff).toEqual({ missing: [], extra: [] });
  });
});

describe('resolveContractSource (fs-backed)', () => {
  it('lists top-level directories', () => {
    const db = dbOverFiles({
      'src/analysis/x.ts': 'export const x = 1;\n',
      'src/domain/y.ts': 'export const y = 1;\n',
      'src/domain/nested/z.ts': 'export const z = 1;\n',
    });

    expect(resolveContractSource(db.config.projectRoot, { type: 'top-level-dirs', path: 'src' })).toEqual([
      'analysis',
      'domain',
    ]);
  });

  it('lists file-glob basenames for immediate children', () => {
    const db = dbOverFiles({
      'skills/scip-query/SKILL.md': '# skill\n',
      'skills/_shared/SKILL.md': '# shared\n',
      'skills/_shared/agents/openai.yaml': 'x: 1\n',
    });

    expect(resolveContractSource(db.config.projectRoot, { type: 'file-glob', pattern: 'skills/*' })).toEqual([
      '_shared',
      'scip-query',
    ]);
  });
});

describe('object-literal-keys / string-array extraction via evaluateCoverageContract', () => {
  it('flags a missing key in an object-literal contract', () => {
    const db = dbOverFiles({
      'src/policy.ts': ['export const ALLOWED: Record<string, unknown> = {', '  analysis: 1,', '  domain: 1,', '};'],
      'src/analysis/x.ts': 'export const x = 1;\n',
      'src/domain/y.ts': 'export const y = 1;\n',
      'src/missing/z.ts': 'export const z = 1;\n',
    });

    const contract: CoverageContractConfig = {
      name: 'policy covers src dirs',
      file: 'src/policy.ts',
      keys: { type: 'object-literal-keys', identifier: 'ALLOWED' },
      mustEqual: { type: 'top-level-dirs', path: 'src' },
      allowExtra: true,
    };

    const result = evaluateCoverageContract(db, contract);
    expect(result.status).toBe('violated');
    expect(result.missing).toEqual(['missing']);
    expect(result.extra).toEqual([]);
  });

  it('passes when a string-array contract fully covers its ground truth', () => {
    const db = dbOverFiles({
      'src/skills.ts': ["export const NAMES = ['alpha', 'beta'] as const;"],
      'skills/alpha/SKILL.md': '# a\n',
      'skills/beta/SKILL.md': '# b\n',
    });

    const contract: CoverageContractConfig = {
      name: 'names cover skills',
      file: 'src/skills.ts',
      keys: { type: 'string-array', identifier: 'NAMES' },
      mustEqual: { type: 'builtin-skills' },
      allowExtra: false,
    };

    const result = evaluateCoverageContract(db, contract);
    expect(result).toMatchObject({ status: 'ok', missing: [], extra: [] });
  });

  it('flags an extra declared key when allowExtra is false', () => {
    const db = dbOverFiles({
      'src/skills.ts': ["export const NAMES = ['alpha', 'gamma'] as const;"],
      'skills/alpha/SKILL.md': '# a\n',
    });

    const contract: CoverageContractConfig = {
      name: 'names cover skills',
      file: 'src/skills.ts',
      keys: { type: 'string-array', identifier: 'NAMES' },
      mustEqual: { type: 'builtin-skills' },
      allowExtra: false,
    };

    const result = evaluateCoverageContract(db, contract);
    expect(result.status).toBe('violated');
    expect(result.extra).toEqual(['gamma']);
  });

  it('discloses (never silently passes) when the declared identifier is not found', () => {
    const db = dbOverFiles({
      'src/skills.ts': ["export const OTHER_NAME = ['alpha'] as const;"],
      'skills/alpha/SKILL.md': '# a\n',
    });

    const contract: CoverageContractConfig = {
      name: 'names cover skills',
      file: 'src/skills.ts',
      keys: { type: 'string-array', identifier: 'NAMES' },
      mustEqual: { type: 'builtin-skills' },
    };

    const result = evaluateCoverageContract(db, contract);
    expect(result.status).toBe('unavailable');
    expect(result.unavailableReason).toBeDefined();
  });

  it('discloses when the declared file does not exist', () => {
    const db = dbOverFiles({ 'skills/alpha/SKILL.md': '# a\n' });

    const contract: CoverageContractConfig = {
      name: 'missing file',
      file: 'src/does-not-exist.ts',
      keys: { type: 'string-array', identifier: 'NAMES' },
      mustEqual: { type: 'builtin-skills' },
    };

    const result = evaluateCoverageContract(db, contract);
    expect(result.status).toBe('unavailable');
  });
});

describe('markdown-list extraction', () => {
  it('extracts backtick and link names from a marker-delimited block', () => {
    const db = dbOverFiles({
      'README.md': [
        '# Skills',
        '',
        '<!-- BEGIN GENERATED SKILL LIST -->',
        '- `alpha`',
        '- [beta](skills/beta/SKILL.md)',
        '<!-- END GENERATED SKILL LIST -->',
        '',
      ],
      'skills/alpha/SKILL.md': '# a\n',
      'skills/beta/SKILL.md': '# b\n',
    });

    const contract: CoverageContractConfig = {
      name: 'README skill list',
      file: 'README.md',
      keys: { type: 'markdown-list', marker: 'SKILL LIST' },
      mustEqual: { type: 'builtin-skills' },
      allowExtra: false,
    };

    const result = evaluateCoverageContract(db, contract);
    expect(result).toMatchObject({ status: 'ok', missing: [], extra: [] });
  });
});

describe('coverageContractTouchedByDiff', () => {
  const contract: CoverageContractConfig = {
    name: 'built-in skills cover skill directories',
    file: 'src/runtime/setup.ts',
    keys: { type: 'string-array', identifier: 'BUILTIN_SKILLS' },
    mustEqual: { type: 'builtin-skills' },
  };

  it('is touched when the declared file changed', () => {
    expect(coverageContractTouchedByDiff(contract, new Set(['src/runtime/setup.ts']))).toBe(true);
  });

  it('is touched when a file under the ground-truth directory changed', () => {
    expect(coverageContractTouchedByDiff(contract, new Set(['skills/scip-new-skill/SKILL.md']))).toBe(true);
  });

  it('is not touched by unrelated changes', () => {
    expect(coverageContractTouchedByDiff(contract, new Set(['docs/README.md']))).toBe(false);
  });
});
