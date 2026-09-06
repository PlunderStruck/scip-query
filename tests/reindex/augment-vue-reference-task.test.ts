import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  computeVueReferenceTask,
  isVueModulePathToken,
  type VueReferenceComputationOptions,
  vueDefinitionOmissionReason,
} from '../../src/reindex/vue/augment-vue.js';
import { createSymbolLookup } from '../../src/reindex/vue/augment-vue-runtime.js';

describe('Vue reference task computation', () => {
  it('does not index identifier-looking fragments inside module paths', () => {
    const source = "import Other from './components/Other.vue'\nconst lazy = import('./LazyView.vue')";
    expect(isVueModulePathToken(source, source.indexOf('components'))).toBe(true);
    expect(isVueModulePathToken(source, source.indexOf('Other'))).toBe(false);
    expect(isVueModulePathToken(source, source.indexOf('LazyView'))).toBe(true);
  });

  it('does not map a property definition to an unrelated enclosing callable', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE documents (id INTEGER PRIMARY KEY, relative_path TEXT NOT NULL, position_encoding TEXT);
      CREATE TABLE global_symbols (id INTEGER PRIMARY KEY, display_name TEXT, symbol TEXT);
      CREATE TABLE defn_enclosing_ranges (
        document_id INTEGER NOT NULL,
        symbol_id INTEGER NOT NULL,
        start_line INTEGER NOT NULL, start_char INTEGER NOT NULL DEFAULT 0,
        end_line INTEGER NOT NULL, end_char INTEGER NOT NULL DEFAULT 20
      );
      INSERT INTO documents (id, relative_path) VALUES (1, 'src/settings.js');
      INSERT INTO global_symbols (id, display_name) VALUES (7, 'load');
      INSERT INTO defn_enclosing_ranges (document_id, symbol_id, start_line, end_line) VALUES (1, 7, 2, 20);
    `);
    const lookup = createSymbolLookup(db, '/project', {
      get: () => ({
        text: 'x'.repeat(20).concat('\n').repeat(24),
        lineStarts: Array.from({ length: 24 }, (_, i) => i * 21),
      }),
      positionAt: (_source, offset) => ({ line: offset, character: 0 }),
    });

    expect(
      lookup({ fileName: '/project/src/settings.js', textSpan: { start: 5, length: 4 }, name: 'mode' }),
    ).toBeNull();
    expect(lookup({ fileName: '/project/src/settings.js', textSpan: { start: 5, length: 4 }, name: 'load' })).toBe(7);
    db.close();
  });

  it('resolves absent display names and distinguishes same-line definitions by columns', () => {
    const db = new Database(':memory:');
    const source = 'export class A { run() { return 1; } } export class B { run() { return 2; } }';
    const first = source.indexOf('run');
    const second = source.lastIndexOf('run');
    db.exec(`
      CREATE TABLE documents (id INTEGER PRIMARY KEY, relative_path TEXT, position_encoding TEXT);
      CREATE TABLE global_symbols (id INTEGER PRIMARY KEY, symbol TEXT, display_name TEXT);
      CREATE TABLE defn_enclosing_ranges (document_id INTEGER, symbol_id INTEGER, start_line INTEGER, start_char INTEGER, end_line INTEGER, end_char INTEGER);
      INSERT INTO documents VALUES (1, 'src/classes.ts', 'UTF-16');
      INSERT INTO global_symbols VALUES (1, 'scip-typescript npm fixture 1 src/\`classes.ts\`/A#run().', NULL), (2, 'scip-typescript npm fixture 1 src/\`classes.ts\`/B#run().', NULL);
      INSERT INTO defn_enclosing_ranges VALUES (1, 1, 0, ${first}, 0, ${first + 19}), (1, 2, 0, ${second}, 0, ${second + 19});
    `);
    try {
      const lookup = createSymbolLookup(db, '/project', {
        get: () => ({ text: source, lineStarts: [0] }),
        positionAt: (_source, offset) => ({ line: 0, character: offset }),
      });
      expect(lookup({ fileName: '/project/src/classes.ts', textSpan: { start: first, length: 3 }, name: 'run' })).toBe(
        1,
      );
      expect(lookup({ fileName: '/project/src/classes.ts', textSpan: { start: second, length: 3 }, name: 'run' })).toBe(
        2,
      );
      expect(
        lookup({ fileName: '/project/src/classes.ts', textSpan: { start: 0, length: 3 }, name: 'run' }),
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  it('inserts only cross-file Vue component identities into the graph', () => {
    expect(vueDefinitionOmissionReason('src/View.vue', 'localState', 'src/View.vue')).toBe('same-file-definition');
    expect(vueDefinitionOmissionReason('src/View.vue', 'foreignBinding', 'src/Other.vue')).toBe('unindexed-definition');
    expect(vueDefinitionOmissionReason('src/View.vue', 'Other', 'src/Other.vue')).toBeNull();
    expect(vueDefinitionOmissionReason('src/View.vue', 'getAgentColor', 'src/useSettings.js')).toBeNull();
  });

  it('counts a missing project file as skipped before asking Volar to load it', () => {
    const getSourceScript = vi.fn(() => {
      throw new Error('Volar must not load a source file that does not exist');
    });
    const options = {
      projectRoot: '/project',
      sourceReader: { get: vi.fn(() => null) },
      context: { language: { scripts: { get: getSourceScript } } },
    } as unknown as VueReferenceComputationOptions;

    expect(
      computeVueReferenceTask(options, {
        fileName: '/project/src/MissingView.vue',
        startOffset: 0,
        endOffset: Number.POSITIVE_INFINITY,
        countFileSkip: true,
      }),
    ).toEqual({
      occurrences: [],
      skippedReferences: 1,
      skippedReferenceReasons: {
        'missing-source-file': 1,
        'missing-service-script': 0,
        'no-definition': 0,
        'same-file-definition': 0,
        'unindexed-definition': 0,
      },
      skippedReferenceSamples: [
        {
          sourceFile: 'src/MissingView.vue',
          sourceLine: 0,
          sourceStartChar: 0,
          sourceEndChar: 0,
          token: '',
          reason: 'missing-source-file',
        },
      ],
    });
    expect(getSourceScript).not.toHaveBeenCalled();
  });
});
