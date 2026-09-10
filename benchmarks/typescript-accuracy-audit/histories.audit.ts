import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Project } from 'ts-morph';
import { it } from 'vitest';
import { IndexerHistoryFixture } from '../../tests/properties/indexer-history-fixture.js';
import { graphEvidence } from '../../src/queries/graph/graph-evidence.js';
import { getAst } from '../../src/source/ast/ast-core.js';
import { evaluateStaticValue } from '../../src/symbols/graph/static-value-flow.js';
import type { SyntaxNode } from '../../src/source/ast/ast-types.js';

it('records incremental/full parity across source and module-resolution histories', async () => {
  const output = resolve(process.env['SCIP_QUERY_AUDIT_OUTPUT'] ?? '/tmp/scip-query-ts-discovery');
  mkdirSync(output, { recursive: true });
  const fixture = new IndexerHistoryFixture();
  const path = join(fixture.root, 'tsconfig.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  delete config.compilerOptions.noLib;
  writeFileSync(path, JSON.stringify(config));
  const owner = 'export interface Payload { value: number }\nexport const api = { run() { return 1; } };\n';
  const consumer = (from: string) => `import { api } from '${from}';\nexport function entry() { return api.run(); }\n`;
  const observations: Array<Record<string, unknown>> = [];
  function projection(owner = fixture) {
    const db = owner.open();
    try {
      const graph = graphEvidence(
        db,
        { symbols: ['scip-typescript npm history-fixture 1.0.0 `consumer.ts`/entry().'] },
        { families: ['execution', 'dependencies'], direction: 'outgoing', maxDepth: 2, maxEdges: 200 },
      );
      if (process.env['SCIP_QUERY_AUDIT_SCOPE'] !== 'exact-claims') return graph;
      const root = getAst(db, 'consumer.ts')?.rootNode;
      function probe(node: SyntaxNode): SyntaxNode | undefined {
        if (node.type === 'variable_declarator' && node.childForFieldName('name')?.text === 'probe')
          return node.childForFieldName('value') ?? undefined;
        for (const child of node.namedChildren) {
          const found = probe(child);
          if (found) return found;
        }
        return undefined;
      }
      return { graph, value: root ? evaluateStaticValue({ db, file: 'consumer.ts', root }, probe(root)) : null };
    } finally {
      db.close();
    }
  }
  const steps: Array<[string, () => void]> = [
    ['body-edit', () => fixture.write('owner.ts', owner.replace('return 1', 'return 2'))],
    ['member-replacement', () => fixture.write('owner.ts', owner + 'api.run = () => 3;\n')],
    [
      'barrel-addition',
      () => {
        fixture.write('barrel.ts', 'export { api } from "./owner.js";\n');
        fixture.write('consumer.ts', consumer('./barrel.js'));
      },
    ],
    [
      'file-rename',
      () => {
        fixture.write('moved.ts', fixture.sources.get('owner.ts')!);
        fixture.write('owner.ts', null);
        fixture.write('barrel.ts', 'export { api } from "./moved.js";\n');
      },
    ],
    [
      'barrel-deletion',
      () => {
        fixture.write('barrel.ts', null);
        fixture.write('consumer.ts', consumer('./moved.js'));
      },
    ],
    [
      'restore-original',
      () => {
        fixture.write('owner.ts', owner);
        fixture.write('moved.ts', null);
        fixture.write('consumer.ts', consumer('./owner.js'));
      },
    ],
    [
      'path-alias',
      () => {
        config.compilerOptions.paths = { '@api': ['./owner.ts'] };
        writeFileSync(path, JSON.stringify(config));
        fixture.write('consumer.ts', consumer('@api'));
      },
    ],
    [
      'retarget-path-alias',
      () => {
        fixture.write('alternate.ts', owner.replace('return 1', 'return 9'));
        config.compilerOptions.paths = { '@api': ['./alternate.ts'] };
        writeFileSync(path, JSON.stringify(config));
      },
    ],
    [
      'delete-alternate-restore-path',
      () => {
        fixture.write('alternate.ts', null);
        config.compilerOptions.paths = { '@api': ['./owner.ts'] };
        writeFileSync(path, JSON.stringify(config));
      },
    ],
    [
      'type-only-reference',
      () =>
        fixture.write(
          'consumer.ts',
          consumer('@api') + 'import type { Payload } from "@api"; export type Output = Payload;\n',
        ),
    ],
    ['unchanged-inputs', () => {}],
  ];
  if (process.env['SCIP_QUERY_AUDIT_SCOPE'] === 'exact-claims') {
    const directOwner = 'export const box = { path: "/right" }; export function run() { return "/right"; }';
    const directConsumer =
      'import { box, run } from "./owner.js"; export function entry() { const probe = box.path; return run(); }';
    steps.splice(
      0,
      steps.length,
      [
        'direct-functions-and-values',
        () => {
          fixture.write('owner.ts', directOwner);
          fixture.write('consumer.ts', directConsumer);
        },
      ],
      ['owner-write', () => fixture.write('owner.ts', directOwner + 'box.path = "/changed";')],
      ['remove-owner-write', () => fixture.write('owner.ts', directOwner)],
      [
        'cross-file-writer',
        () => {
          fixture.write(
            'writer.ts',
            'import { box } from "./owner.js"; export function change() { box.path = "/changed"; }',
          );
          fixture.write(
            'consumer.ts',
            'import { box, run } from "./owner.js"; import { change } from "./writer.js"; export function entry() { change(); const probe = box.path; return run(); }',
          );
        },
      ],
      ['writer-becomes-noop', () => fixture.write('writer.ts', 'export function change() {}')],
      [
        'writer-reflect-effect',
        () =>
          fixture.write(
            'writer.ts',
            'import { box } from "./owner.js"; export function change() { Reflect.set(box, "path", "/changed"); }',
          ),
      ],
      [
        'deferred-writer',
        () =>
          fixture.write(
            'consumer.ts',
            'import { box, run } from "./owner.js"; import { change } from "./writer.js"; export async function entry() { await Promise.resolve().then(change); const probe = box.path; return run(); }',
          ),
      ],
      [
        'remove-writer-module',
        () => {
          fixture.write('writer.ts', null);
          fixture.write('consumer.ts', directConsumer);
        },
      ],
      [
        'anonymous-default',
        () => {
          fixture.write('owner.ts', 'export default function() { return "/right"; }');
          fixture.write(
            'consumer.ts',
            'import run from "./owner.js"; export function entry() { const probe = run(); return probe; }',
          );
        },
      ],
      [
        'wrapped-default',
        () => fixture.write('owner.ts', 'export default ((() => "/changed") satisfies () => string);'),
      ],
      [
        'throwing-parameter-pattern',
        () => {
          fixture.write('owner.ts', 'export default function({ x }: any) { return "/wrong"; }');
          fixture.write(
            'consumer.ts',
            'import run from "./owner.js"; export function entry() { const probe = run(null); return probe; }',
          );
        },
      ],
      [
        'restore-default',
        () => {
          fixture.write('owner.ts', 'export default function() { return "/right"; }');
          fixture.write(
            'consumer.ts',
            'import run from "./owner.js"; export function entry() { const probe = run(); return probe; }',
          );
        },
      ],
      ['leading-trivia', () => fixture.write('consumer.ts', '\n\n/* λ😀 */\n' + fixture.sources.get('consumer.ts'))],
      ['crlf', () => fixture.write('consumer.ts', fixture.sources.get('consumer.ts')!.replaceAll('\n', '\r\n'))],
      [
        'same-line-alias',
        () => {
          fixture.write('owner.ts', directOwner);
          fixture.write(
            'consumer.ts',
            'const a = () => 1; const b = () => 2; const alias = b; export function entry() { return alias(); }',
          );
        },
      ],
      [
        'split-alias-lines',
        () =>
          fixture.write(
            'consumer.ts',
            'const a = () => 1;\nconst b = () => 2;\nconst alias = b;\nexport function entry() { return alias(); }',
          ),
      ],
      ['restore-direct-functions', () => fixture.write('consumer.ts', directConsumer)],
      ['unchanged-inputs', () => {}],
    );
  }
  try {
    fixture.write('bridge.ts', null);
    fixture.write('owner.ts', owner);
    fixture.write('consumer.ts', consumer('./owner.js'));
    await fixture.index({ allowExpensiveRebuild: true });
    fixture.startService();
    for (const [name, change] of steps) {
      change();
      const diagnostics = new Project({ tsConfigFilePath: path })
        .getPreEmitDiagnostics()
        .map((d) => d.getMessageText());
      if (diagnostics.length) {
        observations.push({ name, diagnostics, status: 'invalid-fixture' });
        writeFileSync(join(output, 'histories.json'), JSON.stringify(observations, null, 2) + '\n');
        console.log(`History ${name} invalid: ${JSON.stringify(diagnostics)}`);
        continue;
      }
      try {
        await fixture.index({ allowExpensiveRebuild: true });
        const statuses = [...fixture.statuses];
        const incremental = projection();
        let compilerParity: string | true = true;
        try {
          fixture.assertCurrent();
        } catch (error) {
          compilerParity = String(error);
        }
        const clean = new IndexerHistoryFixture();
        let full;
        let cleanStatuses: string[];
        let normalizedGraphParity = false;
        try {
          for (const file of [...clean.sources.keys()]) clean.write(file, null);
          for (const [file, source] of fixture.sources) clean.write(file, source);
          writeFileSync(join(clean.root, 'tsconfig.json'), readFileSync(path));
          await clean.index({ allowExpensiveRebuild: true });
          full = projection(clean);
          const replaceRoot = (value: unknown, root: string) =>
            JSON.parse(JSON.stringify(value).replaceAll(root, '<checkout>'));
          normalizedGraphParity = isDeepStrictEqual(
            replaceRoot(incremental, fixture.root),
            replaceRoot(full, clean.root),
          );
          cleanStatuses = [...clean.statuses];
        } finally {
          await clean.dispose();
        }
        observations.push({
          name,
          actualIncremental: statuses.some((s) => s.startsWith('Incremental TypeScript index emitted')),
          statuses,
          cleanStatuses,
          compilerParity,
          graphParity: isDeepStrictEqual(incremental, full),
          normalizedGraphParity,
          incremental,
          full,
        });
      } catch (error) {
        observations.push({ name, error: String(error), statuses: [...fixture.statuses] });
      }
      writeFileSync(join(output, 'histories.json'), JSON.stringify(observations, null, 2) + '\n');
      console.log(
        `History ${name}: ${JSON.stringify(observations.at(-1), (key, value) => (['incremental', 'full', 'statuses'].includes(key) ? undefined : value))}`,
      );
    }
  } finally {
    await fixture.dispose();
  }
}, 300_000);
