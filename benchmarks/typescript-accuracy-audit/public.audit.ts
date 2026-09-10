import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { Project } from 'ts-morph';
import { ts } from '@ts-morph/common';
import { it } from 'vitest';
import { IndexerHistoryFixture } from '../../tests/properties/indexer-history-fixture.js';
import { collectRuntimeBoundaryGraph } from '../../src/analysis/runtime-boundaries/graph.js';
import { sourceBindingResolver } from '../../src/source/ast/source-binding-identity.js';
import { getAst } from '../../src/source/ast/ast-core.js';
import { resolveImportPath } from '../../src/source/primitives/import-path-resolver.js';
import type { GraphEvidenceResult } from '../../src/queries/graph/graph-evidence.js';
import { cases } from './cases.js';
import { moduleCases } from './module-cases.js';
import { flowCases } from './flow-cases.js';

it('checks public projections, transport, runtime values, and module reference contracts', async () => {
  const output = resolve(process.env['SCIP_QUERY_AUDIT_OUTPUT'] ?? '/tmp/scip-query-ts-discovery');
  mkdirSync(output, { recursive: true });
  const fixture = new IndexerHistoryFixture();
  const selected = [...cases, ...moduleCases, ...flowCases].filter((c) =>
    [
      'direct-call',
      'sibling-write',
      'direct-write',
      'helper-parameter-write',
      'array-rest',
      'field-function',
      'getter-callable',
      'module-anonymous-default',
      'module-default-arrow',
      'module-direct-import-write',
      'module-owner-direct-write',
      'flow-direct',
      'flow-parentheses',
      'wrapped-bracket-call',
      'prototype-method-write',
    ].includes(c.id),
  );
  const save = (name: string, value: unknown) =>
    writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
  const env = { ...process.env };
  delete env['SCIP_QUERY_CACHE_DIR'];
  delete env['SCIP_QUERY_SESSION'];
  const cli = (args: string[]) =>
    execFileSync(process.execPath, [resolve('dist/cli.js'), ...args], {
      cwd: fixture.root,
      env,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  function evidence(
    selector: string,
    direction: string,
    family = 'execution',
    maxEdges = 100,
    symbol = false,
  ): GraphEvidenceResult {
    const path = join(fixture.cache, 'packet.json');
    cli([
      'evidence',
      symbol ? '--symbol' : '--at',
      selector,
      '--edge',
      family,
      '--direction',
      direction,
      '--depth',
      '3',
      '--max-edges',
      String(maxEdges),
      '--full',
      '--json',
      '--json-output',
      path,
    ]);
    return JSON.parse(readFileSync(path, 'utf8')).result.graph;
  }
  const dependencyForms: Array<[string, string, string, string]> = [
    ['named', 'import { original } from "./dependency-owner.js";', 'value', 'import'],
    ['namespace', 'import * as api from "./dependency-owner.js";', 'value', 'import'],
    ['default', 'import original from "./dependency-owner.js";', 'value', 'import'],
    ['side-effect', 'import "./dependency-owner.js";', 'value', 'import'],
    ['type-only', 'import type { Payload } from "./dependency-owner.js";', 'type', 'import'],
    ['specifier-type', 'import { type Payload } from "./dependency-owner.js";', 'type', 'import'],
    ['mixed', 'import { original, type Payload } from "./dependency-owner.js";', 'value', 'import'],
    ['reexport', 'export { original } from "./dependency-owner.js";', 'value', 'reexport'],
    ['reexport-type', 'export type { Payload } from "./dependency-owner.js";', 'type', 'reexport'],
    ['reexport-star', 'export * from "./dependency-owner.js";', 'value', 'reexport'],
    ['reexport-namespace', 'export * as api from "./dependency-owner.js";', 'value', 'reexport'],
    ['type-expression', 'type Payload = import("./dependency-owner.js").Payload;', 'type', 'type-import'],
    [
      'dynamic-literal',
      'export function load() { return import("./dependency-owner.js"); }',
      'value',
      'dynamic-import',
    ],
  ];
  try {
    const configPath = join(fixture.root, 'tsconfig.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.compilerOptions.noLib;
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(
      join(fixture.root, '.scipquery.json'),
      JSON.stringify({ dbPath: '.cache', watch: { enabled: false } }),
    );
    for (const item of selected) {
      fixture.write(`${item.id}.ts`, item.source);
      for (const [file, source] of Object.entries(item.files ?? {})) fixture.write(file, source);
    }
    const transportLines = Array.from({ length: 180 }, (_, i) => `export function emitted_${i}() { return ${i}; }`);
    fixture.write('transport.ts', transportLines.join('\n') + '\n');
    fixture.write(
      'dependency-owner.ts',
      'export interface Payload { value: number }\nexport function original() { return 1; }\nexport default original;\n',
    );
    for (const [id, source] of dependencyForms) fixture.write(`dependency-${id}.ts`, source + '\nexport {};\n');
    const valueCases = cases.filter((c) =>
      ['value-member-helper-mutation', 'value-member-object-assign', 'value-member-reflect-write'].includes(c.id),
    );
    const executedPaths = new Map<string, string>();
    for (const item of valueCases) {
      const source = item.source.replace('return probe;', 'return fetch(probe);');
      const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const path = execFileSync(
        process.execPath,
        [
          '-e',
          `globalThis.fetch = async (path) => path;\n${compiled}\nPromise.resolve(exports.entry()).then(value => process.stdout.write(JSON.stringify(value)));`,
        ],
        { encoding: 'utf8', timeout: 10_000 },
      );
      executedPaths.set(item.id, JSON.parse(path));
      if (JSON.parse(path) !== '/right') throw new Error(`Invalid HTTP fixture ${item.id}`);
    }
    for (const item of valueCases)
      fixture.write(`${item.id}.ts`, item.source.replace('return probe;', 'return fetch(probe);'));
    const project = new Project({ tsConfigFilePath: configPath });
    const diagnostics = project.getPreEmitDiagnostics().map((d) => d.getMessageText());
    if (diagnostics.length) throw new Error(`Invalid public fixtures: ${JSON.stringify(diagnostics)}`);
    cli(['reindex', '--allow-expensive-rebuild']);
    const projections: Array<Record<string, unknown>> = [];
    for (const item of selected) {
      const at = `${item.id}.ts:${item.source.split('\n').findIndex((s) => s.includes('/* probe */')) + 1}`;
      const graph = evidence(at, 'outgoing', item.flow ? 'dataflow' : 'execution');
      const symmetry = [];
      if (!item.flow)
        for (const edge of graph.edges.filter((e) => e.subtype === 'call' && e.to.symbol && e.from.symbol)) {
          const incoming = evidence(edge.to.symbol!, 'incoming', 'execution', 100, true);
          symmetry.push({
            from: edge.from.symbol,
            to: edge.to.symbol,
            found: incoming.edges.some(
              (e) => e.subtype === 'call' && e.from.symbol === edge.from.symbol && e.to.symbol === edge.to.symbol,
            ),
            coverage: incoming.coverage.status,
          });
        }
      const bounded = evidence(at, 'outgoing', item.flow ? 'dataflow' : 'execution', 1);
      const accountedIds = new Set([
        ...bounded.edges.map((e) => e.id),
        ...(bounded.folds ?? []).flatMap((f) => f.edgeIds),
      ]);
      projections.push({
        id: item.id,
        graph,
        symmetry,
        foldAccounting: graph.edges.every((e) => accountedIds.has(e.id)),
        boundedEdges: bounded.edges.length,
        foldedEdges: (bounded.folds ?? []).reduce((sum, f) => sum + f.edgeCount, 0),
      });
    }
    save('public-projections.json', projections);
    const pages = [cli(['code', 'transport.ts', '--members', 'all'])];
    for (let i = 0; i < 20; i++) {
      const continuation = pages.at(-1)!.match(/Continue exactly:\n([^\n]+)/)?.[1];
      if (!continuation) break;
      const words = continuation.trim().split(/\s+/);
      if (words.length !== 4 || words[2] !== 'continue' || !/^[\w.-]+$/.test(words[3]!))
        throw new Error('Unexpected continuation command');
      pages.push(
        execFileSync(words[0]!, words.slice(1), {
          cwd: fixture.root,
          env,
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024,
        }),
      );
    }
    save('transport.json', {
      pages: pages.length,
      continuationRemaining: pages.at(-1)!.includes('Continue exactly:'),
      missingLines: transportLines.filter((line) => !pages.join('\n').includes(line)),
    });
    const db = fixture.open();
    try {
      const runtime = await collectRuntimeBoundaryGraph(db);
      save(
        'runtime-consumers.json',
        valueCases.map((item) => ({
          id: item.id,
          expectedPath: '/right',
          executedPath: executedPaths.get(item.id),
          observations: runtime.observations.filter(
            (o) => o.source.file === `${item.id}.ts` && o.action === 'http.request',
          ),
        })),
      );
      const references = [];
      for (const [id, , kind, syntax] of dependencyForms) {
        const file = `dependency-${id}.ts`;
        const root = getAst(db, file)!.rootNode;
        const actual = sourceBindingResolver(file, root).moduleReferences();
        const resolved = resolveImportPath(db, file, './dependency-owner.js');
        const compilerSource = project.getSourceFileOrThrow(file);
        const destination = compilerSource.getImportDeclarations().at(0)?.getModuleSpecifierSourceFile()?.getFilePath();
        references.push({
          id,
          expected: { kind, syntax, destination: 'dependency-owner.ts' },
          actual,
          resolved,
          directCompilerDestination: destination ? relative(fixture.root, destination) : null,
          matches:
            actual.length === 1 &&
            actual[0]!.kind === kind &&
            actual[0]!.syntax === syntax &&
            resolved === 'dependency-owner.ts',
        });
      }
      save('dependencies.json', references);
    } finally {
      db.close();
    }
    console.log(
      `Public projections: ${projections.length}; symmetry failures: ${projections.flatMap((p) => p.symmetry as Array<{ found: boolean }>).filter((s) => !s.found).length}; fold failures: ${projections.filter((p) => !p.foldAccounting).length}; transport pages: ${pages.length}`,
    );
  } finally {
    await fixture.dispose();
  }
}, 300_000);
