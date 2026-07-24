import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { isReaderMacroPrefix, isTokenDelimiter, skipString } from '../../src/source/facts/clojure-facts.js';
import { getSourceImports } from '../../src/language-parsers/index.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

/**
 * Regression coverage for twin-consolidation T2: the reader primitives here
 * used to be duplicated (once in this file, once in
 * language-parsers/languages/clojure.ts) and had drifted, found with
 * `scip-query twin-ab`. These lock in the resolved disagreements so a
 * future edit to the now-single implementation can't silently reintroduce
 * either bug.
 */
describe('Clojure reader primitives', () => {
  it('isReaderMacroPrefix treats "#" as a dispatch-macro prefix', () => {
    // '#' starts Clojure's dispatch macros: #{...} sets, #(...) anonymous
    // fns, #'sym var quotes, #"..." regexes. The parser's old local copy
    // was missing this, so those forms fell through to parseAtom as a
    // bogus one-character "#" atom.
    expect(isReaderMacroPrefix('#')).toBe(true);
    for (const char of ["'", '`', '~', '@', '^']) {
      expect(isReaderMacroPrefix(char)).toBe(true);
    }
    expect(isReaderMacroPrefix('a')).toBe(false);
  });

  it('isTokenDelimiter terminates a bare token at a string or comment boundary', () => {
    // A token like `sym;comment` or `#_;x` must stop at ';' or '"' even
    // with no whitespace before it. This file's old local copy was
    // missing both, so a symbol directly followed by a comment or string
    // would keep scanning into it.
    expect(isTokenDelimiter('"')).toBe(true);
    expect(isTokenDelimiter(';')).toBe(true);
    for (const char of [' ', '\t', '\n', ',', '(', ')', '[', ']', '{', '}']) {
      expect(isTokenDelimiter(char)).toBe(true);
    }
    expect(isTokenDelimiter('a')).toBe(false);
    expect(isTokenDelimiter('#')).toBe(false);
  });

  it('skipString finds the closing quote, tracking escapes and line numbers', () => {
    expect(skipString('"hello"', 0, 0)).toEqual({ index: 7, line: 0 });
    expect(skipString('"a\\"b"', 0, 0)).toEqual({ index: 6, line: 0 }); // escaped quote inside
    expect(skipString('"line1\nline2"', 0, 0)).toEqual({ index: 13, line: 1 }); // literal newline
    expect(skipString('"unterminated', 0, 0)).toEqual({ index: 13, line: 0 }); // runs to EOF
  });

  it('parses a namespace whose body uses a #{} set literal immediately after an alias reference, with no whitespace', () => {
    // End-to-end exercise of the isReaderMacroPrefix fix through the real
    // parser: '#{...}' right after a used-symbol reference, with no
    // separating whitespace, used to desync the reader's masking pass
    // because '#' was not recognized as a reader-macro prefix.
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-clojure-reader-primitives-'));
    try {
      const projectRoot = join(tempDir, 'project');
      const dbPath = join(tempDir, 'index.db');
      writeFixtureFiles(projectRoot, {
        'src/demo/core.clj': [
          '(ns demo.core',
          '  (:require [demo.util :as util]))',
          '',
          '(defn thing-set [] util/thing#{1 2 3})',
          '',
        ].join('\n'),
        'src/demo/util.clj': ['(ns demo.util)', '(def thing 1)', ''].join('\n'),
      });
      evidenceFixtureDb(dbPath)
        .document(1, 'clojure', 'src/demo/core.clj')
        .document(2, 'clojure', 'src/demo/util.clj')
        .write();
      const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(tempDir, 'index.scip') });
      try {
        const parsed = getSourceImports(db, 'src/demo/core.clj');
        expect(parsed).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              importedName: 'demo.util',
              localName: 'util',
              sourcePath: 'src/demo/util.clj',
              kind: 'namespace',
              used: true,
              usedMembers: ['thing'],
            }),
          ]),
        );
      } finally {
        db.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
