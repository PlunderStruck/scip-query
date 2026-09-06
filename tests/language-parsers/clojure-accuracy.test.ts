import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { getSourceImports } from '../../src/language-parsers/index.js';
import { similarConsolidationPlan } from '../../src/queries/cleanup/similar.js';
import { affected } from '../../src/queries/graph/affected.js';
import { callGraph } from '../../src/queries/navigation/call-graph.js';
import { importedBy, imports, unusedImports } from '../../src/queries/navigation/imports.js';
import { members } from '../../src/queries/navigation/members.js';
import { methods } from '../../src/queries/navigation/methods.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { getSourceFacts } from '../../src/source/ast.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('Clojure import parser', () => {
  it('extracts namespace aliases, referred vars, and source paths from ns forms', () => {
    withClojureFixture((db) => {
      const parsed = getSourceImports(db, 'src/demo/core.clj');

      expect(parsed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            importedName: 'demo.util',
            localName: 'util',
            sourcePath: 'src/demo/util.clj',
            kind: 'namespace',
            used: true,
            usedMembers: ['format-name'],
          }),
          expect.objectContaining({
            importedName: 'normalize',
            localName: 'normalize',
            sourcePath: 'src/demo/shared.cljc',
            kind: 'named',
            used: true,
          }),
          expect.objectContaining({
            importedName: 'unused-helper',
            localName: 'unused-helper',
            sourcePath: 'src/demo/shared.cljc',
            kind: 'named',
            used: false,
          }),
          expect.objectContaining({
            importedName: 'java.io.File',
            localName: 'File',
            sourcePath: null,
            kind: 'named',
          }),
        ]),
      );
    });
  });

  it('feeds Clojure namespace imports into import commands', () => {
    withClojureFixture((db) => {
      expect(imports(db, 'src/demo/core.clj')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            shortName: 'demo.util as util',
            fromFile: 'src/demo/util.clj',
          }),
          expect.objectContaining({
            shortName: 'normalize',
            fromFile: 'src/demo/shared.cljc',
          }),
        ]),
      );

      expect(unusedImports(db, 'src/demo/core.clj')).toEqual([
        expect.objectContaining({
          shortName: 'unused-helper',
          importedIn: 'src/demo/core.clj',
        }),
      ]);
    });
  });

  it('handles cljs aliases and ignores namespace-looking text in comments and strings', () => {
    withClojureFixture((db) => {
      const parsed = getSourceImports(db, 'src/demo/view.cljs');

      expect(parsed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            importedName: 'demo.ui',
            localName: 'ui',
            sourcePath: 'src/demo/ui.cljs',
            used: true,
            usedMembers: ['render'],
          }),
          expect.objectContaining({
            importedName: 'demo.only-comment',
            localName: 'oc',
            sourcePath: null,
            used: false,
          }),
        ]),
      );
    });
  });

  it('extracts requires from cljc reader conditional branches', () => {
    withClojureFixture((db) => {
      const parsed = getSourceImports(db, 'src/demo/platform.cljc');

      expect(parsed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            importedName: 'demo.jvm',
            localName: 'jvm',
            sourcePath: 'src/demo/jvm.clj',
            kind: 'namespace',
            used: true,
            usedMembers: ['read-config'],
          }),
          expect.objectContaining({
            importedName: 'demo.browser',
            localName: 'browser',
            sourcePath: 'src/demo/browser.cljs',
            kind: 'namespace',
            used: true,
            usedMembers: ['read-config'],
          }),
          expect.objectContaining({
            importedName: 'demo.extra',
            localName: 'extra',
            sourcePath: 'src/demo/extra.cljc',
            kind: 'namespace',
            used: true,
            usedMembers: ['normalize'],
          }),
        ]),
      );
    });
  });

  it('uses namespace aliases to resolve Clojure call graph and impact edges', () => {
    withClojureCallFixture((db) => {
      const greetFacts = getSourceFacts(db, 'src/demo/core.clj')!;
      expect(greetFacts.callSites).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            calleeLeaf: 'format-name',
            calleeQualifier: 'util',
            calleeText: 'util/format-name',
          }),
        ]),
      );

      const graph = callGraph(db, 'demo.core:greet')!;
      expect(graph.callees.map((callee) => callee.shortName)).toEqual(
        expect.arrayContaining(['demo.util:format-name', 'demo.shared:normalize']),
      );
      expect(graph.callees.map((callee) => callee.shortName)).not.toContain('demo.other:format-name');
      expect(affected(db, 'demo.core:greet').map((row) => row.shortName)).toContain('demo.consumer:run');

      expect(importedBy(db, 'demo.util')).toEqual([
        expect.objectContaining({
          symbol: 'demo.util',
          shortName: 'demo.util',
          fromFile: 'src/demo/core.clj',
        }),
      ]);
    });
  });

  it('reports protocol and record methods from Clojure source forms', () => {
    withClojureParityFixture((db) => {
      expect(getSourceFacts(db, 'src/demo/protocols.clj')?.clojureMembers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ownerName: 'GreetingProtocol',
            memberName: 'greet',
            memberKind: 'protocol-method',
          }),
          expect.objectContaining({
            ownerName: 'GreetingProtocol',
            memberName: 'reset-state',
            memberKind: 'protocol-method',
          }),
        ]),
      );

      expect(members(db, 'GreetingProtocol').map((member) => member.shortName)).toEqual(
        expect.arrayContaining([
          'demo.protocols:GreetingProtocol:greet()',
          'demo.protocols:GreetingProtocol:reset-state()',
        ]),
      );
      expect(methods(db, 'ConsoleGreeter').map((method) => method.name)).toEqual(
        expect.arrayContaining(['greet', 'reset-state']),
      );
      expect(members(db, 'ConsoleGreeter').map((member) => member.kind)).toEqual(
        expect.arrayContaining(['record-method']),
      );
    });
  });

  it('keeps Clojure macro scaffolding out of the similar plan alias', () => {
    withClojureParityFixture((db) => {
      const result = similarConsolidationPlan(db, 'alpha', 'beta');
      expect(result).not.toBeNull();
      expect(result!.sharedEvidence).not.toContain('demo.macros:with-log');
      expect(result!.sharedEvidence).not.toContain('hooks.hsx:defc');
      expect(result!.consolidationStrategy).toContain('shared source-token');
    });
  });
});

