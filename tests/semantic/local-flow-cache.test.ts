import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScipDatabase } from '../../src/storage/db.js';
import { semanticLocalFlowForRange } from '../../src/semantic/local-flow.js';
import {
  clearSourceFileEvidenceCaches,
  clearWholeProjectEvidenceCaches,
} from '../../src/queries/internal/cache-invalidation.js';

function withSourceProject(run: (db: ScipDatabase, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'scip-local-flow-cache-'));
  const db = { config: { projectRoot: root } } as ScipDatabase;
  mkdirSync(join(root, 'src'));
  try {
    run(db, root);
  } finally {
    clearWholeProjectEvidenceCaches(db);
    rmSync(root, { recursive: true, force: true });
  }
}

describe('local-flow cache invalidation', () => {
  it.each(['src/flow.ts', 'src\\flow.ts'])('refreshes every range after clearing %s', (clearedPath) => {
    withSourceProject((db, root) => {
      const file = join(root, 'src/flow.ts');
      const source = (name: string) =>
        `export function first(input: number) { const ${name} = input; return ${name}; }\n` +
        `export function second(input: number) { const ${name} = input + 1; return ${name}; }\n`;
      const readRanges = () => [0, 1].map((line) => semanticLocalFlowForRange(db, 'src/flow.ts', line, line));
      writeFileSync(file, source('oldValue'));
      expect(JSON.stringify(readRanges())).toContain('oldValue');
      writeFileSync(file, source('newValue'));
      clearSourceFileEvidenceCaches(db, clearedPath);
      const refreshed = readRanges();
      clearWholeProjectEvidenceCaches(db);
      const fresh = readRanges();
      expect(JSON.stringify(fresh)).toContain('newValue');
      expect(refreshed).toEqual(fresh);
      expect(JSON.stringify(refreshed)).not.toContain('oldValue');
    });
  });

  it('recovers a previously missing source after file invalidation', () => {
    withSourceProject((db, root) => {
      expect(semanticLocalFlowForRange(db, 'src/flow.ts', 0, 0)?.coverage.status).toBe('unsupported');
      writeFileSync(join(root, 'src/flow.ts'), 'export function flow(input: number) { return input; }\n');
      clearSourceFileEvidenceCaches(db, 'src/flow.ts');
      expect(semanticLocalFlowForRange(db, 'src/flow.ts', 0, 0)?.points.some((point) => point.name === 'input')).toBe(
        true,
      );
    });
  });
});
