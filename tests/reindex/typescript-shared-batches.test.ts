import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fromBinary } from '@bufbuild/protobuf';
import { IndexSchema } from '@c4312/scip';
import { expect, test } from 'vitest';
import { createTypeScriptCompilerShards } from '../../src/reindex/typescript-compiler-shards.js';

function runCompiler(root: string, output: string, projects: string[]) {
  execFileSync(
    process.execPath,
    [
      resolve('dist/typescript-indexer.js'),
      'index',
      '--cwd',
      root,
      '--output',
      output,
      '--no-progress-bar',
      ...projects,
    ],
    { cwd: root, stdio: 'pipe' },
  );
  return fromBinary(IndexSchema, readFileSync(output)).documents.sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  );
}

test('shared compiler batches preserve complete globals, augmentations, overloads, aliases and JSX', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-query-shared-compiler-')));
  try {
    const sources = {
      'a-globals.ts': 'interface Settings { enabled: boolean }\ndeclare function choose(value: string): string;\n',
      'b-owner.ts':
        'export interface Model { id: number }\nexport function make(): Model { return { id: 1, title: "ok" }; }\n',
      'c-alias.ts': 'export { make as build } from "./b-owner.js";\n',
      'd-consumer.tsx': [
        'import { build } from "./c-alias.js";',
        'const settings: Settings = { enabled: true, name: "example" };',
        'export const model = build();',
        'export const title = model.title;',
        'export const choice = choose(settings.name);',
        'export const numeric = choose(model.id);',
        'export function View(props: { title: string }) { return <div title={props.title} />; }',
        'export const rendered = <View title={title} />;',
      ].join('\n'),
      'y-augmentation.ts':
        'import "./b-owner.js";\ndeclare module "./b-owner.js" { interface Model { title: string } }\n',
      'z-globals.ts': [
        'interface Settings { name: string }',
        'declare function choose(value: number): number;',
        'declare namespace JSX { interface Element {} interface IntrinsicElements { div: { title: string } } }',
      ].join('\n'),
    };
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'shared-batch-fixture', version: '1.0.0' }));
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          types: [],
          noLib: true,
          jsx: 'preserve',
        },
        include: ['*.ts', '*.tsx'],
      }),
    );
    for (const [file, text] of Object.entries(sources)) writeFileSync(join(root, file), text);
    const run = (output: string, projects: string[]) => runCompiler(root, output, projects);
    const baseline = run(join(root, 'baseline.scip'), ['.']);
    const shards = createTypeScriptCompilerShards({
      projectRoot: root,
      rootConfigPath: 'tsconfig.json',
      inputPaths: Object.keys(sources),
      targetFiles: 2,
    });
    for (const shard of shards) writeFileSync(shard.configPath, shard.content);
    const actual = run(
      join(root, 'shared.scip'),
      shards.map((shard) => shard.configPath),
    );
    expect(actual.map((document) => document.relativePath)).toEqual(Object.keys(sources));
    // This fixture also preserves exact documentation. The large-project
    // differential separately accounts for compiler union presentation order.
    expect(actual).toEqual(baseline);
    const consumer = actual.find((document) => document.relativePath === 'd-consumer.tsx')!;
    const targets = consumer.occurrences
      .filter((occurrence) => (occurrence.symbolRoles & 1) === 0)
      .map((occurrence) => occurrence.symbol);
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.stringContaining('`b-owner.ts`/make().'),
        expect.stringContaining('`y-augmentation.ts`/'),
        expect.stringContaining('`a-globals.ts`/choose().'),
        expect.stringContaining('`z-globals.ts`/choose().'),
      ]),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('owned batches do not reuse trees parsed under a referenced project’s different module detection', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scip-query-batch-reference-')));
  try {
    mkdirSync(join(root, 'child'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'reference-fixture', version: '1.0.0' }));
    const options = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noLib: true, types: [] };
    writeFileSync(
      join(root, 'child/tsconfig.json'),
      JSON.stringify({
        compilerOptions: { ...options, moduleDetection: 'legacy', composite: true },
        files: ['globals.ts'],
      }),
    );
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { ...options, moduleDetection: 'force' },
        files: ['child/globals.ts', 'consumer.ts'],
        references: [{ path: './child' }],
      }),
    );
    writeFileSync(join(root, 'child/globals.ts'), 'const globalValue = 42;\n');
    writeFileSync(join(root, 'consumer.ts'), 'export const value = globalValue;\n');
    const baseline = runCompiler(root, join(root, 'baseline.scip'), ['--no-global-caches', '.']);
    const shards = createTypeScriptCompilerShards({
      projectRoot: root,
      rootConfigPath: 'tsconfig.json',
      inputPaths: ['child/globals.ts', 'consumer.ts'],
      targetFiles: 1,
    });
    for (const shard of shards) writeFileSync(shard.configPath, shard.content);
    // TypeScript does not inherit references through `extends`; explicitly
    // exercise upstream traversal before the first owned batch.
    const actual = runCompiler(root, join(root, 'shared.scip'), [
      join(root, 'child'),
      ...shards.map((shard) => shard.configPath),
    ]);
    expect(actual).toEqual(baseline);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
