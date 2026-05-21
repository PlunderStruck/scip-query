import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAst } from '../src/ast.js';
import type { ScipDatabase } from '../src/db.js';

describe('AST parser fallback', () => {
  it('falls back instead of crashing when tree-sitter rejects a source file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-ast-fallback-'));
    try {
      const source = readFileSync(join(process.cwd(), 'src', 'cli.ts'), 'utf-8');
      writeFileSync(join(tempDir, 'cli.ts'), source);
      const db = { config: { projectRoot: tempDir } } as ScipDatabase;

      expect(() => getAst(db, 'cli.ts')).not.toThrow();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
