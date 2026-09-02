import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../../src/storage/db.js';
import { applyWrapperFacadeEvidence, wrapperCandidates } from '../../../src/queries/cleanup/wrapper-candidates.js';
import type { ScipQueryConfig } from '../../../src/domain/types.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

describe('wrapper-candidates', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function singleConsumerFixture(normalizeBody: readonly string[]): ScipDatabase {
    const root = mkdtempSync(join(tmpdir(), 'scip-wrapper-candidates-'));
    tempDirs.push(root);
    writeFixtureFiles(root, {
      'src/NormalizeRelay.java': [
        'package fixture;',
        'public final class NormalizeRelay {',
        '  public static String normalize(String raw) {',
        ...normalizeBody,
        '  }',
        '}',
      ],
      'src/Presenter.java': [
        'package fixture;',
        'public final class Presenter {',
        '  public String render(String raw) {',
        '    return NormalizeRelay.normalize(raw);',
        '  }',
        '}',
      ],
      'src/A.java': reporter('A', 'renderA'),
      'src/B.java': reporter('B', 'renderB'),
      'src/C.java': reporter('C', 'renderC'),
      'src/D.java': reporter('D', 'renderD'),
    });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'java', 'src/NormalizeRelay.java')
      .document(2, 'java', 'src/Presenter.java')
      .document(3, 'java', 'src/A.java')
      .document(4, 'java', 'src/B.java')
      .document(5, 'java', 'src/C.java')
      .document(6, 'java', 'src/D.java')
      .symbol(1, 'semanticdb maven . . fixture/NormalizeRelay#', 'NormalizeRelay', 5)
      .symbol(2, 'semanticdb maven . . fixture/NormalizeRelay#normalize().', 'normalize', 12)
      .symbol(3, 'semanticdb maven . . fixture/Presenter#', 'Presenter', 5)
      .symbol(4, 'semanticdb maven . . fixture/Presenter#render().', 'render', 12)
      .symbol(5, 'semanticdb maven . . fixture/A#renderA().', 'renderA', 12)
      .symbol(6, 'semanticdb maven . . fixture/B#renderB().', 'renderB', 12)
      .symbol(7, 'semanticdb maven . . fixture/C#renderC().', 'renderC', 12)
      .symbol(8, 'semanticdb maven . . fixture/D#renderD().', 'renderD', 12)
      .definition(1, 1, 1, 1, 0, 5, 1)
      .definition(2, 1, 2, 2, 2, 4, 3)
      .definition(3, 2, 3, 1, 0, 5, 1)
      .definition(4, 2, 4, 2, 2, 4, 3)
      .definition(5, 3, 5, 2, 2, 4, 3)
      .definition(6, 4, 6, 2, 2, 4, 3)
      .definition(7, 5, 7, 2, 2, 4, 3)
      .definition(8, 6, 8, 2, 2, 4, 3)
      .chunk(1, 1, 0, 6)
      .chunk(2, 2, 0, 6)
      .chunk(3, 3, 0, 6)
      .chunk(4, 4, 0, 6)
      .chunk(5, 5, 0, 6)
      .chunk(6, 6, 0, 6)
      .mention(1, 1, 1)
      .mention(1, 2, 1)
      .mention(2, 3, 1)
      .mention(2, 4, 1)
      .mention(2, 2, 0)
      .mention(3, 5, 1)
      .mention(3, 4, 0)
      .mention(4, 6, 1)
      .mention(4, 4, 0)
      .mention(5, 7, 1)
      .mention(5, 4, 0)
      .mention(6, 8, 1)
      .mention(6, 4, 0)
      .write();

    const config: ScipQueryConfig = {
      projectRoot: root,
      dbPath,
      indexPath: join(root, 'index.scip'),
    };
    return new ScipDatabase(config);
  }

  it('reports a tiny wrapper whose sole caller has broad fan-in', () => {
    const db = singleConsumerFixture(['    return Normalizer.normalize(raw);']);
    try {
      expect(wrapperCandidates(db, { limit: 10, semantic: false })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            shortName: expect.stringContaining('normalize'),
            singleCallerShort: expect.stringContaining('render'),
            callerFanIn: 4,
            bodyShape: 'forwarding',
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('keeps a single-consumer callable that prepares its argument as a helper-shaped signal', () => {
    const db = singleConsumerFixture(['    String key = raw.trim();', '    return Normalizer.normalize(key);']);
    try {
      expect(wrapperCandidates(db, { limit: 10, semantic: false })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            shortName: expect.stringContaining('normalize'),
            bodyShape: 'helper',
            actionTier: 'signal',
            boundaryEvidence: expect.arrayContaining(['body computes or branches rather than forwarding one call']),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('marks a forward through module-private state as a boundary signal', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-wrapper-private-state-'));
    tempDirs.push(root);
    const consumer = (name: string) => [
      "import { load } from './store';",
      `export function ${name}(lang: string) {`,
      '  return load(lang);',
      '}',
    ];
    writeFixtureFiles(root, {
      'src/i18n.ts': [
        'const loadedLanguages = new Set<string>();',
        'export function isLanguageLoaded(lang: string): boolean {',
        '  return loadedLanguages.has(lang);',
        '}',
      ],
      'src/store.ts': [
        "import { isLanguageLoaded } from './i18n';",
        'export function load(lang: string) {',
        '  return isLanguageLoaded(lang);',
        '}',
      ],
      'src/a.ts': consumer('a'),
      'src/b.ts': consumer('b'),
      'src/c.ts': consumer('c'),
      'src/d.ts': consumer('d'),
    });
    const dbPath = join(root, 'index.db');
    const sym = (file: string, name: string) => `scip-typescript npm fixture 1.0.0 src/\`${file}\`/${name}().`;
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/i18n.ts')
      .document(2, 'typescript', 'src/store.ts')
      .document(3, 'typescript', 'src/a.ts')
      .document(4, 'typescript', 'src/b.ts')
      .document(5, 'typescript', 'src/c.ts')
      .document(6, 'typescript', 'src/d.ts')
      .symbol(1, sym('i18n.ts', 'isLanguageLoaded'), 'isLanguageLoaded', 12)
      .symbol(2, sym('store.ts', 'load'), 'load', 12)
      .symbol(3, sym('a.ts', 'a'), 'a', 12)
      .symbol(4, sym('b.ts', 'b'), 'b', 12)
      .symbol(5, sym('c.ts', 'c'), 'c', 12)
      .symbol(6, sym('d.ts', 'd'), 'd', 12)
      .definition(1, 1, 1, 1, 0, 3, 1)
      .definition(2, 2, 2, 1, 0, 3, 1)
      .definition(3, 3, 3, 1, 0, 3, 1)
      .definition(4, 4, 4, 1, 0, 3, 1)
      .definition(5, 5, 5, 1, 0, 3, 1)
      .definition(6, 6, 6, 1, 0, 3, 1)
      .chunk(1, 1, 0, 4)
      .chunk(2, 2, 0, 4)
      .chunk(3, 3, 0, 4)
      .chunk(4, 4, 0, 4)
      .chunk(5, 5, 0, 4)
      .chunk(6, 6, 0, 4)
      .mention(1, 1, 1)
      .mention(2, 2, 1)
      .mention(2, 1, 0)
      .mention(3, 3, 1)
      .mention(3, 2, 0)
      .mention(4, 4, 1)
      .mention(4, 2, 0)
      .mention(5, 5, 1)
      .mention(5, 2, 0)
      .mention(6, 6, 1)
      .mention(6, 2, 0)
      .write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      expect(wrapperCandidates(db, { limit: 10, semantic: false })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            shortName: expect.stringContaining('isLanguageLoaded'),
            bodyShape: 'forwarding',
            actionTier: 'signal',
            boundaryEvidence: expect.arrayContaining(['forwards through module-private state: loadedLanguages']),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('tiers a file of wrappers that forward through one receiver as a facade', () => {
    const row = (name: string, file: string) => ({
      symbol: `sym:${file}:${name}`,
      shortName: name,
      file,
      startLine: 0,
      endLine: 2,
      loc: 3,
      singleCaller: 'caller',
      singleCallerShort: 'caller',
      callerFanIn: 6,
      actionTier: 'direct' as const,
      bodyShape: 'forwarding' as const,
      boundaryEvidence: [] as string[],
    });
    const rows = [
      row('buildWelcomeCopy', 'src/copy.ts'),
      row('buildPayoutCopy', 'src/copy.ts'),
      row('buildReminderCopy', 'src/copy.ts'),
      row('formatPhone', 'src/phone.ts'),
    ];
    const receivers = new Map([
      [rows[0]!.symbol, 'COPY'],
      [rows[1]!.symbol, 'COPY'],
      [rows[2]!.symbol, 'COPY'],
      [rows[3]!.symbol, 'parse'],
    ]);
    const results = applyWrapperFacadeEvidence(rows, receivers);
    expect(results.slice(0, 3).map((candidate) => candidate.actionTier)).toEqual(['signal', 'signal', 'signal']);
    expect(results[0]?.boundaryEvidence).toEqual(['facade: 3 sibling forwards from this file through COPY']);
    expect(results[3]).toEqual(expect.objectContaining({ actionTier: 'direct', boundaryEvidence: [] }));
  });

  it('excludes Rust trait implementation methods from wrapper advice', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-wrapper-rust-trait-'));
    tempDirs.push(root);
    writeFixtureFiles(root, {
      'src/model.rs': [
        'pub struct Model;',
        'impl Default for Model {',
        '  fn default() -> Self {',
        '    Self',
        '  }',
        '}',
      ],
      'src/build.rs': ['use crate::model::Model;', 'pub fn build() -> Model {', '  Model::default()', '}'],
    });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'rust', 'src/model.rs')
      .document(2, 'rust', 'src/build.rs')
      .symbol(1, 'rust-analyzer cargo fixture 0.1.0 model/Model#', 'Model', 5)
      .symbol(2, 'rust-analyzer cargo fixture 0.1.0 model/impl#[Model][Default]default().', 'default', 12)
      .symbol(3, 'rust-analyzer cargo fixture 0.1.0 build/build().', 'build', 12)
      .definition(1, 1, 1, 0, 0, 0, 16)
      .definition(2, 1, 2, 2, 2, 4, 3)
      .definition(3, 2, 3, 1, 1, 3, 2)
      .chunk(1, 1, 0, 6)
      .chunk(2, 2, 0, 4)
      .mention(1, 1, 1)
      .mention(1, 2, 1)
      .mention(2, 3, 1)
      .mention(2, 2, 0)
      .write();

    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      expect(wrapperCandidates(db, { limit: 10, semantic: false }).map((finding) => finding.shortName)).not.toEqual(
        expect.arrayContaining([expect.stringContaining('default')]),
      );
    } finally {
      db.close();
    }
  });
});

function reporter(className: string, methodName: string): string {
  return [
    'package fixture;',
    `public final class ${className} {`,
    '  private final Presenter presenter = new Presenter();',
    `  public String ${methodName}(String raw) {`,
    '    return presenter.render(raw);',
    '  }',
    '}',
  ].join('\n');
}
