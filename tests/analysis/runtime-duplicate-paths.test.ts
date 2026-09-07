import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boundaryFileContext } from '../../src/analysis/runtime-boundaries/extractors.js';
import { serializedBodySummariesForFile } from '../../src/analysis/runtime-boundaries/carrier-discriminators.js';
import { collectRuntimeBoundaryGraph } from '../../src/analysis/runtime-boundaries/graph.js';
import { evaluateStaticValue } from '../../src/symbols/graph/static-value-flow.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('shared runtime value and parameter analysis', () => {
  const resources: Array<{ db: ScipDatabase; root: string }> = [];
  afterEach(() => {
    for (const { db, root } of resources.splice(0)) {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  function fixture(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'scip-shared-runtime-values-'));
    writeFixtureFiles(root, files);
    const builder = evidenceFixtureDb(join(root, 'index.db'));
    Object.keys(files).forEach((file, index) => builder.document(index + 1, 'typescript', file));
    return {
      builder,
      open() {
        builder.write();
        const db = new ScipDatabase({
          projectRoot: root,
          dbPath: join(root, 'index.db'),
          indexPath: join(root, 'index.scip'),
        });
        resources.push({ db, root });
        return db;
      },
    };
  }

  it.each([
    ["'/api/events'", '/api/events'],
    ["'/api/' + 'events'", '/api/events'],
    [String.raw`'/api/\x65vents'`, '/api/events'],
    [String.raw`"/api/\u0065vents"`, '/api/events'],
    [String.raw`'owner\'s'`, "owner's"],
    ['`line\r\nend`', 'line\nend'],
    ['`/api/\\${literal}`', '/api/${literal}'],
  ])('evaluates the actual value of %s', (expression, expected) => {
    const db = fixture({ 'src/value.ts': `const value = ${expression};` }).open();
    const context = boundaryFileContext(db, 'src/value.ts')!;
    const node = context.root.descendantsOfType('variable_declarator')[0]!.childForFieldName('value');
    expect(evaluateStaticValue(context, node)).toMatchObject({ value: expected, precision: 'literal' });
  });

  it('uses JavaScript string semantics inside a Vue script block', () => {
    const db = fixture({ 'src/value.vue': '<script setup>const value = "/api/\\x65vents";</script>' }).open();
    const context = boundaryFileContext(db, 'src/value.vue')!;
    const node = context.root.descendantsOfType('variable_declarator')[0]!.childForFieldName('value');
    expect(evaluateStaticValue(context, node)).toMatchObject({ value: '/api/events', precision: 'literal' });
  });

  it.each([String.raw`'\xZZ'`, String.raw`'\u{110000}'`])(
    'does not assign a concrete value to malformed string syntax: %s',
    (expression) => {
      const db = fixture({ 'src/value.ts': `const value = ${expression};` }).open();
      const context = boundaryFileContext(db, 'src/value.ts')!;
      const node = context.root.descendantsOfType('variable_declarator')[0]!.childForFieldName('value');
      // A recovery tree can expose a symbolic identifier; neither result proves a literal.
      expect(evaluateStaticValue(context, node)).toMatchObject({ evidence: 'expression' });
    },
  );

  it('does not turn a comparison containing a plus sign into a string concatenation', () => {
    const db = fixture({ 'src/value.ts': "const value = 'a+' === 'b';" }).open();
    const context = boundaryFileContext(db, 'src/value.ts')!;
    const node = context.root.descendantsOfType('variable_declarator')[0]!.childForFieldName('value');
    expect(evaluateStaticValue(context, node)).toMatchObject({ evidence: 'expression', precision: 'unknown' });
  });

  it('keeps nested template expressions as unknown holes rather than literal suffixes', () => {
    const db = fixture({ 'src/value.ts': 'const value = `/api/${choose({ key: "}" })}/events`;' }).open();
    const context = boundaryFileContext(db, 'src/value.ts')!;
    const node = context.root.descendantsOfType('variable_declarator')[0]!.childForFieldName('value');
    expect(evaluateStaticValue(context, node)).toMatchObject({
      value: '/api/{}/events',
      precision: 'constrained-pattern',
    });
  });

  it('uses the same constant resolution for direct and compiler-resolved wrapper calls', async () => {
    const symbol = 'scip-typescript npm fixture 1.0.0 src/`wrapper.ts`/send().';
    const setup = fixture({
      'src/wrapper.ts': "export function send(path: string) {\n  return fetch(path, { method: 'POST' });\n}\n",
      'src/client.ts':
        "import { send } from './wrapper.js';\nconst PATH = '/api/' + 'events';\nsend(PATH);\nfetch(PATH, { method: 'POST' });\nlet mutable = '/stale';\nmutable = '/current';\nsend(mutable);\n",
    });
    setup.builder
      .symbol(1, symbol, 'send', 12)
      .definition(1, 1, 1, 0, 0, 2, 1)
      .chunk(1, 2, 2, 2)
      .mention(1, 1, 0)
      .occurrence(1, symbol, 2, 0, 0, 4)
      .chunk(2, 2, 6, 6)
      .mention(2, 1, 0)
      .occurrence(2, symbol, 6, 0, 0, 4);
    const graph = await collectRuntimeBoundaryGraph(setup.open());
    const direct = graph.observations.find(
      (o) => o.source.file === 'src/client.ts' && o.source.startLine === 3 && o.action === 'http.request',
    );
    const wrapped = graph.observations.find((o) => o.extractor === 'builtin.http-summary' && o.source.startLine === 2);
    expect(direct?.keyParts.find((part) => part.name === 'path')?.value).toBe('/api/events');
    expect(wrapped?.keyParts.find((part) => part.name === 'path')).toMatchObject({
      value: '/api/events',
      evidence: 'constant',
      derivation: { kind: 'mechanically-derived' },
    });
    expect(graph.observations.some((o) => o.extractor === 'builtin.http-summary' && o.source.startLine === 6)).toBe(
      false,
    );
  });

  it('does not infer a serialized parameter dependency from strings, comments or property keys', () => {
    const symbol = 'scip-typescript npm fixture 1.0.0 src/`body.ts`/send().';
    const setup = fixture({
      'src/body.ts':
        "export function send(ignored: unknown, actual: unknown) {\n  return fetch('/fixed', { body: JSON.stringify({ ignored: 'ignored', value: actual /* ignored */ }) });\n}\n",
    });
    setup.builder.symbol(1, symbol, 'send', 12).definition(1, 1, 1, 0, 0, 2, 1);
    const db = setup.open();
    const summaries = serializedBodySummariesForFile(boundaryFileContext(db, 'src/body.ts')!);
    expect(summaries.map((summary) => summary.parameterIndexes)).toEqual([[1]]);
  });
});
