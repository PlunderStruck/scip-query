import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymbolInformation_Kind } from '@c4312/scip';
import { describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import type { ScipQueryConfig } from '../../src/domain/types.js';
import {
  readTlaModuleFacts,
  readTlaModuleFactsFromSanyXml,
  type TlaModelContract,
} from '../../src/tla/model-contract.js';
import { tlaFindingGroups, verifyTlaConformance, type TlaConformanceFinding } from '../../src/tla/conformance.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

function fixtureDb(root: string): ScipDatabase {
  const dbPath = join(root, 'index.db');
  evidenceFixtureDb(dbPath)
    .document(1, 'typescript', 'src/queue.ts')
    .symbol(1, 'scip-typescript npm test 1.0.0 src/`queue.ts`/queue.', 'queue', SymbolInformation_Kind.Constant)
    .symbol(2, 'scip-typescript npm test 1.0.0 src/`queue.ts`/enqueue().', 'enqueue', SymbolInformation_Kind.Function)
    .symbol(3, 'scip-typescript npm test 1.0.0 src/`queue.ts`/cancel().', 'cancel', SymbolInformation_Kind.Function)
    .symbol(4, 'scip-typescript npm test 1.0.0 src/`queue.ts`/peek().', 'peek', SymbolInformation_Kind.Function)
    .symbol(5, 'scip-typescript npm test 1.0.0 src/`queue.ts`/noop().', 'noop', SymbolInformation_Kind.Function)
    .symbol(6, 'scip-typescript npm test 1.0.0 src/`queue.ts`/State#', 'State', SymbolInformation_Kind.Interface)
    .definition(1, 1, 1, 0, 0, 0, 28)
    .definition(2, 1, 2, 2, 0, 4, 1)
    .definition(3, 1, 3, 6, 0, 8, 1)
    .definition(4, 1, 4, 2, 0, 4, 1)
    .definition(5, 1, 5, 2, 0, 4, 1)
    .definition(6, 1, 6, 0, 0, 0, 20)
    .chunk(1, 1, 0, 8)
    .write();
  const config: ScipQueryConfig = {
    projectRoot: root,
    dbPath,
    indexPath: join(root, 'index.scip'),
  };
  return new ScipDatabase(config);
}

describe('TLA conformance', () => {
  it('flags writes to modeled variables outside mapped actions', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    writeFixtureFiles(root, {
      'src/queue.ts': [
        'export const queue: string[] = [];',
        '',
        'export function enqueue(job: string) {',
        '  queue.push(job);',
        '}',
        '',
        'export function cancel(job: string) {',
        '  queue.splice(queue.indexOf(job), 1);',
        '}',
      ],
    });
    writeFileSync(
      join(root, 'Queue.tla'),
      `---- MODULE Queue ----
VARIABLES queue
Init == queue = <<>>
Enqueue(job) == queue' = Append(queue, job)
====
`,
    );
    const db = fixtureDb(root);
    const contract: TlaModelContract = {
      module: 'Queue.tla',
      scope: ['src/queue.ts'],
      variables: {
        queue: { code: ['queue'], aliases: ['queue'] },
      },
      actions: {
        Enqueue: { code: ['enqueue'], reads: [], writes: ['queue'], calls: [] },
      },
      invariants: [],
      traces: [],
    };

    try {
      const result = verifyTlaConformance(db, contract, readTlaModuleFacts(root, 'Queue.tla'));

      expect(result.staticWrites).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            variable: 'queue',
            enclosingShort: expect.stringContaining('cancel'),
          }),
        ]),
      );
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'unmapped-write',
            severity: 'error',
            modelElement: 'queue',
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('only runs the unmapped write sweep when scope is explicit', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    writeFixtureFiles(root, {
      'src/queue.ts': [
        'export const queue: string[] = [];',
        '',
        'export function enqueue(job: string) {',
        '  queue.push(job);',
        '}',
        '',
        'export function cancel(job: string) {',
        '  queue.splice(queue.indexOf(job), 1);',
        '}',
      ],
    });
    writeFileSync(
      join(root, 'Queue.tla'),
      `---- MODULE Queue ----
VARIABLES queue
Enqueue(job) == queue' = Append(queue, job)
====
`,
    );
    const db = fixtureDb(root);
    const contract: TlaModelContract = {
      module: 'Queue.tla',
      variables: {
        queue: { code: ['queue'], aliases: ['queue'] },
      },
      actions: {
        Enqueue: { code: ['enqueue'], reads: ['queue'], writes: ['queue'], calls: [] },
      },
      invariants: [],
      traces: [],
    };

    try {
      const result = verifyTlaConformance(db, contract, readTlaModuleFacts(root, 'Queue.tla'));

      expect(result.findings).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'unmapped-write',
            modelElement: 'queue',
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('unmappedWriteScope: "actions" opts out of the whole-scope-file sweep (P5.7 / followup #19)', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    writeFixtureFiles(root, {
      'src/queue.ts': [
        'export const queue: string[] = [];',
        '',
        'export function enqueue(job: string) {',
        '  queue.push(job);',
        '}',
        '',
        'export function cancel(job: string) {',
        '  queue.splice(queue.indexOf(job), 1);',
        '}',
      ],
    });
    writeFileSync(
      join(root, 'Queue.tla'),
      `---- MODULE Queue ----
VARIABLES queue
Init == queue = <<>>
Enqueue(job) == queue' = Append(queue, job)
====
`,
    );
    const db = fixtureDb(root);
    const baseContract: TlaModelContract = {
      module: 'Queue.tla',
      scope: ['src/queue.ts'],
      variables: {
        queue: { code: ['queue'], aliases: ['queue'] },
      },
      actions: {
        Enqueue: { code: ['enqueue'], reads: [], writes: ['queue'], calls: [] },
      },
      invariants: [],
      traces: [],
      unmappedWriteScope: 'scope-files',
    };

    try {
      const moduleFacts = readTlaModuleFacts(root, 'Queue.tla');

      // Default ('scope-files'): cancel()'s write is outside the mapped
      // Enqueue action and this repo's own scope covers the whole file —
      // still flagged, matching pre-P5.7 behavior exactly.
      const defaultResult = verifyTlaConformance(db, baseContract, moduleFacts);
      expect(defaultResult.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ category: 'unmapped-write', modelElement: 'queue' })]),
      );

      // Opt-in narrower sweep: the SAME cancel() write is no longer flagged
      // — only Enqueue's own declared/observed facts are checked.
      const actionsScopedResult = verifyTlaConformance(
        db,
        { ...baseContract, unmappedWriteScope: 'actions' },
        moduleFacts,
      );
      expect(actionsScopedResult.findings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ category: 'unmapped-write' })]),
      );
    } finally {
      db.close();
    }
  });

  it('flags trace steps that mutate variables outside the action write set', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    writeFixtureFiles(root, {
      'src/queue.ts': ['export const queue: string[] = [];', 'export function peek() {', '  return queue[0];', '}'],
    });
    writeFileSync(
      join(root, 'Queue.tla'),
      `---- MODULE Queue ----
VARIABLES queue
Peek == UNCHANGED queue
====
`,
    );
    const db = fixtureDb(root);
    const contract: TlaModelContract = {
      scope: ['src/queue.ts'],
      variables: {
        queue: { code: ['queue'], aliases: ['queue'] },
      },
      actions: {
        Peek: {
          code: ['enqueue'],
          reads: ['queue'],
          writes: [],
          calls: [],
          waive: { reads: ['queue'], writes: [], reason: 'trace fixture exercises trace handling only' },
        },
      },
      invariants: [],
      traces: [],
    };

    try {
      const result = verifyTlaConformance(db, contract, readTlaModuleFacts(root, 'Queue.tla'), [
        { action: 'Peek', before: { queue: [] }, after: { queue: ['x'] } },
      ]);

      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'trace',
            evidence: 'trace',
            message: expect.stringContaining('changed queue'),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('flags undeclared reads of modeled variables inside mapped actions', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    writeFixtureFiles(root, {
      'src/queue.ts': ['export const queue: string[] = [];', 'export function peek() {', '  return queue[0];', '}'],
    });
    writeFileSync(
      join(root, 'Queue.tla'),
      `---- MODULE Queue ----
VARIABLES queue
Peek == UNCHANGED queue
====
`,
    );
    const db = fixtureDb(root);
    const contract: TlaModelContract = {
      scope: ['src/queue.ts'],
      variables: {
        queue: { code: ['queue'], aliases: ['queue'] },
      },
      actions: {
        Peek: { code: ['peek'], reads: [], writes: [], calls: [] },
      },
      invariants: [],
      traces: [],
    };

    try {
      const result = verifyTlaConformance(db, contract, readTlaModuleFacts(root, 'Queue.tla'));

      expect(result.staticReads).toEqual(
        expect.arrayContaining([expect.objectContaining({ variable: 'queue', target: 'queue' })]),
      );
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'undeclared-read',
            severity: 'warning',
            modelElement: 'Peek',
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('flags SANY model writes that the mapping omits', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    writeFixtureFiles(root, {
      'src/queue.ts': [
        'export const queue: string[] = [];',
        'export function enqueue(job: string) {',
        '  return job;',
        '}',
      ],
    });
    writeFileSync(
      join(root, 'Queue.tla'),
      `---- MODULE Queue ----
VARIABLES queue
Enqueue(job) == queue' = Append(queue, job)
====
`,
    );
    const db = fixtureDb(root);
    const contract: TlaModelContract = {
      scope: ['src/queue.ts'],
      variables: {
        queue: { code: ['queue'], aliases: ['queue'] },
      },
      actions: {
        Enqueue: { code: ['enqueue'], reads: [], writes: [], calls: [] },
      },
      invariants: [],
      traces: [],
    };
    const moduleFacts = readTlaModuleFactsFromSanyXml(
      root,
      'Queue.tla',
      `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<modules><context>
  <entry><UID>10</UID><BuiltInKind><uniquename>'</uniquename></BuiltInKind></entry>
  <entry><UID>20</UID><OpDeclNode><uniquename>queue</uniquename><kind>3</kind></OpDeclNode></entry>
  <entry><UID>30</UID><UserDefinedOpKind><uniquename>Enqueue</uniquename><body>
    <OpApplNode><BuiltInKindRef><UID>10</UID></BuiltInKindRef>
      <OpDeclNodeRef><UID>20</UID></OpDeclNodeRef></OpApplNode>
  </body></UserDefinedOpKind></entry>
</context></modules>`,
    );

    try {
      const result = verifyTlaConformance(db, contract, moduleFacts);

      expect(result.modelParse).toBe('sany');
      expect(result.modelActionFacts).toEqual([{ name: 'Enqueue', reads: [], writes: ['queue'] }]);
      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'model-mapping-write',
            evidence: 'model-text',
            severity: 'error',
            message: expect.stringContaining('mapping does not declare that write'),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('flags code writes that the SANY model action does not prime', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    writeFixtureFiles(root, {
      'src/queue.ts': [
        'export const queue: string[] = [];',
        'export function enqueue(job: string) {',
        '  queue.push(job);',
        '}',
      ],
    });
    writeFileSync(
      join(root, 'Queue.tla'),
      `---- MODULE Queue ----
VARIABLES queue
Enqueue(job) == UNCHANGED queue
====
`,
    );
    const db = fixtureDb(root);
    const contract: TlaModelContract = {
      scope: ['src/queue.ts'],
      variables: {
        queue: { code: ['queue'], aliases: ['queue'] },
      },
      actions: {
        Enqueue: { code: ['enqueue'], reads: [], writes: ['queue'], calls: [] },
      },
      invariants: [],
      traces: [],
    };
    const moduleFacts = readTlaModuleFactsFromSanyXml(
      root,
      'Queue.tla',
      `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<modules><context>
  <entry><UID>11</UID><BuiltInKind><uniquename>UNCHANGED</uniquename></BuiltInKind></entry>
  <entry><UID>20</UID><OpDeclNode><uniquename>queue</uniquename><kind>3</kind></OpDeclNode></entry>
  <entry><UID>30</UID><UserDefinedOpKind><uniquename>Enqueue</uniquename><body>
    <OpApplNode><BuiltInKindRef><UID>11</UID></BuiltInKindRef>
      <OpDeclNodeRef><UID>20</UID></OpDeclNodeRef></OpApplNode>
  </body></UserDefinedOpKind></entry>
</context></modules>`,
    );

    try {
      const result = verifyTlaConformance(db, contract, moduleFacts);

      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'model-code-write',
            evidence: 'static-action',
            severity: 'error',
            message: expect.stringContaining('does not prime it'),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('honors per-fact read waivers and records the waiver', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    writeFixtureFiles(root, {
      'src/queue.ts': ['export const queue: string[] = [];', 'export function noop() {', '  return 1;', '}'],
    });
    writeFileSync(
      join(root, 'Queue.tla'),
      `---- MODULE Queue ----
VARIABLES queue
Noop == UNCHANGED queue
====
`,
    );
    const db = fixtureDb(root);
    const contract: TlaModelContract = {
      scope: ['src/queue.ts'],
      variables: {
        queue: { code: ['queue'], aliases: ['queue'] },
      },
      actions: {
        Noop: {
          code: ['noop'],
          reads: ['queue'],
          writes: [],
          calls: [],
          waive: { reads: ['queue'], writes: [], reason: 'noop receives queue through a higher-order test fixture' },
        },
      },
      invariants: [],
      traces: [],
    };

    try {
      const result = verifyTlaConformance(db, contract, readTlaModuleFacts(root, 'Queue.tla'));

      expect(result.waivers).toContainEqual({
        action: 'Noop',
        kind: 'read',
        variable: 'queue',
        reason: 'noop receives queue through a higher-order test fixture',
        legacy: false,
      });
      expect(result.findings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ category: 'missing-read-evidence' })]),
      );
    } finally {
      db.close();
    }
  });

  it('waives missing-referent on a variable with no stored field', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    writeFixtureFiles(root, {
      'src/queue.ts': ['export const queue: string[] = [];', 'export function noop() {', '  return 1;', '}'],
    });
    writeFileSync(
      join(root, 'Queue.tla'),
      `---- MODULE Queue ----
VARIABLES stage
Noop == UNCHANGED stage
====
`,
    );
    const db = fixtureDb(root);
    const contract: TlaModelContract = {
      scope: ['src/queue.ts'],
      variables: {
        stage: {
          code: ['__no_stored_field__'],
          aliases: ['__stage_unmatchable__'],
          waive: { reason: 'stage is a pure control-flow abstraction with no stored field' },
        },
      },
      actions: {
        Noop: { code: ['noop'], reads: [], writes: [], calls: [] },
      },
      invariants: [],
      traces: [],
    };

    try {
      const result = verifyTlaConformance(db, contract, readTlaModuleFacts(root, 'Queue.tla'));

      expect(result.findings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ category: 'missing-referent', modelElement: 'stage' })]),
      );
      expect(result.waivers).toContainEqual({
        kind: 'referent',
        variable: 'stage',
        reason: 'stage is a pure control-flow abstraction with no stored field',
        legacy: false,
      });
    } finally {
      db.close();
    }
  });

  it('waives invalid-referent-kind on a variable pointed at a type', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    writeFixtureFiles(root, {
      'src/queue.ts': ['export interface State { queue: string[] }', 'export function noop() {', '  return 1;', '}'],
    });
    writeFileSync(
      join(root, 'Queue.tla'),
      `---- MODULE Queue ----
VARIABLES queue
Noop == UNCHANGED queue
====
`,
    );
    const db = fixtureDb(root);
    const contract: TlaModelContract = {
      scope: ['src/queue.ts'],
      variables: {
        queue: {
          code: ['State'],
          aliases: ['__queue_unmatchable__'],
          waive: { reason: 'closest real anchor is a type; no runtime state symbol exists' },
        },
      },
      actions: {
        Noop: { code: ['noop'], reads: [], writes: [], calls: [] },
      },
      invariants: [],
      traces: [],
    };

    try {
      const result = verifyTlaConformance(db, contract, readTlaModuleFacts(root, 'Queue.tla'));

      expect(result.findings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ category: 'invalid-referent-kind' })]),
      );
    } finally {
      db.close();
    }
  });

  it('rejects type-like variable referents', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    writeFixtureFiles(root, {
      'src/queue.ts': ['export interface State { queue: string[] }', 'export function noop() {', '  return 1;', '}'],
    });
    writeFileSync(
      join(root, 'Queue.tla'),
      `---- MODULE Queue ----
VARIABLES queue
Noop == UNCHANGED queue
====
`,
    );
    const db = fixtureDb(root);
    const contract: TlaModelContract = {
      scope: ['src/queue.ts'],
      variables: {
        queue: { code: ['State'], aliases: ['queue'] },
      },
      actions: {
        Noop: { code: ['noop'], reads: [], writes: [], calls: [] },
      },
      invariants: [],
      traces: [],
    };

    try {
      const result = verifyTlaConformance(db, contract, readTlaModuleFacts(root, 'Queue.tla'));

      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'invalid-referent-kind',
            severity: 'error',
            message: expect.stringContaining('referent is a type'),
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('classifies resource-bound fs calls as writes/reads of the mapped variable', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/lock.ts')
      .symbol(1, 'scip-typescript npm test 1.0.0 src/`lock.ts`/pid.', 'pid', SymbolInformation_Kind.Constant)
      .symbol(2, 'scip-typescript npm test 1.0.0 src/`lock.ts`/release().', 'release', SymbolInformation_Kind.Function)
      .symbol(3, 'scip-typescript npm test 1.0.0 src/`lock.ts`/check().', 'check', SymbolInformation_Kind.Function)
      .definition(1, 1, 1, 0, 0, 0, 30)
      .definition(2, 1, 2, 2, 0, 4, 1)
      .definition(3, 1, 3, 6, 0, 8, 1)
      .chunk(1, 1, 0, 8)
      .write();
    const config: ScipQueryConfig = { projectRoot: root, dbPath, indexPath: join(root, 'index.scip') };
    writeFixtureFiles(root, {
      'src/lock.ts': [
        'export const pid: number = 0;',
        '',
        'export function release(lockPath: string) {',
        '  rmSync(lockPath, { force: true });',
        '}',
        '',
        'export function check(lockPath: string) {',
        '  return existsSync(lockPath);',
        '}',
      ],
    });
    writeFileSync(
      join(root, 'Lock.tla'),
      `---- MODULE Lock ----
VARIABLES lockOwner
Release == lockOwner' = "None"
Check == UNCHANGED lockOwner
====
`,
    );
    const db = new ScipDatabase(config);
    const contract: TlaModelContract = {
      module: 'Lock.tla',
      scope: ['src/lock.ts'],
      variables: {
        lockOwner: { code: ['pid'], aliases: ['pid'], resource: { path: 'lockPath' } },
      },
      actions: {
        Release: { code: ['release'], reads: [], writes: ['lockOwner'], calls: [] },
        Check: { code: ['check'], reads: ['lockOwner'], writes: [], calls: [] },
      },
      invariants: [],
      traces: [],
    };

    try {
      const result = verifyTlaConformance(db, contract, readTlaModuleFacts(root, 'Lock.tla'));

      expect(result.staticWrites).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            variable: 'lockOwner',
            kind: 'resource',
            target: expect.stringContaining('rmSync'),
          }),
        ]),
      );
      expect(result.staticReads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            variable: 'lockOwner',
            kind: 'resource',
            target: expect.stringContaining('existsSync'),
          }),
        ]),
      );
      expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('does not misclassify an fs call whose argument does not name the resource path', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/lock.ts')
      .symbol(1, 'scip-typescript npm test 1.0.0 src/`lock.ts`/pid.', 'pid', SymbolInformation_Kind.Constant)
      .symbol(2, 'scip-typescript npm test 1.0.0 src/`lock.ts`/cleanup().', 'cleanup', SymbolInformation_Kind.Function)
      .definition(1, 1, 1, 0, 0, 0, 30)
      .definition(2, 1, 2, 2, 0, 4, 1)
      .chunk(1, 1, 0, 4)
      .write();
    const config: ScipQueryConfig = { projectRoot: root, dbPath, indexPath: join(root, 'index.scip') };
    writeFixtureFiles(root, {
      'src/lock.ts': [
        'export const pid: number = 0;',
        '',
        'export function cleanup(otherPath: string) {',
        '  rmSync(otherPath, { force: true });',
        '}',
      ],
    });
    writeFileSync(
      join(root, 'Lock.tla'),
      `---- MODULE Lock ----
VARIABLES lockOwner
Cleanup == UNCHANGED lockOwner
====
`,
    );
    const db = new ScipDatabase(config);
    const contract: TlaModelContract = {
      module: 'Lock.tla',
      scope: ['src/lock.ts'],
      variables: {
        lockOwner: { code: ['pid'], aliases: ['pid'], resource: { path: 'lockPath' } },
      },
      actions: {
        Cleanup: { code: ['cleanup'], reads: [], writes: [], calls: [] },
      },
      invariants: [],
      traces: [],
    };

    try {
      const result = verifyTlaConformance(db, contract, readTlaModuleFacts(root, 'Lock.tla'));

      expect(result.staticWrites.filter((write) => write.kind === 'resource')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('attributes a one-hop callee write to the calling action, marked via', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/lock.ts')
      .symbol(1, 'scip-typescript npm test 1.0.0 src/`lock.ts`/pid.', 'pid', SymbolInformation_Kind.Constant)
      .symbol(2, 'scip-typescript npm test 1.0.0 src/`lock.ts`/release().', 'release', SymbolInformation_Kind.Function)
      .symbol(3, 'scip-typescript npm test 1.0.0 src/`lock.ts`/cleanup().', 'cleanup', SymbolInformation_Kind.Function)
      .definition(1, 1, 1, 0, 0, 0, 30)
      .definition(2, 1, 2, 2, 0, 4, 1)
      .definition(3, 1, 3, 6, 0, 8, 1)
      .chunk(1, 1, 0, 8)
      .write();
    const config: ScipQueryConfig = { projectRoot: root, dbPath, indexPath: join(root, 'index.scip') };
    writeFixtureFiles(root, {
      'src/lock.ts': [
        'export const pid: number = 0;',
        '',
        'export function release(lockPath: string) {',
        '  cleanup(lockPath);',
        '}',
        '',
        'function cleanup(lockPath: string) {',
        '  rmSync(lockPath, { force: true });',
        '}',
      ],
    });
    writeFileSync(
      join(root, 'Lock.tla'),
      `---- MODULE Lock ----
VARIABLES lockOwner
Release == lockOwner' = "None"
====
`,
    );
    const db = new ScipDatabase(config);
    const contract: TlaModelContract = {
      module: 'Lock.tla',
      scope: ['src/lock.ts'],
      variables: {
        lockOwner: { code: ['pid'], aliases: ['pid'], resource: { path: 'lockPath' } },
      },
      actions: {
        Release: { code: ['release'], reads: [], writes: ['lockOwner'], calls: [] },
      },
      invariants: [],
      traces: [],
    };

    try {
      const result = verifyTlaConformance(db, contract, readTlaModuleFacts(root, 'Lock.tla'));

      // release() itself never touches lockPath — only its callee cleanup()
      // does. Without the one-hop rule this would be a missing-write-evidence
      // warning; with it, the write is found and attributed via cleanup().
      expect(result.staticWrites).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            variable: 'lockOwner',
            kind: 'resource',
            via: expect.stringContaining('cleanup'),
          }),
        ]),
      );
      expect(result.findings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ category: 'missing-write-evidence' })]),
      );
    } finally {
      db.close();
    }
  });

  it('does not attribute a one-hop callee write to an action that does not declare it', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/lock.ts')
      .symbol(1, 'scip-typescript npm test 1.0.0 src/`lock.ts`/pid.', 'pid', SymbolInformation_Kind.Constant)
      .symbol(2, 'scip-typescript npm test 1.0.0 src/`lock.ts`/start().', 'start', SymbolInformation_Kind.Function)
      .symbol(3, 'scip-typescript npm test 1.0.0 src/`lock.ts`/cleanup().', 'cleanup', SymbolInformation_Kind.Function)
      .definition(1, 1, 1, 0, 0, 0, 30)
      .definition(2, 1, 2, 2, 0, 4, 1)
      .definition(3, 1, 3, 6, 0, 8, 1)
      .chunk(1, 1, 0, 8)
      .write();
    const config: ScipQueryConfig = { projectRoot: root, dbPath, indexPath: join(root, 'index.scip') };
    writeFixtureFiles(root, {
      'src/lock.ts': [
        'export const pid: number = 0;',
        '',
        'export function start(lockPath: string) {',
        '  cleanup(lockPath);',
        '}',
        '',
        'function cleanup(lockPath: string) {',
        '  rmSync(lockPath, { force: true });',
        '}',
      ],
    });
    writeFileSync(
      join(root, 'Lock.tla'),
      `---- MODULE Lock ----
VARIABLES lockOwner
Start == UNCHANGED lockOwner
====
`,
    );
    const db = new ScipDatabase(config);
    const contract: TlaModelContract = {
      module: 'Lock.tla',
      // No `scope` — isolates the per-action one-hop attribution behavior
      // under test from the separate unmapped-write sweep (which would
      // otherwise flag cleanup()'s write for being outside any mapped
      // action, a correct but unrelated finding covered elsewhere).
      variables: {
        lockOwner: { code: ['pid'], aliases: ['pid'], resource: { path: 'lockPath' } },
      },
      actions: {
        // Start does NOT declare a lockOwner write, even though its
        // one-hop callee (cleanup) touches the resource — the one-hop rule
        // must only strengthen evidence for a declared fact, never assert
        // an undeclared one for an action sharing a callee.
        Start: { code: ['start'], reads: [], writes: [], calls: [] },
      },
      invariants: [],
      traces: [],
    };

    try {
      const result = verifyTlaConformance(db, contract, readTlaModuleFacts(root, 'Lock.tla'));

      expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
      expect(result.findings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ category: 'undeclared-write' })]),
      );
    } finally {
      db.close();
    }
  });

  it('classifies a prepared INSERT statement as a write and a SELECT as a read of the statement-bound variable', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/ledger.ts')
      .symbol(
        1,
        'scip-typescript npm test 1.0.0 src/`ledger.ts`/CONNECTIONS.',
        'CONNECTIONS',
        SymbolInformation_Kind.Constant,
      )
      .symbol(
        2,
        'scip-typescript npm test 1.0.0 src/`ledger.ts`/writeLedger().',
        'writeLedger',
        SymbolInformation_Kind.Function,
      )
      .symbol(
        3,
        'scip-typescript npm test 1.0.0 src/`ledger.ts`/readLedger().',
        'readLedger',
        SymbolInformation_Kind.Function,
      )
      .definition(1, 1, 1, 0, 0, 0, 40)
      .definition(2, 1, 2, 2, 0, 9, 1)
      .definition(3, 1, 3, 11, 0, 15, 1)
      .chunk(1, 1, 0, 15)
      .write();
    const config: ScipQueryConfig = { projectRoot: root, dbPath, indexPath: join(root, 'index.scip') };
    writeFixtureFiles(root, {
      'src/ledger.ts': [
        'export const CONNECTIONS: number = 0;',
        '',
        'export function writeLedger(db: Db) {',
        '  db.prepare(',
        '    `INSERT INTO finding_outcome_ledger',
        '       (check_name, finding_id) VALUES (?, ?)`,',
        '  ).run();',
        '}',
        '',
        'export function readLedger(db: Db) {',
        '  db.prepare(',
        '    `SELECT check_name, finding_id FROM finding_outcome_ledger`,',
        '  ).all();',
        '}',
      ],
    });
    writeFileSync(
      join(root, 'Ledger.tla'),
      `---- MODULE Ledger ----
VARIABLES ledger
Write == ledger' = "written"
Read == UNCHANGED ledger
====
`,
    );
    const db = new ScipDatabase(config);
    const contract: TlaModelContract = {
      module: 'Ledger.tla',
      scope: ['src/ledger.ts'],
      variables: {
        ledger: {
          code: ['CONNECTIONS'],
          aliases: ['CONNECTIONS'],
          statements: [{ pattern: 'finding_outcome_ledger' }],
        },
      },
      actions: {
        Write: { code: ['writeLedger'], reads: [], writes: ['ledger'], calls: [] },
        Read: { code: ['readLedger'], reads: ['ledger'], writes: [], calls: [] },
      },
      invariants: [],
      traces: [],
    };

    try {
      const result = verifyTlaConformance(db, contract, readTlaModuleFacts(root, 'Ledger.tla'));

      expect(result.staticWrites).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            variable: 'ledger',
            kind: 'statement',
            target: expect.stringContaining('INSERT INTO finding_outcome_ledger'),
          }),
        ]),
      );
      expect(result.staticReads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            variable: 'ledger',
            kind: 'statement',
            target: expect.stringContaining('SELECT check_name'),
          }),
        ]),
      );
      expect(result.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('does not attribute a statement match whose text does not contain the pattern, and falls through dynamic concat', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/ledger.ts')
      .symbol(
        1,
        'scip-typescript npm test 1.0.0 src/`ledger.ts`/CONNECTIONS.',
        'CONNECTIONS',
        SymbolInformation_Kind.Constant,
      )
      .symbol(2, 'scip-typescript npm test 1.0.0 src/`ledger.ts`/other().', 'other', SymbolInformation_Kind.Function)
      .definition(1, 1, 1, 0, 0, 0, 40)
      .definition(2, 1, 2, 2, 0, 6, 1)
      .chunk(1, 1, 0, 6)
      .write();
    const config: ScipQueryConfig = { projectRoot: root, dbPath, indexPath: join(root, 'index.scip') };
    writeFixtureFiles(root, {
      'src/ledger.ts': [
        'export const CONNECTIONS: number = 0;',
        '',
        'export function other(db: Db, table: string) {',
        '  db.prepare("SELECT * FROM other_table").all();',
        '  db.prepare("INSERT INTO " + table + " VALUES (?)").run();',
        '}',
      ],
    });
    writeFileSync(
      join(root, 'Ledger.tla'),
      `---- MODULE Ledger ----
VARIABLES ledger
Other == UNCHANGED ledger
====
`,
    );
    const db = new ScipDatabase(config);
    const contract: TlaModelContract = {
      module: 'Ledger.tla',
      scope: ['src/ledger.ts'],
      variables: {
        ledger: {
          code: ['CONNECTIONS'],
          aliases: ['CONNECTIONS'],
          statements: [{ pattern: 'finding_outcome_ledger' }],
        },
      },
      actions: {
        Other: { code: ['other'], reads: [], writes: [], calls: [] },
      },
      invariants: [],
      traces: [],
    };

    try {
      const result = verifyTlaConformance(db, contract, readTlaModuleFacts(root, 'Ledger.tla'));

      expect(result.staticWrites.filter((write) => write.kind === 'statement')).toEqual([]);
      expect(result.staticReads.filter((read) => read.kind === 'statement')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('warns when mapped invariants are absent from the checked config', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    writeFixtureFiles(root, {
      'src/queue.ts': ['export const queue: string[] = [];', 'export function noop() {', '  return 1;', '}'],
    });
    writeFileSync(
      join(root, 'Queue.tla'),
      `---- MODULE Queue ----
VARIABLES queue
Noop == UNCHANGED queue
TypeOK == TRUE
====
`,
    );
    const db = fixtureDb(root);
    const contract: TlaModelContract = {
      scope: ['src/queue.ts'],
      variables: {
        queue: { code: ['queue'], aliases: ['queue'] },
      },
      actions: {
        Noop: { code: ['noop'], reads: [], writes: [], calls: [] },
      },
      invariants: ['TypeOK'],
      traces: [],
    };

    try {
      const result = verifyTlaConformance(db, contract, readTlaModuleFacts(root, 'Queue.tla'), [], []);

      expect(result.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'missing-invariant',
            modelElement: 'TypeOK',
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });

  it('rejects a swapped action-to-code binding (mutation regression: nonsense mappings cannot verify cleanly)', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-tla-conformance-'));
    writeFixtureFiles(root, {
      'src/queue.ts': [
        'export const queue: string[] = [];',
        '',
        'export function enqueue(job: string) {',
        '  queue.push(job);',
        '}',
        '',
        'export function peek(): string | undefined {',
        '  return queue[0];',
        '}',
      ],
    });
    writeFileSync(
      join(root, 'Queue.tla'),
      `---- MODULE Queue ----
VARIABLES queue
Init == queue = <<>>
Enqueue(job) == queue' = Append(queue, job)
Peek == UNCHANGED queue
====
`,
    );
    const db = fixtureDb(root);
    const correct: TlaModelContract = {
      module: 'Queue.tla',
      scope: ['src/queue.ts'],
      variables: {
        queue: { code: ['queue'], aliases: ['queue'] },
      },
      actions: {
        Enqueue: { code: ['enqueue'], reads: ['queue'], writes: ['queue'], calls: [] },
        Peek: { code: ['peek'], reads: ['queue'], writes: [], calls: [] },
      },
      invariants: [],
      traces: [],
    };
    const swapped: TlaModelContract = {
      ...correct,
      actions: {
        Enqueue: { ...correct.actions.Enqueue!, code: ['peek'] },
        Peek: { ...correct.actions.Peek!, code: ['enqueue'] },
      },
    };

    try {
      const moduleFacts = readTlaModuleFacts(root, 'Queue.tla');

      const honest = verifyTlaConformance(db, correct, moduleFacts);
      expect(honest.findings.filter((finding) => finding.severity === 'error')).toEqual([]);

      const nonsense = verifyTlaConformance(db, swapped, moduleFacts);
      expect(nonsense.findings.length).toBeGreaterThan(0);
      expect(nonsense.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'undeclared-write',
            severity: 'error',
            modelElement: 'Peek',
          }),
        ]),
      );
    } finally {
      db.close();
    }
  });
});

