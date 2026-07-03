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
      expect(() => scaffoldTlaModel(db, 'src/pure.ts')).toThrow(/no mutable state discovered/);
    } finally {
      db.close();
    }
  });

  // P5.7 / followup #16: class instance fields are the state ownership
  // shape for concurrency-flavored systems (locks, connection pools) that
  // scaffold previously rejected outright — no top-level module state, only
  // `this.field` mutated inside class methods.
  it('falls back to class instance-field discovery when no top-level module state exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-scaffold-'));
    writeFixtureFiles(root, {
      'src/store.ts': [
        'export class Store {',
        "  state: 'idle' | 'busy' = 'idle';",
        '',
        '  acquire() {',
        "    this.state = 'busy';",
        '  }',
        '',
        '  release() {',
        "    this.state = 'idle';",
        '  }',
        '',
        '  current(): string {',
        '    return this.state;',
        '  }',
        '}',
      ],
    });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/store.ts')
      .symbol(1, 'scip-typescript npm test 1.0.0 src/`store.ts`/Store#state.', 'state', SymbolInformation_Kind.Field)
      .symbol(
        2,
        'scip-typescript npm test 1.0.0 src/`store.ts`/Store#acquire().',
        'acquire',
        SymbolInformation_Kind.Method,
      )
      .symbol(
        3,
        'scip-typescript npm test 1.0.0 src/`store.ts`/Store#release().',
        'release',
        SymbolInformation_Kind.Method,
      )
      .symbol(
        4,
        'scip-typescript npm test 1.0.0 src/`store.ts`/Store#current().',
        'current',
        SymbolInformation_Kind.Method,
      )
      .definition(1, 1, 1, 1, 2, 1, 35)
      .definition(2, 1, 2, 3, 0, 5, 3)
      .definition(3, 1, 3, 7, 0, 9, 3)
      .definition(4, 1, 4, 11, 0, 13, 3)
      .chunk(1, 1, 0, 14)
      .write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const result = scaffoldTlaModel(db, 'src/store.ts');

      expect(result.variables.map((variable) => variable.name)).toEqual(['state']);
      const state = result.variables.find((variable) => variable.name === 'state')!;
      expect(state.codeRef).toBe('src/store.ts/Store#state');
      expect(state.domainTla).toBe('{"idle", "busy"}');

      const actionNames = result.actions.map((action) => action.name).sort();
      expect(actionNames).toEqual(['Acquire', 'Release']);
      const acquire = result.actions.find((action) => action.name === 'Acquire')!;
      expect(acquire.codeRef).toBe('src/store.ts/Store#acquire');
      expect(acquire.writes).toEqual(['state']);
      // current() only reads state: not an action, mirroring the top-level rule.
      expect(result.actions.some((action) => action.leaf === 'current')).toBe(false);

      expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining('state scoped to class Store')]));

      const map = JSON.parse(result.map) as Record<string, unknown>;
      const variables = map['variables'] as Record<string, { code: string[] }>;
      expect(variables['state']!.code).toEqual(['src/store.ts/Store#state']);
    } finally {
      db.close();
    }
  });

  // catalog-members K2: the realistic SCIP shape (verified live on
  // src/runtime/watch.ts's Watcher) is methods indexed as PRIMARY rows
  // (defn_enclosing_ranges) but fields indexed only as a fallback mention
  // (role=1, no defn_enclosing_ranges row of their own) — unlike the fixture
  // above, which gave the field its own primary row directly. Before K1/K2,
  // getDefinitionsForFile dropped the field's fallback row outright because
  // the file already had primary rows (the methods), so this shape threw
  // "no mutable state discovered". With includeClassMemberFallbacks: true,
  // the field survives and discovery succeeds.
  it('discovers instance fields that are indexed only as fallback mentions (real Watcher-class shape)', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-scaffold-'));
    writeFixtureFiles(root, {
      'src/lock.ts': [
        'export class Lock {',
        '  locked = false;',
        '',
        '  acquire() {',
        '    this.locked = true;',
        '  }',
        '',
        '  release() {',
        '    this.locked = false;',
        '  }',
        '}',
      ],
    });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/lock.ts')
      .symbol(1, 'scip-typescript npm test 1.0.0 src/`lock.ts`/Lock#locked.', 'locked', SymbolInformation_Kind.Field)
      .symbol(
        2,
        'scip-typescript npm test 1.0.0 src/`lock.ts`/Lock#acquire().',
        'acquire',
        SymbolInformation_Kind.Method,
      )
      .symbol(
        3,
        'scip-typescript npm test 1.0.0 src/`lock.ts`/Lock#release().',
        'release',
        SymbolInformation_Kind.Method,
      )
      // Methods: primary rows (as any real indexed class produces).
      .definition(1, 1, 2, 3, 0, 5, 3)
      .definition(2, 1, 3, 7, 0, 9, 3)
      // Field: NO defn_enclosing_ranges row — only a fallback mention, the
      // same shape a typical un-corrected class field gets from the indexer.
      .chunk(1, 1, 1, 1)
      .mention(1, 1, 1)
      .write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const result = scaffoldTlaModel(db, 'src/lock.ts');

      expect(result.variables.map((variable) => variable.name)).toEqual(['locked']);
      expect(result.variables[0]!.codeRef).toBe('src/lock.ts/Lock#locked');
      const actionNames = result.actions.map((action) => action.name).sort();
      expect(actionNames).toEqual(['Acquire', 'Release']);
    } finally {
      db.close();
    }
  });

  it('does not conflate same-named fields on unrelated classes when picking scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-scaffold-'));
    writeFixtureFiles(root, {
      'src/two-classes.ts': [
        'export class Idle {',
        '  state = 0;',
        '',
        '  noop() {',
        '    return this.state;',
        '  }',
        '}',
        '',
        'export class Active {',
        '  state = 0;',
        '',
        '  bump() {',
        '    this.state = this.state + 1;',
        '  }',
        '}',
      ],
    });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/two-classes.ts')
      .symbol(
        1,
        'scip-typescript npm test 1.0.0 src/`two-classes.ts`/Idle#state.',
        'state',
        SymbolInformation_Kind.Field,
      )
      .symbol(
        2,
        'scip-typescript npm test 1.0.0 src/`two-classes.ts`/Idle#noop().',
        'noop',
        SymbolInformation_Kind.Method,
      )
      .symbol(
        3,
        'scip-typescript npm test 1.0.0 src/`two-classes.ts`/Active#state.',
        'state',
        SymbolInformation_Kind.Field,
      )
      .symbol(
        4,
        'scip-typescript npm test 1.0.0 src/`two-classes.ts`/Active#bump().',
        'bump',
        SymbolInformation_Kind.Method,
      )
      .definition(1, 1, 1, 1, 2, 1, 12)
      .definition(2, 1, 2, 3, 0, 5, 3)
      .definition(3, 1, 3, 9, 2, 9, 12)
      .definition(4, 1, 4, 11, 0, 13, 3)
      .chunk(1, 1, 0, 14)
      .write();
    const db = new ScipDatabase({ projectRoot: root, dbPath, indexPath: join(root, 'index.scip') });
    try {
      const result = scaffoldTlaModel(db, 'src/two-classes.ts');

      // Only Active#state is ever written by one of Active's own methods —
      // Idle's same-named field is never mutated by Idle's own methods, so
      // Idle must not be picked (and its field must not leak into Active's
      // action write set via the leaf-name-only alias match).
      expect(result.variables.map((variable) => variable.codeRef)).toEqual(['src/two-classes.ts/Active#state']);
      expect(result.actions.map((action) => action.codeRef)).toEqual(['src/two-classes.ts/Active#bump']);
    } finally {
      db.close();
    }
  });
});