function withClojureFixture(run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-clojure-parser-'));
  try {
    const projectRoot = join(tempDir, 'project');
    const dbPath = join(tempDir, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/demo/core.clj': [
        '(ns demo.core',
        '  (:require [demo.util :as util]',
        '            [demo.shared :refer [normalize unused-helper]])',
        '  (:import [java.io File]))',
        '',
        '(defn greet [name]',
        '  (let [file (File. "name.txt")]',
        '    (util/format-name (normalize name))))',
        '',
      ].join('\n'),
      'src/demo/util.clj': ['(ns demo.util)', '(defn format-name [value] value)', ''].join('\n'),
      'src/demo/shared.cljc': [
        '(ns demo.shared)',
        '(defn normalize [value] value)',
        '(defn unused-helper [value] value)',
        '',
      ].join('\n'),
      'src/demo/view.cljs': [
        '(ns demo.view',
        '  (:require [demo.ui :as ui]',
        '            [demo.only-comment :as oc]))',
        '',
        '(defn render [state]',
        '  ;; oc/render should not count',
        '  (let [message "oc/render should not count"]',
        '    (ui/render state message)))',
        '',
      ].join('\n'),
      'src/demo/ui.cljs': ['(ns demo.ui)', '(defn render [state message] state)', ''].join('\n'),
      'src/demo/platform.cljc': [
        '(ns demo.platform',
        '  (:require #?(:clj [demo.jvm :as jvm]',
        '               :cljs [demo.browser :as browser])',
        '            #?@(:clj [[demo.extra :as extra]]',
        '                :cljs [[demo.extra :as extra]])))',
        '',
        '(defn read-platform []',
        '  (str (jvm/read-config) (browser/read-config) (extra/normalize :ok)))',
        '',
      ].join('\n'),
      'src/demo/jvm.clj': ['(ns demo.jvm)', '(defn read-config [] {})', ''].join('\n'),
      'src/demo/browser.cljs': ['(ns demo.browser)', '(defn read-config [] {})', ''].join('\n'),
      'src/demo/extra.cljc': ['(ns demo.extra)', '(defn normalize [value] value)', ''].join('\n'),
    });

    evidenceFixtureDb(dbPath)
      .document(1, 'clojure', 'src/demo/core.clj')
      .document(2, 'clojure', 'src/demo/util.clj')
      .document(3, 'clojure', 'src/demo/shared.cljc')
      .document(4, 'clojure', 'src/demo/view.cljs')
      .document(5, 'clojure', 'src/demo/ui.cljs')
      .document(6, 'clojure', 'src/demo/platform.cljc')
      .document(7, 'clojure', 'src/demo/jvm.clj')
      .document(8, 'clojure', 'src/demo/browser.cljs')
      .document(9, 'clojure', 'src/demo/extra.cljc')
      .symbol(1, 'scip-clojure npm fixture 0.1.0 src/demo/util.clj/demo.util.', 'demo.util', 3)
      .symbol(2, 'scip-clojure npm fixture 0.1.0 src/demo/shared.cljc/normalize().', 'normalize', 12)
      .definition(1, 2, 1, 0, 0, 0, 14)
      .definition(2, 3, 2, 1, 0, 1, 30)
      .write();

    const db = new ScipDatabase({
      projectRoot,
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
    });
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function withClojureCallFixture(run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-clojure-calls-'));
  try {
    const projectRoot = join(tempDir, 'project');
    const dbPath = join(tempDir, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/demo/core.clj': [
        '(ns demo.core',
        '  (:require [demo.util :as util]',
        '            [demo.shared :refer [normalize]]))',
        '',
        '(defn greet [name]',
        '  (util/format-name (normalize name)))',
        '',
      ].join('\n'),
      'src/demo/util.clj': ['(ns demo.util)', '(defn format-name [value] value)', ''].join('\n'),
      'src/demo/other.clj': ['(ns demo.other)', '(defn format-name [value] value)', ''].join('\n'),
      'src/demo/shared.cljc': ['(ns demo.shared)', '(defn normalize [value] value)', ''].join('\n'),
      'src/demo/consumer.clj': [
        '(ns demo.consumer',
        '  (:require [demo.core :as core]))',
        '',
        '(defn run []',
        '  (core/greet "A"))',
        '',
      ].join('\n'),
    });

    evidenceFixtureDb(dbPath)
      .document(1, 'clojure', 'src/demo/core.clj')
      .document(2, 'clojure', 'src/demo/util.clj')
      .document(3, 'clojure', 'src/demo/other.clj')
      .document(4, 'clojure', 'src/demo/shared.cljc')
      .document(5, 'clojure', 'src/demo/consumer.clj')
      .symbol(2, 'scip-clojure deps.edn fixture . `demo.util`/format-name.', 'format-name', 17)
      .symbol(3, 'scip-clojure deps.edn fixture . `demo.other`/format-name.', 'format-name', 17)
      .symbol(4, 'scip-clojure deps.edn fixture . `demo.shared`/normalize.', 'normalize', 17)
      .symbol(5, 'scip-clojure deps.edn fixture . `demo.core`/greet.', 'greet', 17)
      .symbol(6, 'scip-clojure deps.edn fixture . `demo.consumer`/run.', 'run', 17)
      .definition(2, 2, 2, 1, 0, 1, 30)
      .definition(3, 3, 3, 1, 0, 1, 30)
      .definition(4, 4, 4, 1, 0, 1, 28)
      .definition(5, 1, 5, 4, 0, 5, 38)
      .definition(6, 5, 6, 3, 0, 4, 19)
      .write();

    const db = new ScipDatabase({
      projectRoot,
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
    });
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function withClojureParityFixture(run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-clojure-parity-'));
  try {
    const projectRoot = join(tempDir, 'project');
    const dbPath = join(tempDir, 'index.db');
    writeFixtureFiles(projectRoot, {
      'src/demo/protocols.clj': [
        '(ns demo.protocols)',
        '',
        '(defprotocol GreetingProtocol',
        '  (greet [this name])',
        '  (reset-state [this]))',
        '',
      ].join('\n'),
      'src/demo/records.clj': [
        '(ns demo.records',
        '  (:require [demo.protocols :as p]))',
        '',
        '(defrecord ConsoleGreeter [prefix]',
        '  p/GreetingProtocol',
        '  (greet [this name]',
        '    (str prefix name))',
        '  (reset-state [this]',
        '    nil))',
        '',
      ].join('\n'),
      'src/demo/macros.clj': [
        '(ns demo.macros)',
        '',
        '(defmacro with-log [body]',
        '  `(do ~body))',
        '',
        '(defn left [x]',
        '  x)',
        '',
        '(defn right [x]',
        '  x)',
        '',
        '(defn alpha [x]',
        '  (defc (left x))',
        '  (with-log',
        '    (left x)))',
        '',
        '(defn beta [x]',
        '  (defc (right x))',
        '  (with-log',
        '    (right x)))',
        '',
      ].join('\n'),
      '.clj-kondo/hooks/hsx.clj': ['(ns hooks.hsx)', '', '(defn defc [{:keys [:node]}]', '  {:node node})', ''].join(
        '\n',
      ),
      'src/demo/consumer.clj': [
        '(ns demo.consumer',
        '  (:require [demo.macros :as m]))',
        '',
        '(defn run []',
        '  (m/alpha 1))',
        '',
      ].join('\n'),
    });

    evidenceFixtureDb(dbPath)
      .document(1, 'clojure', 'src/demo/protocols.clj')
      .document(2, 'clojure', 'src/demo/records.clj')
      .document(3, 'clojure', 'src/demo/macros.clj')
      .document(4, 'clojure', 'src/demo/consumer.clj')
      .document(5, 'clojure', '.clj-kondo/hooks/hsx.clj')
      .symbol(1, 'scip-clojure deps.edn fixture . `demo.protocols`/GreetingProtocol#', 'GreetingProtocol', 5)
      .symbol(2, 'scip-clojure deps.edn fixture . `demo.records`/ConsoleGreeter#', 'ConsoleGreeter', 5)
      .symbol(3, 'scip-clojure deps.edn fixture . `demo.macros`/with-log.', 'with-log', 17)
      .symbol(4, 'scip-clojure deps.edn fixture . `demo.macros`/left.', 'left', 17)
      .symbol(5, 'scip-clojure deps.edn fixture . `demo.macros`/right.', 'right', 17)
      .symbol(6, 'scip-clojure deps.edn fixture . `demo.macros`/alpha.', 'alpha', 17)
      .symbol(7, 'scip-clojure deps.edn fixture . `demo.macros`/beta.', 'beta', 17)
      .symbol(8, 'scip-clojure deps.edn fixture . `demo.consumer`/run.', 'run', 17)
      .symbol(9, 'scip-clojure deps.edn fixture . `hooks.hsx`/defc.', 'defc', 17)
      .definition(1, 1, 1, 2, 0, 4, 24)
      .definition(2, 2, 2, 3, 0, 8, 10)
      .definition(3, 3, 3, 2, 0, 3, 12)
      .definition(4, 3, 4, 5, 0, 6, 4)
      .definition(5, 3, 5, 8, 0, 9, 4)
      .definition(6, 3, 6, 11, 0, 14, 14)
      .definition(7, 3, 7, 16, 0, 19, 15)
      .definition(8, 4, 8, 3, 0, 4, 13)
      .definition(9, 5, 9, 2, 0, 3, 14)
      .write();

    const db = new ScipDatabase({
      projectRoot,
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
    });
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