describe('tlaFindingGroups', () => {
  function syntheticFinding(overrides: Partial<TlaConformanceFinding> & { id: string }): TlaConformanceFinding {
    return {
      severity: 'warning',
      evidence: 'static-action',
      category: 'undeclared-read',
      message: 'synthetic finding',
      why: [],
      remediation: 'n/a',
      ...overrides,
    };
  }

  it('groups by (category, modelElement), escalates severity, and orders by count desc', () => {
    const findings: TlaConformanceFinding[] = [
      syntheticFinding({ id: 'A', category: 'undeclared-read', modelElement: 'Enqueue', severity: 'warning' }),
      syntheticFinding({ id: 'B', category: 'undeclared-read', modelElement: 'Enqueue', severity: 'error' }),
      syntheticFinding({ id: 'C', category: 'missing-invariant', modelElement: 'TypeOK', severity: 'warning' }),
    ];

    const groups = tlaFindingGroups(findings);

    expect(groups).toHaveLength(2);
    const enqueueGroup = groups.find((group) => group.modelElement === 'Enqueue');
    expect(enqueueGroup).toMatchObject({
      groupKey: 'undeclared-read:Enqueue',
      category: 'undeclared-read',
      count: 2,
      severity: 'error', // stronger of the two member findings
    });
    expect(enqueueGroup?.findingIds).toEqual(['A', 'B']);
    // Larger group (count 2) sorts before the single-member group.
    expect(groups[0]?.modelElement).toBe('Enqueue');
  });

  it('groups findings with no modelElement under a shared key instead of dropping them', () => {
    const findings: TlaConformanceFinding[] = [
      syntheticFinding({ id: 'X', category: 'contract', modelElement: undefined }),
      syntheticFinding({ id: 'Y', category: 'contract', modelElement: undefined }),
    ];

    const groups = tlaFindingGroups(findings);

    expect(groups).toEqual([expect.objectContaining({ groupKey: 'contract:-', count: 2, findingIds: ['X', 'Y'] })]);
  });
});
