import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { code, codeBatch } from '../../../src/queries/navigation/code.js';
import { files } from '../../../src/queries/navigation/files.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('exact current-file identity', () => {
  let root: string;
  let db: ScipDatabase;
  const file = 'src/runtime/command-kit/command-descriptor-types.ts';
  const symbol = 'scip-typescript npm fixture 1.0.0 src/runtime/command-kit/`command-descriptor-types.ts`/helpAfter().';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scip-file-intent-'));
    writeFixtureFiles(root, { [file]: 'export function helpAfter() { return 1; }', Dockerfile: 'FROM node' });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', file)
      .symbol(1, symbol, 'helpAfter', 17)
      .definition(1, 1, 1, 0, 0, 0, 39)
      .chunk(1, 1, 0, 1)
      .mention(1, 1, 1)
      .write();
    db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    'src/runtime/command-kit/help.ts',
    './src/runtime/command-kit/help',
    'src\\runtime\\command-kit\\help.ts',
    'help.ts',
  ])('does not replace missing path %s with a fuzzy symbol', (selector) => {
    expect(code(db, selector)).toBeNull();
    expect(codeBatch(db, [selector])).toMatchObject({ matched: 0, missing: 1 });
  });

  it.each([symbol, 'helpAfter', file, `${file}:1-1`, 'Dockerfile'])('retains supported selector %s', (selector) => {
    expect(code(db, selector)).not.toBeNull();
    expect(codeBatch(db, [selector]).matched).toBe(1);
  });

  it('omits tracked deletions from current-file results', () => {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'add', file]);
    expect(files(db, file)).toEqual([{ relativePath: file }]);
    rmSync(join(root, file));
    expect(files(db, file)).toEqual([]);
    expect(execFileSync('git', ['-C', root, 'ls-files', '--deleted'], { encoding: 'utf8' })).toContain(file);
  });
});
