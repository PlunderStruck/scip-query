import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymbolInformation_Kind } from '@c4312/scip';
import { describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import type { ScipQueryConfig } from '../../src/domain/types.js';
import { scaffoldTlaModel } from '../../src/tla/scaffold.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

function machineFixture(root: string): ScipDatabase {
  writeFixtureFiles(root, {
    'src/machine.ts': [
      "export let status: 'idle' | 'busy' = 'idle';",
      'export const history: string[] = [];',
      '',
      'export function start() {',
      "  status = 'busy';",
      "  history.push('start');",
      '}',
      '',
      'export function finish() {',
      "  if (status === 'busy') {",
      "    status = 'idle';",
      '  }',
      '}',
      '',
      'export function current(): string {',
      '  return status;',
      '}',
    ],
  });
  const dbPath = join(root, 'index.db');
  evidenceFixtureDb(dbPath)
    .document(1, 'typescript', 'src/machine.ts')
    .symbol(1, 'scip-typescript npm test 1.0.0 src/`machine.ts`/status.', 'status', SymbolInformation_Kind.Variable)
    .symbol(2, 'scip-typescript npm test 1.0.0 src/`machine.ts`/history.', 'history', SymbolInformation_Kind.Constant)
    .symbol(3, 'scip-typescript npm test 1.0.0 src/`machine.ts`/start().', 'start', SymbolInformation_Kind.Function)
    .symbol(4, 'scip-typescript npm test 1.0.0 src/`machine.ts`/finish().', 'finish', SymbolInformation_Kind.Function)
    .symbol(5, 'scip-typescript npm test 1.0.0 src/`machine.ts`/current().', 'current', SymbolInformation_Kind.Function)
    .definition(1, 1, 1, 0, 11, 0, 17)
    .definition(2, 1, 2, 1, 13, 1, 20)
    .definition(3, 1, 3, 3, 0, 6, 1)
    .definition(4, 1, 4, 8, 0, 12, 1)
    .definition(5, 1, 5, 14, 0, 16, 1)
    .chunk(1, 1, 0, 16)
    .write();
  const config: ScipQueryConfig = {
    projectRoot: root,
    dbPath,
    indexPath: join(root, 'index.scip'),
  };
  return new ScipDatabase(config);
}

describe('tla scaffold', () => {
  it('derives state, domains, and actions from the static scan', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-scaffold-'));
    const db = machineFixture(root);
    try {
      const result = scaffoldTlaModel(db, 'src/machine.ts');

      expect(result.moduleName).toBe('Machine');
      expect(result.variables.map((variable) => variable.name).sort()).toEqual(['history', 'status']);

      const status = result.variables.find((variable) => variable.name === 'status')!;
      expect(status.domainTla).toBe('{"idle", "busy"}');
      expect(status.domainBasis).toBe('union-literal');
      expect(status.initTla).toBe('"idle"');

      const history = result.variables.find((variable) => variable.name === 'history')!;
      expect(history.domainBasis).toBe('sequence');
      expect(history.initTla).toBe('<<>>');

      const actionNames = result.actions.map((action) => action.name).sort();
      expect(actionNames).toEqual(['Finish', 'Start']);
      const start = result.actions.find((action) => action.name === 'Start')!;
      expect(start.writes).toEqual(['history', 'status']);
      const finish = result.actions.find((action) => action.name === 'Finish')!;
      expect(finish.writes).toEqual(['status']);
      expect(finish.reads).toContain('status');

      // current() reads state but writes nothing: not an action.
      expect(result.actions.some((action) => action.leaf === 'current')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('emits a checkable spec, cfg, and a mapping with derived provenance', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-scaffold-'));
    const db = machineFixture(root);
    try {
      const result = scaffoldTlaModel(db, 'src/machine.ts');

      expect(result.spec).toContain('---- MODULE Machine ----');
      expect(result.spec).toContain('VARIABLES status, history');
      expect(result.spec).toContain('statusDomain == {"idle", "busy"}');
      expect(result.spec).toContain('/\\ status = "idle"');
      expect(result.spec).toContain('Spec == Init /\\ [][Next]_vars');
      // Finish writes only status: history must be UNCHANGED there.
      expect(result.spec).toMatch(/Finish ==[\s\S]*?UNCHANGED <<history>>/);

      expect(result.cfg).toContain('SPECIFICATION Spec');
      expect(result.cfg).toContain('INVARIANT TypeOK');

      const map = JSON.parse(result.map) as Record<string, unknown>;
      expect((map['derived'] as Record<string, unknown>)['generatedBy']).toBe('scip-query tla scaffold');
      const variables = map['variables'] as Record<string, { code: string[] }>;
      expect(variables['status']!.code).toEqual(['src/machine.ts/status']);
      const actions = map['actions'] as Record<string, { writes: string[] }>;
      expect(actions['Start']!.writes).toEqual(['history', 'status']);
    } finally {
      db.close();
    }
  });

  it('refuses files with no discoverable mutable state', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-scaffold-'));
    writeFixtureFiles(root, {
      'src/pure.ts': ['export function add(a: number, b: number): number {', '  return a + b;', '}'],
    });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/pure.ts')
      .symbol(1, 'scip-typescript npm test 1.0.0 src/`pure.ts`/add().', 'add', SymbolInformation_Kind.Function)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .chunk(1, 1, 0, 2)
      .write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      expect(() => scaffoldTlaModel(db, 'src/pure.ts')).toThrow(/no mutable module state discovered/);
    } finally {
      db.close();
    }
  });
});
