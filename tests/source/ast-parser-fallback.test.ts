import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAst } from '../../src/source/ast.js';
import type { ScipDatabase } from '../../src/storage/db.js';

describe('AST parser fallback', () => {
  it('parses a TypeScript source file that tree-sitter rejects as one large string', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-ast-fallback-'));
    try {
      const source = readFileSync(join(process.cwd(), 'src', 'runtime', 'cli.ts'), 'utf-8');
      writeFileSync(join(tempDir, 'cli.ts'), source);
      const db = { config: { projectRoot: tempDir } } as ScipDatabase;

      const tree = getAst(db, 'cli.ts');
      expect(tree?.rootNode.type).toBe('program');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
