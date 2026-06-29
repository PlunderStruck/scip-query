import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import { dead } from '../../src/queries/cleanup/dead.js';
import { symbols } from '../../src/queries/navigation/symbols.js';
import { getCrossLanguageDispatchNames, getRustAttrReferencedNames, getSourceFacts } from '../../src/source/ast.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('source facts', () => {
  it('extracts Clojure callable and callsite facts for clj cljs and cljc files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-source-facts-clojure-'));
    try {
      const projectRoot = join(tempDir, 'project');
      const dbPath = join(tempDir, 'index.db');
      writeFixtureFiles(projectRoot, {
        'src/core.clj': ['(ns demo.core)', '(defn greet [name]', '  (helper name))'].join('\n'),
        'src/view.cljs': ['(ns demo.view)', '(defn render-view [state]', '  (greet state))'].join('\n'),
        'src/shared.cljc': ['(ns demo.shared)', '(defn normalize [value]', '  (str value))'].join('\n'),
      });
      evidenceFixtureDb(dbPath)
        .document(1, 'clojure', 'src/core.clj')
        .document(2, 'clojure', 'src/view.cljs')
        .document(3, 'clojure', 'src/shared.cljc')
        .write();

      const db = new ScipDatabase({
        projectRoot,
        dbPath,
        indexPath: join(tempDir, 'index.scip'),
      });
      try {
        expect(getSourceFacts(db, 'src/core.clj')?.callables.map((callable) => callable.name)).toEqual(['greet']);
        expect(getSourceFacts(db, 'src/core.clj')?.callSites.map((callSite) => callSite.calleeLeaf)).toEqual([
          'helper',
        ]);
        expect(getSourceFacts(db, 'src/view.cljs')?.callables.map((callable) => callable.name)).toEqual([
          'render-view',
        ]);
        expect(getSourceFacts(db, 'src/shared.cljc')?.callables.map((callable) => callable.name)).toEqual([
          'normalize',
        ]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts Rust attribute helper references as source facts', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-source-facts-rust-'));
    try {
      const projectRoot = join(tempDir, 'project');
      const dbPath = join(tempDir, 'index.db');
      writeFixtureFiles(projectRoot, {
        'src/config.rs': [
          '#[derive(Serialize)]',
          'struct Config {',
          '    #[serde(default = "crate::defaults::default_port", skip_serializing_if = "Option::is_none")]',
          '    port: Option<u16>,',
          '    #[schemars(schema_with = "crate::schema::port_schema")]',
          '    schema_port: u16,',
          '}',
        ],
      });
      evidenceFixtureDb(dbPath).document(1, 'rust', 'src/config.rs').write();

      const db = new ScipDatabase({
        projectRoot,
        dbPath,
        indexPath: join(tempDir, 'index.scip'),
      });
      try {
        expect([...getRustAttrReferencedNames(db, 'src/config.rs')].sort()).toEqual(['default_port', 'port_schema']);
      } finally {
        db.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts cross-language dispatch names as source facts', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-source-facts-dispatch-'));
    try {
      const projectRoot = join(tempDir, 'project');
      const dbPath = join(tempDir, 'index.db');
      writeFixtureFiles(projectRoot, {
        'src/commands.ts': [
          "import { invoke } from '@tauri-apps/api/core';",
          "export function start() { return invoke('start_job'); }",
          "export function stop() { return window.__TAURI__.invoke('stop_job'); }",
        ],
      });
      evidenceFixtureDb(dbPath).document(1, 'typescript', 'src/commands.ts').write();

      const db = new ScipDatabase({
        projectRoot,
        dbPath,
        indexPath: join(tempDir, 'index.scip'),
      });
      try {
        expect([...getCrossLanguageDispatchNames(db, 'src/commands.ts')].sort()).toEqual(['start_job', 'stop_job']);
      } finally {
        db.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps Rust attribute helper references out of dead-code results', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-source-facts-rust-dead-'));
    try {
      const projectRoot = join(tempDir, 'project');
      const dbPath = join(tempDir, 'index.db');
      writeFixtureFiles(projectRoot, {
        'src/defaults.rs': ['pub fn default_port() -> u16 {', '    8080', '}'],
        'src/config.rs': [
          'struct Config {',
          '    #[serde(default = "crate::defaults::default_port")]',
          '    port: u16,',
          '}',
        ],
      });
      evidenceFixtureDb(dbPath)
        .document(1, 'rust', 'src/defaults.rs')
        .document(2, 'rust', 'src/config.rs')
        .symbol(1, 'scip-rust cargo fixture 0.1.0 src/defaults.rs/default_port().', 'default_port', 12)
        .definition(1, 1, 1, 0, 0, 2, 1)
        .chunk(1, 1, 0, 2)
        .chunk(2, 2, 0, 3)
        .mention(1, 1, 1)
        .write();

      const db = new ScipDatabase({
        projectRoot,
        dbPath,
        indexPath: join(tempDir, 'index.scip'),
      });
      try {
        const targetSymbol = 'scip-rust cargo fixture 0.1.0 src/defaults.rs/default_port().';
        expect(symbols(db, 'default_port').map((row) => row.symbol)).toContain(targetSymbol);
        expect(dead(db, { deadCodeOnly: true }).symbols.map((row) => row.symbol)).not.toContain(targetSymbol);
      } finally {
        db.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps cross-language dispatch targets out of dead-code results', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-source-facts-dispatch-dead-'));
    try {
      const projectRoot = join(tempDir, 'project');
      const dbPath = join(tempDir, 'index.db');
      writeFixtureFiles(projectRoot, {
        'src/commands.rs': ['pub fn start_job() {', '}'],
        'src/client.ts': [
          "import { invoke } from '@tauri-apps/api/core';",
          "export function start() { return invoke('start_job'); }",
        ],
      });
      evidenceFixtureDb(dbPath)
        .document(1, 'rust', 'src/commands.rs')
        .document(2, 'typescript', 'src/client.ts')
        .symbol(1, 'scip-rust cargo fixture 0.1.0 src/commands.rs/start_job().', 'start_job', 12)
        .definition(1, 1, 1, 0, 0, 1, 1)
        .chunk(1, 1, 0, 1)
        .chunk(2, 2, 0, 1)
        .mention(1, 1, 1)
        .write();

      const db = new ScipDatabase({
        projectRoot,
        dbPath,
        indexPath: join(tempDir, 'index.scip'),
      });
      try {
        const targetSymbol = 'scip-rust cargo fixture 0.1.0 src/commands.rs/start_job().';
        expect(symbols(db, 'start_job').map((row) => row.symbol)).toContain(targetSymbol);
        expect(dead(db, { deadCodeOnly: true }).symbols.map((row) => row.symbol)).not.toContain(targetSymbol);
      } finally {
        db.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
