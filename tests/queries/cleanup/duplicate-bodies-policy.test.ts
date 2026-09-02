import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScipDatabase } from '../../../src/storage/db.js';
import { duplicateBodies, duplicateBodyScan } from '../../../src/queries/cleanup/duplicate-bodies.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const CHUNK = [
  'export function chunk(items: string[], size: number) {',
  '  const out: string[][] = [];',
  '  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));',
  '  return out;',
  '}',
];
const ROUTE = [
  "import { withAuth } from '@/lib/auth';",
  'export async function GET(request: Request, context: unknown) {',
  '  const session = await withAuth(request);',
  '  if (!session) return new Response(null, { status: 401 });',
  '  return handleGet(request, context, session);',
  '}',
];
const KLASS = (name: string) => [
  `export class ${name} extends Error {`,
  '  constructor(message: string) {',
  '    super(message);',
  `    this.name = '${name}';`,
  '    Object.setPrototypeOf(this, new.target.prototype);',
  '  }',
  '}',
];

describe('duplicate-bodies convention policy', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('keeps product duplicates and discloses constructor, test, and route-glue members', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-duplicate-policy-'));
    tempDirs.push(root);
    writeFixtureFiles(root, {
      'src/lib/a/util.ts': CHUNK,
      'src/lib/b/util.ts': CHUNK,
      'src/lib/a/util.test.ts': CHUNK,
      'src/app/api/users/route.ts': ROUTE,
      'src/app/api/posts/route.ts': ROUTE,
      'src/lib/errors/left.ts': KLASS('LeftError'),
      'src/lib/errors/right.ts': KLASS('RightError'),
    });
    const dbPath = join(root, 'index.db');
    const sym = (file: string, leaf: string) => `scip-typescript npm fixture 1.0.0 ${file}/${leaf}.`;
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/lib/a/util.ts')
      .document(2, 'typescript', 'src/lib/b/util.ts')
      .document(3, 'typescript', 'src/lib/a/util.test.ts')
      .document(4, 'typescript', 'src/app/api/users/route.ts')
      .document(5, 'typescript', 'src/app/api/posts/route.ts')
      .document(6, 'typescript', 'src/lib/errors/left.ts')
      .document(7, 'typescript', 'src/lib/errors/right.ts')
      .symbol(1, sym('`src/lib/a/util.ts`', 'chunk()'), 'chunk', 12)
      .symbol(2, sym('`src/lib/b/util.ts`', 'chunk()'), 'chunk', 12)
      .symbol(3, sym('`src/lib/a/util.test.ts`', 'chunk()'), 'chunk', 12)
      .symbol(4, sym('`src/app/api/users/route.ts`', 'GET()'), 'GET', 12)
      .symbol(5, sym('`src/app/api/posts/route.ts`', 'GET()'), 'GET', 12)
      .symbol(6, sym('`src/lib/errors/left.ts`', 'LeftError#`<constructor>`()'), '<constructor>', 12)
      .symbol(7, sym('`src/lib/errors/right.ts`', 'RightError#`<constructor>`()'), '<constructor>', 12)
      .definition(1, 1, 1, 0, 0, 4, 1)
      .definition(2, 2, 2, 0, 0, 4, 1)
      .definition(3, 3, 3, 0, 0, 4, 1)
      .definition(4, 4, 4, 1, 0, 5, 1)
      .definition(5, 5, 5, 1, 0, 5, 1)
      .definition(6, 6, 6, 1, 2, 5, 3)
      .definition(7, 7, 7, 1, 2, 5, 3)
      .chunk(1, 1, 0, 5)
      .chunk(2, 2, 0, 5)
      .chunk(3, 3, 0, 5)
      .chunk(4, 4, 0, 6)
      .chunk(5, 5, 0, 6)
      .chunk(6, 6, 0, 7)
      .chunk(7, 7, 0, 7)
      .write();

    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const scan = duplicateBodyScan(db, { minLoc: 1 });
      expect(scan.groups.map((group) => group.functions.map((entry) => entry.file).sort())).toEqual([
        ['src/lib/a/util.ts', 'src/lib/b/util.ts'],
      ]);
      expect(scan.exclusions).toEqual([
        expect.objectContaining({ reason: 'framework-route-exports', count: 2 }),
        expect.objectContaining({ reason: 'synthetic-members', count: 2 }),
        expect.objectContaining({ reason: 'test-file-members', count: 1 }),
      ]);
      expect(duplicateBodies(db, { minLoc: 1 })).toEqual(scan.groups);
    } finally {
      db.close();
    }
  });
});
