import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ts } from '@ts-morph/common';
import { Project } from 'ts-morph';
import { it } from 'vitest';
import { IndexerHistoryFixture } from '../../tests/properties/indexer-history-fixture.js';
import { collectRuntimeBoundaryGraph } from '../../src/analysis/runtime-boundaries/graph.js';
import { breadthCases } from './breadth-cases.js';

it.skipIf(process.env['SCIP_QUERY_AUDIT_SCOPE'] !== 'breadth')(
  'records breadth cases through real HTTP extraction and public CLI',
  async () => {
    const fixture = new IndexerHistoryFixture();
    const output = resolve(process.env['SCIP_QUERY_AUDIT_OUTPUT'] ?? '/tmp/scip-query-breadth-audit/corpus');
    mkdirSync(output, { recursive: true });
    const cases = breadthCases.filter(
      (c) =>
        c.id.includes('escape-') ||
        c.id.includes('path-') ||
        c.id.includes('template-') ||
        c.id === 'breadth-positive-literal',
    );
    try {
      const config = JSON.parse(readFileSync(join(fixture.root, 'tsconfig.json'), 'utf8'));
      delete config.compilerOptions.noLib;
      writeFileSync(join(fixture.root, 'tsconfig.json'), JSON.stringify(config));
      writeFileSync(
        join(fixture.root, '.scipquery.json'),
        JSON.stringify({ dbPath: '.cache', watch: { enabled: false } }),
      );
      for (const item of cases) {
        fixture.write(`${item.id}.ts`, item.source.replace('return probe;', 'return fetch(probe);'));
        for (const [file, source] of Object.entries(item.files ?? {})) fixture.write(file, source);
      }
      fixture.write(
        'http-ambient.d.ts',
        'declare module "express" { const express: { Router(): { get(path: string, handler: () => void): void } }; export default express; }',
      );
      fixture.write(
        'http-server.ts',
        'import express from "express";\nconst router = express.Router();\nfunction wrong() {}\nfunction right() {}\nrouter.get("/wrong", wrong);\nrouter.get("/right", right);\nrouter.get("/item/12", wrong);\nrouter.get("/item/3", right);\nrouter.get("/item/{}", wrong);\n',
      );
      const diagnostics = new Project({
        tsConfigFilePath: join(fixture.root, 'tsconfig.json'),
      }).getPreEmitDiagnostics();
      if (diagnostics.length)
        throw new Error(`Invalid public fixture: ${diagnostics.map((d) => d.getMessageText()).join('\n')}`);
      const runtime = join(output, '.public-runtime');
      mkdirSync(runtime, { recursive: true });
      for (const [file, source] of fixture.sources)
        if (!file.endsWith('.d.ts'))
          writeFileSync(
            join(runtime, file.replace(/\.ts$/, '.js')),
            ts.transpileModule(source, {
              compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
            }).outputText,
          );
      const executed = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '-e',
            `
      (async () => { const result = {}; for (const id of JSON.parse(process.argv[1])) {
        const paths = []; globalThis.fetch = async path => { paths.push(path); return path; };
        try { const value = await require(process.argv[2] + '/' + id + '.js').entry(); result[id] = { value, paths }; }
        catch (error) { result[id] = { throws: error.message, paths }; }
      } process.stdout.write(JSON.stringify(result)); })();
    `,
            JSON.stringify(cases.map((c) => c.id)),
            runtime,
          ],
          { encoding: 'utf8', timeout: 30_000 },
        ),
      );
      for (const c of cases)
        if (executed[c.id]?.value !== c.expected) throw new Error(`Wrong independent expectation: ${c.id}`);
      await fixture.index({ allowExpensiveRebuild: true });
      const db = fixture.open();
      let graph;
      try {
        graph = await collectRuntimeBoundaryGraph(db);
      } finally {
        db.close();
      }
      const rows = cases.map((c) => ({
        id: c.id,
        executed: executed[c.id],
        observations: graph.observations.filter((o) => o.source.file === `${c.id}.ts` && o.action === 'http.request'),
      }));
      const env = { ...process.env };
      delete env['SCIP_QUERY_CACHE_DIR'];
      delete env['SCIP_QUERY_SESSION'];
      const projections = [];
      for (const id of [
        'breadth-escape-factory-owner-reader',
        'breadth-escape-array-imported-reader',
        'breadth-path-addition',
        'breadth-template-addition',
        'breadth-positive-literal',
      ]) {
        const c = cases.find((c) => c.id === id)!;
        const line = c.source.split('\n').findIndex((t) => t.includes('/* probe */')) + 1;
        const packet = join(output, `${id}-runtime-cli.json`);
        execFileSync(
          process.execPath,
          [
            resolve('dist/cli.js'),
            'evidence',
            '--at',
            `${id}.ts:${line}`,
            '--edge',
            'runtime',
            '--direction',
            'both',
            '--depth',
            '1',
            '--max-edges',
            '100',
            '--full',
            '--json',
            '--json-output',
            packet,
          ],
          { cwd: fixture.root, env, encoding: 'utf8', timeout: 60_000 },
        );
        projections.push({ id, result: JSON.parse(readFileSync(packet, 'utf8')).result });
      }
      writeFileSync(
        join(output, 'breadth-public.json'),
        JSON.stringify({ rows, projections, links: graph.links, frontiers: graph.frontiers }, null, 2) + '\n',
      );
      console.log(
        `Recorded ${rows.length} independently executed HTTP cases and ${projections.length} built CLI runtime projections`,
      );
    } finally {
      await fixture.dispose();
    }
  },
  180_000,
);
