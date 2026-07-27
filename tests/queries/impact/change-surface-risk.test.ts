import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changeSurface } from '../../../src/queries/impact/change-surface.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('change-surface file risk', () => {
  it('does not label a directly executed server low-risk solely because source fan-in is zero', () => {
    const fixture = fixtureDb({
      file: 'src/runtime/watch-server.ts',
      source: [
        'export function runWatchServiceServer() {}',
        'const invokedPath = process.argv[1];',
        'if (invokedPath && import.meta.url) runWatchServiceServer();',
        '',
      ].join('\n'),
    });
    try {
      const result = changeSurface(fixture.db, fixture.file, { semantic: false });

      expect(result?.fileRisk).toMatchObject({
        operationalRoot: true,
        publishedApi: false,
        coverage: 'complete',
      });
      expect(result?.fileRisk.reasons).toContainEqual({
        kind: 'operational-root',
        detail: 'module contains a direct-execution process guard',
      });
      expect(result?.symbols[0]).toMatchObject({
        externalConsumers: 0,
        externalConsumerRiskLevel: 'low',
        riskLevel: 'medium',
      });
    } finally {
      fixture.db.close();
    }
  });

  it('keeps a private internal leaf low when no other risk factor applies', () => {
    const fixture = fixtureDb({
      file: 'src/internal/leaf.ts',
      source: 'export function leaf() { return 1; }\n',
    });
    try {
      const result = changeSurface(fixture.db, fixture.file, { semantic: false });
      expect(result?.fileRisk).toEqual({
        operationalRoot: false,
        publishedApi: false,
        coverage: 'complete',
        reasons: [],
      });
      expect(result?.symbols[0]?.riskLevel).toBe('low');
    } finally {
      fixture.db.close();
    }
  });

  it('reports published API and operational launch roots as distinct reasons', () => {
    const fixture = fixtureDb({
      file: 'src/cli.ts',
      source: 'export function main() { return 0; }\n',
      manifest: {
        bin: { tool: './dist/cli.js' },
        exports: { './cli': './dist/cli.js' },
      },
    });
    try {
      const result = changeSurface(fixture.db, fixture.file, { semantic: false });
      expect(result?.fileRisk.reasons).toEqual(
        expect.arrayContaining([
          { kind: 'operational-root', detail: 'structural entrypoint path' },
          { kind: 'operational-root', detail: 'package binary' },
          { kind: 'published-api', detail: 'package manifest export' },
        ]),
      );
      expect(result?.symbols[0]?.riskLevel).toBe('medium');
    } finally {
      fixture.db.close();
    }
  });

  it('fails closed when indexed source metadata is unavailable', () => {
    const fixture = fixtureDb({ file: 'src/missing.ts' });
    try {
      const result = changeSurface(fixture.db, fixture.file, { semantic: false });
      expect(result?.fileRisk.coverage).toBe('partial');
      expect(result?.fileRisk.reasons).toContainEqual({
        kind: 'metadata-unavailable',
        detail: 'indexed source file is unavailable on disk',
      });
      expect(result?.symbols[0]).toMatchObject({
        externalConsumerRiskLevel: 'low',
        riskLevel: 'medium',
      });
    } finally {
      fixture.db.close();
    }
  });
});

function fixtureDb(input: { file: string; source?: string; manifest?: Record<string, unknown> }): {
  db: ScipDatabase;
  file: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-change-risk-'));
  roots.push(root);
  if (input.source !== undefined) {
    mkdirSync(join(root, input.file, '..'), { recursive: true });
    writeFileSync(join(root, input.file), input.source);
  }
  if (input.manifest) writeFileSync(join(root, 'package.json'), JSON.stringify(input.manifest));
  const dbPath = join(root, 'index.db');
  const symbolName = input.file.replace(/[^A-Za-z0-9]+/g, '_');
  evidenceFixtureDb(dbPath)
    .document(1, 'typescript', input.file)
    .symbol(1, `scip-typescript npm fixture 1.0.0 ${input.file}/${symbolName}().`, symbolName, 12)
    .definition(1, 1, 1, 0, 0, 0, 20)
    .chunk(1, 1, 0, 1)
    .write();
  return {
    file: input.file,
    db: new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') }),
  };
}
