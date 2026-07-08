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

      const { resolveRustCalleeSymbol } = await import('../../../src/semantic/rust/callee-symbol-resolution.js');
      const db = new ScipDatabase({
        dbPath,
        indexPath: join(projectRoot, 'index.scip'),
        projectRoot,
      });
      try {
        expect(resolveRustCalleeSymbol(db, { symbol: 'compute_total', file: 'src/math.rs', line: 2 })).toBe(
          'rust-analyzer cargo fixture 0.1.0 src/math.rs/compute_total().',
        );
        expect(resolveRustCalleeSymbol(db, { symbol: 'missing', file: 'src/math.rs', line: 99 })).toBe('missing');
      } finally {
        db.close();
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
