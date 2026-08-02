import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { evidence } from '../../../src/queries/navigation/evidence.js';
import { searchSource } from '../../../src/queries/navigation/source-search.js';
import { traceEvidence } from '../../../src/queries/navigation/trace.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('related source evidence', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('shows definition source and source centered on real reference sites', () => {
    const db = createSourceEvidenceDb();
    try {
      const traced = traceEvidence(db, 'appendThing', { referenceContext: 1 });

      expect(traced.definitions[0]?.source).toContain('export function appendThing');
      expect(traced.referencedBy).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relativePath: 'src/consumer.ts',
            line: 4,
            enclosingShort: 'src:consumer:run()',
            sourceStartLine: 3,
            sourceEndLine: 5,
            source: expect.stringContaining("appendThing('one')"),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('combines overlapping invocation windows without losing reference identities', () => {
    const db = createSourceEvidenceDb();
    try {
      const result = evidence(db, 'appendThing', { referenceContext: 2 });

      expect(result.kind).toBe('matched');
      if (result.kind !== 'matched') return;
      expect(result.definition?.source).toContain('return value.trim()');
      const consumer = result.referenceWindows.find((window) => window.relativePath === 'src/consumer.ts');
      expect(consumer?.references.map((reference) => reference.line)).toEqual(expect.arrayContaining([4, 5]));
      expect(consumer?.source).toContain("appendThing('one')");
      expect(consumer?.source).toContain("appendThing('two')");
    } finally {
      db.close();
    }
  });

  it('searches indexed source and reports the owning symbol and omitted matches', () => {
    const db = createSourceEvidenceDb();
    try {
      const result = searchSource(db, 'appendThing', { context: 0, limit: 2 });

      expect(result.mode).toBe('literal');
      expect(result.matchingLines).toBeGreaterThan(2);
      expect(result.matches).toHaveLength(2);
      expect(result.omittedMatches).toBe(result.matchingLines - 2);
      expect(result.matches[0]).toMatchObject({
        relativePath: 'src/api.ts',
        focusLine: 0,
        ownerShort: 'src:api:appendThing()',
      });
    } finally {
      db.close();
    }
  });

  it('refuses to present one ambiguous definition as the evidence answer', () => {
    const db = createSourceEvidenceDb(true);
    try {
      const result = evidence(db, 'appendThing');

      expect(result).toMatchObject({
        kind: 'ambiguous',
        total: 2,
        candidates: expect.arrayContaining([
          expect.objectContaining({ relativePath: 'src/api.ts' }),
          expect.objectContaining({ relativePath: 'src/other-api.ts' }),
        ]),
      });
    } finally {
      db.close();
    }
  });

  function createSourceEvidenceDb(ambiguous = false): ScipDatabase {
    tempDir = mkdtempSync(join(tmpdir(), 'scip-source-evidence-'));
    writeFixtureFiles(tempDir, {
      'src/api.ts': ['export function appendThing(value: string) {', '  return value.trim();', '}'],
      'src/consumer.ts': [
        "import { appendThing } from './api.js';",
        '',
        'export function run() {',
        '  const values = [',
        "    appendThing('one'),",
        "    appendThing('two'),",
        '  ];',
        '  return values;',
        '}',
      ],
      ...(ambiguous
        ? {
            'src/other-api.ts': ['export function appendThing(value: string) {', '  return value.toUpperCase();', '}'],
          }
        : {}),
    });
    const target = 'scip-typescript npm pkg 1.0.0 src/`api.ts`/appendThing().';
    const caller = 'scip-typescript npm pkg 1.0.0 src/`consumer.ts`/run().';
    const builder = evidenceFixtureDb(join(tempDir, 'index.db'))
      .document(1, 'typescript', 'src/api.ts')
      .document(2, 'typescript', 'src/consumer.ts')
      .symbol(1, target, 'appendThing', 12, 'function appendThing|function appendThing(value: string): string')
      .symbol(2, caller, 'run', 12, 'function run|function run(): string[]')
      .definition(1, 1, 1, 0, 0, 2, 1)
      .definition(2, 2, 2, 2, 0, 8, 1)
      .chunk(1, 1, 0, 2)
      .chunk(2, 2, 2, 8)
      .mention(1, 1, 1)
      .mention(2, 2, 1)
      .mention(2, 1, 0);
    if (ambiguous) {
      builder
        .document(3, 'typescript', 'src/other-api.ts')
        .symbol(3, 'scip-typescript npm pkg 1.0.0 src/`other-api.ts`/appendThing().', 'appendThing', 12)
        .definition(3, 3, 3, 0, 0, 2, 1)
        .chunk(3, 3, 0, 2)
        .mention(3, 3, 1);
    }
    builder.write();
    const config: ScipQueryConfig = {
      dbPath: join(tempDir, 'index.db'),
      indexPath: join(tempDir, 'index.scip'),
      projectRoot: tempDir,
    };
    return new ScipDatabase(config);
  }
});
