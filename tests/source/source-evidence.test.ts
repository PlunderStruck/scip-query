import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceEvidence } from '../../src/source/source-evidence.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('source evidence facade', () => {
  it('collects requested source evidence for one file or a batch', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-source-evidence-'));
    try {
      const projectRoot = join(tempDir, 'project');
      const dbPath = join(tempDir, 'index.db');
      writeFixtureFiles(projectRoot, {
        'src/sample.ts': [
          "import { targetValue } from './target.js';",
          'export function greet(name: string) {',
          '  const message = targetValue + name.length;',
          '  return message;',
          '}',
        ],
        'src/barrel.ts': "export { targetValue } from './target.js';\n",
        'src/target.ts': 'export const targetValue = 1;\n',
      });
      evidenceFixtureDb(dbPath)
        .document(1, 'typescript', 'src/sample.ts')
        .document(2, 'typescript', 'src/barrel.ts')
        .document(3, 'typescript', 'src/target.ts')
        .write();

      const db = new ScipDatabase({
        projectRoot,
        dbPath,
        indexPath: join(tempDir, 'index.scip'),
      });
      try {
        const evidence = sourceEvidence(db);
        const sample = evidence.forFile('src/sample.ts', {
          text: true,
          lines: true,
          ast: true,
          imports: true,
          facts: true,
          identifiers: true,
        });

        expect(sample.text).toContain('function greet');
        expect(sample.lines?.slice(0, 5)).toEqual([
          "import { targetValue } from './target.js';",
          'export function greet(name: string) {',
          '  const message = targetValue + name.length;',
          '  return message;',
          '}',
        ]);
        expect(sample.ast?.rootNode.type).toBe('program');
        expect(sample.imports).toEqual([expect.objectContaining({ sourcePath: 'src/target.ts' })]);
        expect(sample.facts?.callables.map((callable) => callable.name)).toEqual(['greet']);
        expect(sample.identifiers?.has('message')).toBe(true);
        expect(sample.identifierLineMap?.get('message')).toEqual([2, 3]);

        const barrel = evidence.forFile('src/barrel.ts', { reexports: true });
        expect(barrel.reexports).toEqual([expect.objectContaining({ sourcePath: 'src/target.ts' })]);
        expect(barrel.text).toBeUndefined();

        const batch = evidence.forFiles(['src/sample.ts', 'src/barrel.ts'], { text: true });
        expect([...batch.keys()]).toEqual(['src/sample.ts', 'src/barrel.ts']);
        expect(batch.get('src/barrel.ts')?.text).toContain('targetValue');
      } finally {
        db.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
