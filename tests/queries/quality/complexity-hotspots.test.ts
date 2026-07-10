import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SymbolInformation_Kind } from '@c4312/scip';
import { complexityHotspots } from '../../../src/queries/quality/complexity-hotspots.js';
import { branchEstimateForDefinition, branchEstimatesForDefinitions } from '../../../src/queries/quality/complexity.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { findFirstSymbolMatch } from '../../../src/symbols/symbol-lookup.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('complexity-hotspots', () => {
  it('scores callable definitions with AST branch estimates', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-complexity-hotspots-'));
    try {
      writeFixtureFiles(root, {
        'src/work.ts': [
          'export function target(value: number) {',
          '  if (value > 0) return value;',
          '  return value === 0 ? 1 : 2;',
          '}',
        ],
        'src/caller.ts': ['import { target } from "./work";', 'export function caller() {', '  return target(1);', '}'],
      });
      const dbPath = join(root, 'index.db');
      evidenceFixtureDb(dbPath)
        .document(1, 'typescript', 'src/work.ts')
        .document(2, 'typescript', 'src/caller.ts')
        .symbol(1, 'scip-typescript npm test 1.0.0 src/`work.ts`/target().', 'target', SymbolInformation_Kind.Function)
        .symbol(
          2,
          'scip-typescript npm test 1.0.0 src/`caller.ts`/caller().',
          'caller',
          SymbolInformation_Kind.Function,
        )
        .definition(1, 1, 1, 0, 0, 3, 1)
        .definition(2, 2, 2, 1, 0, 3, 1)
        .chunk(1, 1, 0, 4)
        .chunk(2, 2, 0, 4)
        .mention(1, 1, 1)
        .mention(2, 2, 1)
        .mention(2, 1, 0)
        .write();
      const config: ScipQueryConfig = { projectRoot: root, dbPath, indexPath: join(root, 'index.scip') };
      const db = new ScipDatabase(config);
      try {
        const target = findFirstSymbolMatch(db, 'target');
        expect(target).not.toBeNull();
        expect(branchEstimatesForDefinitions(db, [target!]).get(target!.symbolId)).toEqual(
          branchEstimateForDefinition(db, target!),
        );
        expect(complexityHotspots(db, { minLoc: 1, limit: 5, semantic: false })).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              shortName: expect.stringContaining('target'),
              branches: 2,
              estimateBasis: 'ast',
            }),
          ]),
        );
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not score rust static fields as callable hotspots', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-complexity-hotspots-rust-'));
    try {
      writeFixtureFiles(root, {
        'src/lib.rs': ['static CACHE: i32 = 1;'],
        'src/work.ts': [
          'export function target(value: number) {',
          '  if (value > 0) return value;',
          '  return 0;',
          '}',
        ],
      });
      const dbPath = join(root, 'index.db');
      evidenceFixtureDb(dbPath)
        .document(1, 'rust', 'src/lib.rs')
        .document(2, 'typescript', 'src/work.ts')
        .symbol(1, 'rust-analyzer cargo fixture 0.1.0 CACHE.', 'CACHE', SymbolInformation_Kind.StaticVariable)
        .symbol(2, 'scip-typescript npm test 1.0.0 src/`work.ts`/target().', 'target', SymbolInformation_Kind.Function)
        .definition(1, 1, 1, 0, 0, 0, 21)
        .definition(2, 2, 2, 0, 0, 3, 1)
        .chunk(1, 1, 0, 1)
        .chunk(2, 2, 0, 4)
        .mention(1, 1, 1)
        .mention(2, 2, 1)
        .write();
      const config: ScipQueryConfig = { projectRoot: root, dbPath, indexPath: join(root, 'index.scip') };
      const db = new ScipDatabase(config);
      try {
        const shortNames = complexityHotspots(db, { minLoc: 1, limit: 10, semantic: false }).map(
          (result) => result.shortName,
        );
        expect(shortNames).toEqual(expect.arrayContaining([expect.stringContaining('target')]));
        expect(shortNames).not.toEqual(expect.arrayContaining([expect.stringContaining('CACHE')]));
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
