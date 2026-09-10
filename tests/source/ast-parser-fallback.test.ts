import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAst, getAstForSource } from '../../src/source/ast.js';
import type { ScipDatabase } from '../../src/storage/db.js';
import { collectNativeGarbage } from '../../src/domain/native-gc.js';
import { sourceBindingResolver } from '../../src/source/ast/source-binding-identity.js';
import * as bindingEffects from '../../src/source/ast/source-binding-effects.js';

async function collectAcrossTurns(): Promise<void> {
  for (let count = 0; count < 4; count++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(collectNativeGarbage()).toBe(true);
  }
}

describe('AST parser fallback', () => {
  it('retains root-keyed mutation analysis while a parsed tree is cached, then releases evicted roots', async () => {
    const db = { config: { projectRoot: tmpdir() } } as ScipDatabase;
    const source = 'const worker = () => 1; worker();';
    const effects = vi.spyOn(bindingEffects, 'sourceBindingEffects');
    const read = () => {
      const root = getAstForSource(db, 'cached.ts', source)!.rootNode;
      const target = root.descendantsOfType('identifier').at(-1)!;
      expect(sourceBindingResolver('cached.ts', root).hasObservedCallableWrite(target)).toBe(false);
      return new WeakRef(root);
    };
    try {
      const original = read();
      await collectAcrossTurns();
      expect(original.deref()).toBeDefined();
      read();
      expect(effects).toHaveBeenCalledTimes(1);
      for (let count = 0; count < 300; count++) getAstForSource(db, `other-${count}.ts`, source);
      await collectAcrossTurns();
      expect(original.deref()).toBeUndefined();
      read();
      expect(effects).toHaveBeenCalledTimes(2);
    } finally {
      effects.mockRestore();
    }
  });

  it('replaces cached binding analysis when the source bytes change', () => {
    const db = { config: { projectRoot: tmpdir() } } as ScipDatabase;
    const read = (source: string) => {
      const root = getAstForSource(db, 'edit.ts', source)!.rootNode;
      return sourceBindingResolver('edit.ts', root).hasObservedCallableWrite(
        root.descendantsOfType('identifier').at(-1)!,
      );
    };
    expect(read('let worker = () => 1; worker();')).toBe(false);
    expect(read('let worker = () => 1; worker = () => 2; worker();')).toBe(true);
    expect(read('let worker = () => 1; worker();')).toBe(false);
  });

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
