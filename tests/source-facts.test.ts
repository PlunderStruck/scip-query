import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ScipDatabase } from '../src/storage/db.js';
import { getCrossLanguageDispatchNames, getRustAttrReferencedNames } from '../src/source/ast.js';
import { evidenceFixtureDb, writeFixtureFiles } from './evidence-fixture.js';

describe('source facts', () => {
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
      evidenceFixtureDb(dbPath)
        .document(1, 'rust', 'src/config.rs')
        .write();

      const db = new ScipDatabase({
        projectRoot,
        dbPath,
        indexPath: join(tempDir, 'index.scip'),
      });
      try {
        expect([...getRustAttrReferencedNames(db, 'src/config.rs')].sort()).toEqual([
          'default_port',
          'port_schema',
        ]);
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
      evidenceFixtureDb(dbPath)
        .document(1, 'typescript', 'src/commands.ts')
        .write();

      const db = new ScipDatabase({
        projectRoot,
        dbPath,
        indexPath: join(tempDir, 'index.scip'),
      });
      try {
        expect([...getCrossLanguageDispatchNames(db, 'src/commands.ts')].sort()).toEqual([
          'start_job',
          'stop_job',
        ]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
