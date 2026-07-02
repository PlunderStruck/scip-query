import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { SymbolInformation_Kind } from '@c4312/scip';
import { describe, expect, it } from 'vitest';
import { ScipDatabase } from '../../src/storage/db.js';
import type { ScipQueryConfig } from '../../src/domain/types.js';
import { buildInstrumentation } from '../../src/tla/instrument.js';
import type { TlaModelContract } from '../../src/tla/model-contract.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

function fixtureDb(root: string): ScipDatabase {
  writeFixtureFiles(root, {
    'src/queue.ts': ['export let depth = 0;', '', 'export function enqueue() {', '  depth = depth + 1;', '}', ''],
  });
  const dbPath = join(root, 'index.db');
  evidenceFixtureDb(dbPath)
    .document(1, 'typescript', 'src/queue.ts')
    .symbol(1, 'scip-typescript npm test 1.0.0 src/`queue.ts`/depth.', 'depth', SymbolInformation_Kind.Variable)
    .symbol(2, 'scip-typescript npm test 1.0.0 src/`queue.ts`/enqueue().', 'enqueue', SymbolInformation_Kind.Function)
    .write();
  const config: ScipQueryConfig = { dbPath, indexPath: join(root, 'index.scip'), projectRoot: root };
  return new ScipDatabase(config);
}

function contractWithVariables(names: readonly string[]): TlaModelContract {
  return {
    module: 'specs/Queue.tla',
    config: 'specs/Queue.cfg',
    scope: ['src/queue.ts'],
    variables: Object.fromEntries(names.map((name) => [name, { code: ['src/queue.ts/depth'], aliases: ['depth'] }])),
    actions: {
      Enqueue: { code: ['src/queue.ts/enqueue'], reads: [], writes: names.slice(0, 1), calls: [] },
    },
    invariants: [],
    traces: [],
  };
}

// Regression: the generated recorder's leading doc comment used to embed a
// `/* project */` placeholder per mapped variable inside the enclosing
// `/** ... */` block (src/tla/instrument.ts renderRecorder). Block comments
// don't nest in JS/TS — the first `*/` from the inner placeholder closed the
// outer comment early, and every field after the first left raw `identifier:
// undefined` tokens as top-level statements, which failed to parse. This
// reproduced for ANY contract with at least one mapped variable, in every
// scaffolded recorder.
describe('tla instrument recorder generation', () => {
  it('produces syntactically valid TypeScript for a single-variable contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scip-tla-instrument-'));
    const db = fixtureDb(dir);
    try {
      const result = buildInstrumentation(db, contractWithVariables(['depth']));
      expectValidTypeScript(result.recorderSource);
    } finally {
      db.close();
    }
  });

  it('produces syntactically valid TypeScript for a multi-variable contract', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scip-tla-instrument-multi-'));
    const db = fixtureDb(dir);
    try {
      const result = buildInstrumentation(db, contractWithVariables(['depth', 'phase', 'owner', 'published']));
      expectValidTypeScript(result.recorderSource);
      // The illustrative snapshot line should list every variable without
      // any nested block-comment markers that would break the doc comment.
      for (const name of ['depth', 'phase', 'owner', 'published']) {
        expect(result.recorderSource).toContain(`${name}: undefined`);
      }
    } finally {
      db.close();
    }
  });
});

function expectValidTypeScript(source: string): void {
  const file = ts.createSourceFile('recorder.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (file as unknown as { parseDiagnostics?: readonly { messageText: unknown }[] }).parseDiagnostics;
  const messages = (diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText as never, '\n'));
  expect(messages).toEqual([]);
}
