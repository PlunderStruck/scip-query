import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SemanticProvider } from '../../../src/semantic/types.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

afterEach(() => {
  vi.doUnmock('../../../src/semantic/rust/provider.js');
  vi.resetModules();
});

describe('Rust semantic callee cache gate', () => {
  it('computes Rust semantic callees instead of skipping them as non-TypeScript', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-callee-cache-'));
    const dbPath = join(projectRoot, 'index.db');
    const calleeSymbol = 'rust-analyzer cargo fixture 0.1.0 src/math.rs/compute_total().';
    writeFixtureFiles(projectRoot, {
      'src/main.rs': ['fn main() {', '    // semantic-only fixture: no indexed call mention', '}'],
      'src/math.rs': ['pub fn compute_total() -> i32 {', '    42', '}'],
    });
    mkdirSync(projectRoot, { recursive: true });
    evidenceFixtureDb(dbPath)
      .document(1, 'rust', 'src/main.rs')
      .document(2, 'rust', 'src/math.rs')
      .symbol(1, 'rust-analyzer cargo fixture 0.1.0 src/main.rs/main().', 'main', 12)
      .symbol(2, calleeSymbol, 'compute_total', 12)
      .definition(1, 1, 1, 0, 3, 2, 1)
      .definition(2, 2, 2, 0, 7, 2, 1)
      .chunk(1, 1, 0, 2)
      .chunk(2, 2, 0, 2)
      .mention(1, 1, 1)
      .mention(2, 2, 1)
      .write();

    let calleeCalls = 0;
    const fakeRustProvider: SemanticProvider = {
      language: 'rust',
      availability: () => ({
        available: true,
        dependencyAvailable: true,
        resolvedBinary: 'rust-analyzer',
        reason: 'fixture Rust callees available',
      }),
      importUsage: () => [],
      referencesFor: () => [],
      referencesForDefinitions: (definitions) => new Map(definitions.map((definition) => [definition.symbolId, []])),
      calleesFor: () => [],
      calleesForDefinitions: (definitions) => {
        calleeCalls += 1;
        return new Map(
          definitions.map((definition) => [
            definition.symbolId,
            definition.symbol.endsWith('/main().') ? [{ symbol: calleeSymbol, file: 'src/math.rs', line: 0 }] : [],
          ]),
        );
      },
      signatureFor: () => null,
    };
    vi.doMock('../../../src/semantic/rust/provider.js', () => ({
      createRustSemanticProvider: () => fakeRustProvider,
    }));

    const { callGraph } = await import('../../../src/queries/navigation/call-graph.js');
    const db = new ScipDatabase({
      dbPath,
      indexPath: join(projectRoot, 'index.scip'),
      projectRoot,
    });

    try {
      const graph = callGraph(db, 'main');
      const cachedGraph = callGraph(db, 'main');

      expect(graph?.callees.map((callee) => callee.shortName)).toEqual(['src:math:rs:compute_total()']);
      expect(cachedGraph?.callees.map((callee) => callee.shortName)).toEqual(['src:math:rs:compute_total()']);
      expect(calleeCalls).toBe(1);
    } finally {
      db.close();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
