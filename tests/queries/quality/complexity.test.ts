import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { countBranchesFromAst } from '../../../src/queries/quality/complexity.js';
import { getAst } from '../../../src/source/ast.js';
import type { ScipDatabase } from '../../../src/storage/db.js';

describe('complexity branch counting', () => {
  it('counts TypeScript branch nodes without regex-style overlap or token false positives', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-complexity-'));
    try {
      writeFileSync(
        join(tempDir, 'sample.ts'),
        [
          'export function sample(a?: { b?: boolean }, c = /a?/) {',
          '  if (a?.b && c.test("x") || false) {',
          '    return 1;',
          '  } else if (a?.b ?? false) {',
          '    return 2;',
          '  }',
          '  const value = a?.b ? 3 : 4;',
          '  switch (value) {',
          '    case 1: return 1;',
          '    case 2: return 2;',
          '    default: return value;',
          '  }',
          '}',
          '',
        ].join('\n'),
      );
      const db = { config: { projectRoot: tempDir } } as ScipDatabase;
      const tree = getAst(db, 'sample.ts');

      expect(tree).not.toBeNull();
      expect(countBranchesFromAst(tree!.rootNode)).toBe(7);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
