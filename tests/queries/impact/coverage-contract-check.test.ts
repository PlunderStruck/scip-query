import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CoverageContractConfig } from '../../../src/domain/types.js';
import {
  coverageContractTouchedByDiff,
  evaluateCoverageContracts,
} from '../../../src/queries/cleanup/coverage-contracts.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

const roots: string[] = [];
const dbs: ScipDatabase[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CONTRACT: CoverageContractConfig = {
  name: 'policy covers src dirs',
  file: 'src/policy.ts',
  keys: { type: 'object-literal-keys', identifier: 'ALLOWED' },
  mustEqual: { type: 'top-level-dirs', path: 'src' },
  allowExtra: true,
};

function fixture(contracts: CoverageContractConfig[]): ScipDatabase {
  const root = mkdtempSync(join(tmpdir(), 'scip-coverage-contract-'));
  roots.push(root);
  mkdirSync(join(root, 'src', 'a'), { recursive: true });
  writeFileSync(join(root, 'src', 'policy.ts'), 'export const ALLOWED = { a: 1 };\n');
  writeFileSync(join(root, 'src', 'a', 'x.ts'), 'export const x = 1;\n');
  const dbPath = join(root, 'index.db');
  evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/policy.ts').write();
  const db = new ScipDatabase({ dbPath, projectRoot: root, coverageContracts: contracts });
  dbs.push(db);
  return db;
}

describe('coverage contract detector', () => {
  it('reports enumeration drift directly', () => {
    const db = fixture([CONTRACT]);
    mkdirSync(join(db.config.projectRoot, 'src', 'b'), { recursive: true });
    writeFileSync(join(db.config.projectRoot, 'src', 'b', 'y.ts'), 'export const y = 1;\n');

    expect(evaluateCoverageContracts(db, [CONTRACT])).toContainEqual(
      expect.objectContaining({ status: 'violated', missing: ['b'] }),
    );
  });

  it('identifies whether a change touches either contract side', () => {
    expect(coverageContractTouchedByDiff(CONTRACT, new Set(['src/b/y.ts']))).toBe(true);
    expect(coverageContractTouchedByDiff(CONTRACT, new Set(['README.md']))).toBe(false);
  });

  it('is empty when no contracts are configured', () => {
    const db = fixture([]);
    expect(evaluateCoverageContracts(db, [])).toEqual([]);
  });
});
