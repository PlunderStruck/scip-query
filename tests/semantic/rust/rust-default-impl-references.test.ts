import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IndexedDefinition } from '../../../src/domain/types.js';
import { rustDefaultImplReferencesForDefinition } from '../../../src/semantic/rust/default-impl-references.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const DEFAULT_SYMBOL = 'rust-analyzer cargo fixture 0.1.0 lib/impl#[BubbleTrail][Default]default().';

function rustDefaultDefinition(overrides: Partial<IndexedDefinition> = {}): IndexedDefinition {
  return {
    symbolId: 10,
    symbol: DEFAULT_SYMBOL,
    documentId: 1,
    startLine: 1,
    startChar: 0,
    endLine: 3,
    endChar: 1,
    relativePath: 'src/lib.rs',
    leaf: 'default',
    parentTypeName: null,
    isFunctionLike: true,
    isTypeLike: false,
    kind: 80,
    documentation: null,
    enclosingSymbol: null,
    ...overrides,
  };
}

function withDefaultFixture(
  sourceLines: readonly string[],
  run: (db: ScipDatabase) => void,
  opts: { includeDefinition?: boolean } = {},
): void {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-rust-default-'));
  const dbPath = join(projectRoot, 'index.db');
  writeFixtureFiles(projectRoot, {
    'src/lib.rs': sourceLines,
  });
  const fixture = evidenceFixtureDb(dbPath)
    .document(1, 'rust', 'src/lib.rs')
    .symbol(10, DEFAULT_SYMBOL, 'default', 80)
    .chunk(1, 1, 1, 3)
    .chunk(2, 1, 4, sourceLines.length - 1, 1)
    .mention(2, 10, 0);
  if (opts.includeDefinition !== false) {
    fixture.definition(1, 1, 10, 1, 0, 3, 1).mention(1, 10, 1);
  }
  fixture.write();

  const db = new ScipDatabase({
    dbPath,
    indexPath: join(projectRoot, 'index.scip'),
    projectRoot,
  });
  try {
    run(db);
  } finally {
    db.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

describe('rustDefaultImplReferencesForDefinition', () => {
  it('refines SCIP chunks into exact direct Owner::default reference columns', () => {
    const source = [
      'pub struct BubbleTrail;',
      'impl Default for BubbleTrail {',
      '    fn default() -> Self { Self }',
      '}',
      'pub fn use_it() {',
      '    let local = BubbleTrail::default();',
      '    let qualified = crate::effects::BubbleTrail::default();',
      '}',
    ];

    withDefaultFixture(source, (db) => {
      expect(rustDefaultImplReferencesForDefinition(db, rustDefaultDefinition())).toEqual([
        {
          file: 'src/lib.rs',
          line: 5,
          column: source[5]!.indexOf('default'),
        },
        {
          file: 'src/lib.rs',
          line: 6,
          column: source[6]!.indexOf('default'),
        },
      ]);
    });
  });

  it('falls back when a SCIP chunk only contains ambiguous Default::default syntax', () => {
    withDefaultFixture(
      [
        'pub struct BubbleTrail;',
        'impl Default for BubbleTrail {',
        '    fn default() -> Self { Self }',
        '}',
        'pub fn use_it() {',
        '    let local: BubbleTrail = Default::default();',
        '}',
      ],
      (db) => {
        expect(rustDefaultImplReferencesForDefinition(db, rustDefaultDefinition())).toBeNull();
      },
    );
  });

  it('refines explicit owner struct-update Default::default references', () => {
    const source = [
      'pub struct BubbleTrail {',
      '    name: String,',
      '}',
      'impl Default for BubbleTrail {',
      '    fn default() -> Self { Self { name: String::new() } }',
      '}',
      'pub fn use_it() {',
      '    let local = BubbleTrail {',
      '        name: String::new(),',
      '        ..Default::default()',
      '    };',
      '}',
    ];

    withDefaultFixture(source, (db) => {
      expect(rustDefaultImplReferencesForDefinition(db, rustDefaultDefinition())).toEqual([
        {
          file: 'src/lib.rs',
          line: 9,
          column: source[9]!.indexOf('default'),
        },
      ]);
    });
  });

  it('preserves direct references that SCIP indexed in Rust doc comments', () => {
    const source = [
      'pub struct BubbleTrail;',
      'impl Default for BubbleTrail {',
      '    fn default() -> Self { Self }',
      '}',
      '/// See [`BubbleTrail::default`] for the default trail.',
      'pub fn use_it() {}',
    ];

    withDefaultFixture(source, (db) => {
      expect(rustDefaultImplReferencesForDefinition(db, rustDefaultDefinition())).toEqual([
        {
          file: 'src/lib.rs',
          line: 4,
          column: source[4]!.indexOf('default'),
        },
      ]);
    });
  });

  it('falls back when Default::default is nested under another literal', () => {
    withDefaultFixture(
      [
        'pub struct BubbleTrail;',
        'impl Default for BubbleTrail {',
        '    fn default() -> Self { Self }',
        '}',
        'pub fn use_it() {',
        '    let local = BubbleTrail {',
        '        other: OtherTrail { ..Default::default() },',
        '        ..Default::default()',
        '    };',
        '}',
      ],
      (db) => {
        expect(rustDefaultImplReferencesForDefinition(db, rustDefaultDefinition())).toBeNull();
      },
    );
  });

  it('falls back for struct-update Default::default when the impl has no definition mention', () => {
    withDefaultFixture(
      [
        'pub struct BubbleTrail;',
        '',
        '',
        'pub fn use_it() {',
        '    let local = BubbleTrail {',
        '        ..Default::default()',
        '    };',
        '}',
      ],
      (db) => {
        expect(rustDefaultImplReferencesForDefinition(db, rustDefaultDefinition())).toBeNull();
      },
      { includeDefinition: false },
    );
  });
});
