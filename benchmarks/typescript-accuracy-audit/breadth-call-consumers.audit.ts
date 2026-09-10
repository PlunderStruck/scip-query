import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Project } from 'ts-morph';
import { it } from 'vitest';
import { IndexerHistoryFixture } from '../../tests/properties/indexer-history-fixture.js';
import { scipOccurrenceCallTargetsForRange } from '../../src/symbols/graph/scip-occurrence-call-targets.js';
import { exactClaimCases } from './exact-claim-cases.js';
import { breadthCases } from './breadth-cases.js';

it.skipIf(process.env['SCIP_QUERY_AUDIT_SCOPE'] !== 'breadth')(
  'compares call implementation qualifications across public consumers',
  async () => {
    const fixture = new IndexerHistoryFixture();
    const output = resolve(process.env['SCIP_QUERY_AUDIT_OUTPUT'] ?? '/tmp/scip-query-breadth-audit/isolated');
    mkdirSync(output, { recursive: true });
    const cases = [
      ...breadthCases.filter((c) => c.area === 'breadth-call'),
      ...exactClaimCases.filter((c) => c.area === 'exact-call'),
    ];
    try {
      const config = JSON.parse(readFileSync(join(fixture.root, 'tsconfig.json'), 'utf8'));
      delete config.compilerOptions.noLib;
      writeFileSync(join(fixture.root, 'tsconfig.json'), JSON.stringify(config));
      writeFileSync(
        join(fixture.root, '.scipquery.json'),
        JSON.stringify({ dbPath: '.cache', watch: { enabled: false } }),
      );
      for (const item of cases) {
        fixture.write(`${item.id}.ts`, item.source);
        for (const [file, source] of Object.entries(item.files ?? {})) fixture.write(file, source);
      }
      const diagnostics = new Project({
        tsConfigFilePath: join(fixture.root, 'tsconfig.json'),
      }).getPreEmitDiagnostics();
      if (diagnostics.length) throw new Error('Invalid call consumer fixtures');
      await fixture.index({ allowExpensiveRebuild: true });
      const env = { ...process.env };
      delete env['SCIP_QUERY_CACHE_DIR'];
      delete env['SCIP_QUERY_SESSION'];
      const rows = [];
      const db = fixture.open();
      try {
        for (const item of cases) {
          const line = item.source.split('\n').findIndex((t) => t.includes('/* probe */'));
          const sourceTargets = scipOccurrenceCallTargetsForRange(db, `${item.id}.ts`, line, line).targets.map((t) => ({
            symbol: t.definition.symbol,
            implementationStatus: t.implementationStatus,
            reason: t.implementationReason,
          }));
          const graphPath = join(output, `${item.id}-call-graph.json`);
          execFileSync(
            process.execPath,
            [
              resolve('dist/cli.js'),
              'call-graph',
              `scip-typescript npm history-fixture 1.0.0 \`${item.id}.ts\`/entry().`,
              '--json',
              '--json-output',
              graphPath,
            ],
            { cwd: fixture.root, env, encoding: 'utf8', timeout: 60_000 },
          );
          const graph = JSON.parse(readFileSync(graphPath, 'utf8')).result;
          rows.push({ id: item.id, expected: item.expected, sourceTargets, graph });
        }
      } finally {
        db.close();
      }
      writeFileSync(join(output, 'breadth-call-consumers.json'), JSON.stringify({ rows }, null, 2) + '\n');
      console.log(`Compared ${rows.length} call-graph consumers with qualified source targets`);
    } finally {
      await fixture.dispose();
    }
  },
  180_000,
);
