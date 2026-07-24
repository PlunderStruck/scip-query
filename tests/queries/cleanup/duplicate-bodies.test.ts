import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  duplicateBodies,
  exactDuplicateBodyMatches,
  groupByHash,
  normalizeBody,
} from '../../../src/queries/cleanup/duplicate-bodies.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('duplicate bodies', () => {
  let tempDir: string;
  let db: ScipDatabase;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-query-duplicate-bodies-'));
    const projectRoot = join(tempDir, 'project');
    writeFixtureFiles(projectRoot, {
      'src/a.ts': [
        'export function escapeRegex(value: string) {',
        "  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
        '}',
      ],
      'src/b.ts': [
        'export function escapeRegExp(value: string) {',
        '  // Same implementation, comment should not matter.',
        "  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
        '}',
      ],
      'src/c.ts': [
        'export function escapePattern(input: string) {',
        "  return input.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
        '}',
      ],
      'src/d.ts': [
        '// scip-query: ignore-similar — intentionally separate public vocabulary.',
        'export function escapeLiteral(value: string) {',
        "  return value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
        '}',
      ],
    });

    const dbPath = join(tempDir, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/a.ts')
      .document(2, 'typescript', 'src/b.ts')
      .document(3, 'typescript', 'src/c.ts')
      .document(4, 'typescript', 'src/d.ts')
      .symbol(1, 'scip-typescript npm fixture 1.0.0 src/`a.ts`/escapeRegex().', 'escapeRegex', 12)
      .symbol(2, 'scip-typescript npm fixture 1.0.0 src/`b.ts`/escapeRegExp().', 'escapeRegExp', 12)
      .symbol(3, 'scip-typescript npm fixture 1.0.0 src/`c.ts`/escapePattern().', 'escapePattern', 12)
      .symbol(4, 'scip-typescript npm fixture 1.0.0 src/`d.ts`/escapeLiteral().', 'escapeLiteral', 12)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 0, 0, 3, 1)
      .definition(3, 3, 3, 0, 0, 2, 1)
      .definition(4, 4, 4, 1, 0, 3, 1)
      .write();

    db = new ScipDatabase({ dbPath, projectRoot });
  });

  afterAll(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('normalizes implementation bodies without renaming identifiers', () => {
    expect(normalizeBody('function a(value: string) { /* c */ return value.trim(); }')).toBe('returnvalue.trim();');
    expect(normalizeBody('function b(input: string) { return input.trim(); }')).toBe('returninput.trim();');
  });

  it('groups exact normalized bodies across files and keeps canonical first', () => {
    const groups = groupByHash([
      entry('src/new.ts', 'newer', 'returnvalue.trim();', 2),
      entry('src/old.ts', 'older', 'returnvalue.trim();', 10),
      entry('src/near.ts', 'near', 'returninput.trim();', 12),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.canonical.file).toBe('src/old.ts');
    expect(groups[0]?.functions.map((fn) => fn.file)).toEqual(['src/old.ts', 'src/new.ts']);
  });

  it('reports exact small-body groups but excludes renamed-identifier near misses', () => {
    // minLoc: 1 preserves this fixture's 1-line bodies — the 21.2 default of
    // 3 (registration-boilerplate exemption) is covered separately by
    // tests/regression/detects-historical-defects.test.ts.
    const groups = duplicateBodies(db, { maxLoc: 10, minLoc: 1 });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.functions.map((fn) => fn.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('excludes 1-line bodies once they fall below the default min-loc', () => {
    const groups = duplicateBodies(db, { maxLoc: 10 });

    expect(groups).toHaveLength(0);
  });

  it('finds established exact-body matches for a target symbol', () => {
    const matches = exactDuplicateBodyMatches(db, 'scip-typescript npm fixture 1.0.0 src/`a.ts`/escapeRegex().', {
      maxLoc: 10,
      minLoc: 1,
    });

    expect(matches.map((match) => match.file)).toEqual(['src/b.ts']);
  });
});

function entry(file: string, name: string, normalizedBody: string, ageCommits: number) {
  return {
    symbol: `scip-typescript npm fixture 1.0.0 ${file}/${name}().`,
    shortName: name,
    file,
    startLine: 0,
    endLine: 1,
    loc: 2,
    ageCommits,
    normalizedBody,
  };
}
