import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import type { ScipQueryConfig } from '../../src/domain/types.js';
import { readTlaModuleFacts, type TlaModelContract } from '../../src/tla/model-contract.js';
import { verifyTlaConformance } from '../../src/tla/conformance.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

function fixtureDb(root: string): ScipDatabase {
  const dbPath = join(root, 'index.db');
  evidenceFixtureDb(dbPath)
    .document(1, 'typescript', 'src/queue.ts')
    .symbol(1, 'scip-typescript npm test 1.0.0 src/`queue.ts`/queue.', 'queue')
    .symbol(2, 'scip-typescript npm test 1.0.0 src/`queue.ts`/enqueue().', 'enqueue')
    .symbol(3, 'scip-typescript npm test 1.0.0 src/`queue.ts`/cancel().', 'cancel')
    .definition(1, 1, 1, 0, 0, 0, 28)
    .definition(2, 1, 2, 2, 0, 4, 1)
    .definition(3, 1, 3, 6, 0, 8, 1)
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
        Enqueue: { code: ['enqueue'], reads: [], writes: ['queue'], calls: [], allowUnknown: false },
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
        Peek: { code: ['enqueue'], reads: ['queue'], writes: [], calls: [], allowUnknown: true },
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
});
