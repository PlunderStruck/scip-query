import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';
import { IndexerHistoryFixture } from '../../properties/indexer-history-fixture.js';
import { getAllDefinitions } from '../../../src/symbols/definition-catalog.js';
import { scipOccurrenceCallTargetsForRange } from '../../../src/symbols/graph/scip-occurrence-call-targets.js';
import { graphEvidence } from '../../../src/queries/graph/graph-evidence.js';

const argumentsToTest = [
  'first, second',
  '(first), (second)',
  '(first as string), second!',
  '(first satisfies string), second',
  'alias, second',
  '...tuple',
];
const defaultValues = [
  '(() => 3)',
  '((() => 3) as () => number)!',
  '((function () { return 3; }) satisfies () => number)',
];

describe('TypeScript declaration evidence through the published index', () => {
  let fixture: IndexerHistoryFixture;
  beforeAll(async () => {
    fixture = new IndexerHistoryFixture();
    const configPath = join(fixture.root, 'tsconfig.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.compilerOptions.noLib;
    writeFileSync(configPath, JSON.stringify(config));
    fixture.write('anonymous.ts', 'export default function () { return 1; }\n');
    fixture.write('arrow.ts', 'export default () => 2;\n');
    for (const [index, value] of defaultValues.entries()) {
      fixture.write(`default${index}.ts`, `export default ${value};\n`);
      fixture.write(
        `default-use${index}.ts`,
        `import value from "./default${index}.js";\nexport function entry() { return value(); }\n`,
      );
    }
    fixture.write(
      'calls.ts',
      'import anonymous from "./anonymous.js";\nimport arrow from "./arrow.js";\nexport function first() { return anonymous(); }\nexport function second() { return arrow(); }\n',
    );
    fixture.write(
      'members.ts',
      'function original() { return 1; }\nexport class Base {\n  field = original;\n  get callable() { return original; }\n  run() { return 2; }\n}\nconst base = new Base();\nexport function entry() { return base[("run" as const)](); }\n',
    );
    for (const [index, argumentsText] of argumentsToTest.entries())
      fixture.write(
        `flow${index}.ts`,
        `export function consume(a: string, b: string) { return a + b; }\nexport function entry(first: string, second: string) { const alias = first; const tuple = [first, second] as const; return consume(${argumentsText}); }\n`,
      );
    fixture.write(
      'dispatch.ts',
      'export class Base { run() { return 1; } }\nclass Child extends Base { run() { return 2; } }\nconst receiver: Base = new Child();\nexport function entry() { return receiver.run(); }\n',
    );
    fixture.write(
      'written.ts',
      'const service = { run() { return 1; } };\nexport function entry() { service.run = () => 2; return service.run(); }\n',
    );
    expect(new Project({ tsConfigFilePath: configPath }).getPreEmitDiagnostics()).toEqual([]);
    await fixture.index({ allowExpensiveRebuild: true });
  });
  afterAll(async () => {
    await fixture.dispose();
  });

  it.each(defaultValues.map((_, index) => index))('retains wrapped default implementation %i', (index) => {
    const db = fixture.open();
    try {
      const targets = scipOccurrenceCallTargetsForRange(db, `default-use${index}.ts`, 1, 1);
      expect(targets.targets.map((target) => target.definition.symbol)).toEqual([
        `scip-typescript npm history-fixture 1.0.0 \`default${index}.ts\`/default().`,
      ]);
      expect(targets.implementationUnresolvedCallsites).toBe(0);
    } finally {
      db.close();
    }
  });

  it('retains compiler field and getter identities with precise declaration ranges', () => {
    const db = fixture.open();
    try {
      const definitions = getAllDefinitions(db).filter((definition) => definition.relativePath === 'members.ts');
      expect(definitions).toContainEqual(expect.objectContaining({ leaf: 'field', startLine: 2, endLine: 2 }));
      expect(definitions).toContainEqual(
        expect.objectContaining({
          symbol: expect.stringContaining('Base#`<get>callable`().'),
          startLine: 3,
          endLine: 3,
        }),
      );
    } finally {
      db.close();
    }
  });

  it.each([
    [2, 'anonymous.ts'],
    [3, 'arrow.ts'],
  ] as const)('resolves anonymous default call at line %i', (line, file) => {
    const db = fixture.open();
    try {
      const targets = scipOccurrenceCallTargetsForRange(db, 'calls.ts', line, line);
      expect(targets.unresolvedCallsites).toBe(0);
      expect(targets.targets.map((target) => target.definition.relativePath)).toEqual([file]);
      expect(targets.implementationUnresolvedCallsites).toBe(0);
    } finally {
      db.close();
    }
  });

  it('resolves a wrapped literal member with a compiler occurrence', () => {
    const db = fixture.open();
    try {
      const targets = scipOccurrenceCallTargetsForRange(db, 'members.ts', 7, 7);
      expect(targets.unresolvedCallsites).toBe(0);
      expect(targets.targets.map((target) => target.definition.leaf)).toEqual(['run']);
    } finally {
      db.close();
    }
  });

  it.each(argumentsToTest.map((_, index) => index))(
    'retains both parameter transfers through argument form %i',
    (index) => {
      const db = fixture.open();
      try {
        const graph = graphEvidence(
          db,
          { symbols: [`scip-typescript npm history-fixture 1.0.0 \`flow${index}.ts\`/entry().`] },
          { families: ['dataflow'], direction: 'outgoing', maxDepth: 3, maxEdges: 100 },
        );
        const transfers = graph.edges.filter(
          (edge) => edge.subtype === 'argument-to-parameter' && edge.attributes?.callerPosition !== undefined,
        );
        expect(
          transfers.map((edge) => [edge.attributes!.callerPosition, edge.attributes!.calleePosition]).sort(),
        ).toEqual([
          [0, 0],
          [1, 1],
        ]);
      } finally {
        db.close();
      }
    },
  );

  it('publishes the same compiler occurrences as a clean independent index', () => {
    fixture.assertCurrent();
  });

  it.each(['dispatch', 'written'])(
    '%s preserves the declaration without claiming an established runtime target',
    (file) => {
      const db = fixture.open();
      try {
        const graph = graphEvidence(
          db,
          { symbols: [`scip-typescript npm history-fixture 1.0.0 \`${file}.ts\`/entry().`] },
          { families: ['execution'], direction: 'outgoing', maxDepth: 1, maxEdges: 100 },
        );
        expect(graph.edges.some((edge) => edge.subtype === 'call' && edge.evidenceStrength === 'exact')).toBe(false);
        expect(graph.coverage.unsupportedFrontiers).toBeGreaterThan(0);
        expect(graph.coverage.blindSpots).toContainEqual(
          expect.stringContaining(`implementation target at ${file}.ts:`),
        );
        expect(graph.coverage.blindSpots).toContainEqual(
          expect.stringMatching(/Compiler declaration reference.*Runtime implementation remains unresolved/),
        );
      } finally {
        db.close();
      }
    },
  );
});
