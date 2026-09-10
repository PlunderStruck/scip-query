import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ts } from '@ts-morph/common';
import { Project } from 'ts-morph';
import { it } from 'vitest';
import { IndexerHistoryFixture } from '../../tests/properties/indexer-history-fixture.js';
import { collectRuntimeBoundaryGraph } from '../../src/analysis/runtime-boundaries/graph.js';
import { exactClaimCases } from './exact-claim-cases.js';

it.skipIf(process.env['SCIP_QUERY_AUDIT_SCOPE'] !== 'exact-claims')(
  'records exact-claim failures through built CLI and HTTP consumers',
  async () => {
    const fixture = new IndexerHistoryFixture();
    const output = resolve(process.env['SCIP_QUERY_AUDIT_OUTPUT'] ?? '/tmp/scip-query-exact-claims');
    mkdirSync(output, { recursive: true });
    const calls = exactClaimCases.filter((c) =>
      [
        'exact-call-eval-function-write',
        'exact-call-eval-let-write',
        'exact-call-constructor-replaced-eval',
        'exact-call-decorated-constructor-0',
        'exact-call-decorated-constructor-1',
        'exact-call-decorated-constructor-2',
        'exact-call-alias-same-line',
        'exact-call-alias-multiple-lines',
      ].includes(c.id),
    );
    const values = exactClaimCases.filter((c) =>
      [
        'exact-value-control',
        'exact-value-imported-closure-writer',
        'exact-value-reflect-receiver',
        'exact-value-eval-property-write',
        'exact-value-destructure-getter',
        'exact-value-unary-coercion',
        'exact-value-initializer-spread',
      ].includes(c.id),
    );
    try {
      const configPath = join(fixture.root, 'tsconfig.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      delete config.compilerOptions.noLib;
      writeFileSync(configPath, JSON.stringify(config));
      writeFileSync(
        join(fixture.root, '.scipquery.json'),
        JSON.stringify({ dbPath: '.cache', watch: { enabled: false } }),
      );
      for (const item of [...calls, ...values]) {
        fixture.write(
          `${item.id}.ts`,
          item.value ? item.source.replace('return probe;', 'return fetch(probe);') : item.source,
        );
        for (const [file, source] of Object.entries(item.files ?? {})) fixture.write(file, source);
      }
      const diagnostics = new Project({ tsConfigFilePath: configPath })
        .getPreEmitDiagnostics()
        .map((d) => d.getMessageText());
      if (diagnostics.length) throw new Error(`Invalid public fixtures: ${JSON.stringify(diagnostics)}`);
      const runtime = join(fixture.root, '.public-runtime');
      mkdirSync(runtime);
      for (const [file, source] of fixture.sources)
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
            JSON.stringify(values.map((c) => c.id)),
            runtime,
          ],
          { encoding: 'utf8', timeout: 30_000 },
        ),
      );
      const esmRuntime = join(fixture.root, '.public-esm-runtime');
      mkdirSync(esmRuntime);
      writeFileSync(join(esmRuntime, 'package.json'), JSON.stringify({ type: 'module' }));
      for (const [file, source] of fixture.sources)
        writeFileSync(
          join(esmRuntime, file.replace(/\.ts$/, '.js')),
          ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
          }).outputText,
        );
      const nativeEsm = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
        import { pathToFileURL } from 'node:url';
        const result = {}; for (const id of JSON.parse(process.argv[1])) {
          const paths = []; globalThis.fetch = async path => { paths.push(path); return path; };
          try { const value = await (await import(pathToFileURL(process.argv[2] + '/' + id + '.js').href)).entry(); result[id] = { value, paths }; }
          catch (error) { result[id] = { throws: error.message, paths }; }
        } process.stdout.write(JSON.stringify(result));
      `,
            JSON.stringify([...values, ...calls].map((c) => c.id)),
            esmRuntime,
          ],
          { encoding: 'utf8', timeout: 30_000 },
        ),
      );
      for (const item of values)
        if (JSON.stringify(executed[item.id]) !== JSON.stringify(nativeEsm[item.id]))
          throw new Error(`CommonJS/ESM disagreement: ${item.id}`);
      for (const item of calls)
        if (nativeEsm[item.id]?.value !== item.expected) throw new Error(`Unexpected ESM callable result: ${item.id}`);
      await fixture.index({ allowExpensiveRebuild: true });
      const db = fixture.open();
      let runtimeGraph;
      try {
        runtimeGraph = await collectRuntimeBoundaryGraph(db);
      } finally {
        db.close();
      }
      const http = values.map((item) => ({
        id: item.id,
        expected: item.expected,
        executed: executed[item.id],
        observations: runtimeGraph.observations.filter(
          (o) => o.source.file === `${item.id}.ts` && o.action === 'http.request',
        ),
      }));
      const env = { ...process.env };
      delete env['SCIP_QUERY_CACHE_DIR'];
      delete env['SCIP_QUERY_SESSION'];
      const projections = [];
      for (const item of calls) {
        const line = item.source.split('\n').findIndex((text) => text.includes('/* probe */')) + 1;
        const path = join(fixture.cache, 'packet.json');
        execFileSync(
          process.execPath,
          [
            resolve('dist/cli.js'),
            'evidence',
            '--at',
            `${item.id}.ts:${line}`,
            '--edge',
            'execution',
            '--direction',
            'outgoing',
            '--depth',
            '1',
            '--max-edges',
            '100',
            '--full',
            '--json',
            '--json-output',
            path,
          ],
          { cwd: fixture.root, env, encoding: 'utf8', timeout: 60_000 },
        );
        projections.push({ id: item.id, graph: JSON.parse(readFileSync(path, 'utf8')).result.graph });
      }
      writeFileSync(
        join(output, 'exact-public.json'),
        JSON.stringify({ http, projections, nativeEsm }, null, 2) + '\n',
      );
      console.log(`Recorded ${http.length} HTTP consumers and ${projections.length} built CLI projections`);
    } finally {
      await fixture.dispose();
    }
  },
  180_000,
);
