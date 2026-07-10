import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb } from '../../fixtures/evidence-fixture.js';

describe('Rust callee symbol resolution', () => {
  it('maps rust-analyzer callee names and locations back to SCIP symbols', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-callee-symbol-'));
    const dbPath = join(projectRoot, 'index.db');
    try {
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      writeFileSync(
        join(projectRoot, 'src/math.rs'),
        ['pub fn unrelated() {}', '', 'pub fn compute_total(value: i32) -> i32 {', '    value + 1', '}'].join('\n'),
      );
      evidenceFixtureDb(dbPath)
        .document(1, 'rust', 'src/math.rs')
        .symbol(1, 'rust-analyzer cargo fixture 0.1.0 src/math.rs/unrelated().', 'unrelated', 12)
        .symbol(2, 'rust-analyzer cargo fixture 0.1.0 src/math.rs/compute_total().', 'compute_total', 12)
        .definition(1, 1, 1, 0, 7, 0, 23)
        .definition(2, 1, 2, 2, 7, 4, 1)
        .chunk(1, 1, 0, 4)
        .mention(1, 1, 1)
        .mention(1, 2, 1)
        .write();

      const { createRustCalleeSymbolResolver, resolveRustCalleeSymbol } =
        await import('../../../src/semantic/rust/callee-symbol-resolution.js');
      const db = new ScipDatabase({
        dbPath,
        indexPath: join(projectRoot, 'index.scip'),
        projectRoot,
      });
      try {
        expect(resolveRustCalleeSymbol(db, { symbol: 'compute_total', file: 'src/math.rs', line: 2 })).toBe(
          'rust-analyzer cargo fixture 0.1.0 src/math.rs/compute_total().',
        );
        const resolveFromIndexedFile = createRustCalleeSymbolResolver(db);
        expect(resolveFromIndexedFile({ symbol: 'compute_total', file: 'src/math.rs', line: 2 })).toBe(
          'rust-analyzer cargo fixture 0.1.0 src/math.rs/compute_total().',
        );
        expect(resolveFromIndexedFile({ symbol: 'missing', file: 'src/math.rs', line: 99 })).toBe('missing');
        expect(
          resolveFromIndexedFile({ symbol: 'external_fn', file: '../../../.cargo/registry/src/pkg/lib.rs', line: 10 }),
        ).toBe('external_fn');
        expect(resolveRustCalleeSymbol(db, { symbol: 'missing', file: 'src/math.rs', line: 99 })).toBe('missing');
      } finally {
        db.close();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('caches resolved callee symbols by file, symbol, and line', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-callee-symbol-cache-'));
    const dbPath = join(projectRoot, 'index.db');
    const firstSymbol = 'rust-analyzer cargo fixture 0.1.0 src/actions.rs/impl#[Alpha]tick().';
    const secondSymbol = 'rust-analyzer cargo fixture 0.1.0 src/actions.rs/impl#[Beta]tick().';
    try {
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      writeFileSync(
        join(projectRoot, 'src/actions.rs'),
        ['impl Alpha {', '    pub fn tick(&self) {}', '}', '', 'impl Beta {', '    pub fn tick(&self) {}', '}'].join(
          '\n',
        ),
      );
      evidenceFixtureDb(dbPath)
        .document(1, 'rust', 'src/actions.rs')
        .symbol(1, firstSymbol, 'tick', 12)
        .symbol(2, secondSymbol, 'tick', 12)
        .definition(1, 1, 1, 1, 11, 1, 31)
        .definition(2, 1, 2, 5, 11, 5, 31)
        .chunk(1, 1, 0, 6)
        .mention(1, 1, 1)
        .mention(1, 2, 1)
        .write();

      const { createRustCalleeSymbolResolver } = await import('../../../src/semantic/rust/callee-symbol-resolution.js');
      const db = new ScipDatabase({
        dbPath,
        indexPath: join(projectRoot, 'index.scip'),
        projectRoot,
      });
      try {
        const resolve = createRustCalleeSymbolResolver(db);
        expect(resolve({ symbol: 'tick', file: 'src/actions.rs', line: 1 })).toBe(firstSymbol);
        expect(resolve({ symbol: 'tick', file: 'src/actions.rs', line: 5 })).toBe(secondSymbol);
        expect(resolve({ symbol: 'tick', file: 'src/actions.rs', line: 1 })).toBe(firstSymbol);
      } finally {
        db.close();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
