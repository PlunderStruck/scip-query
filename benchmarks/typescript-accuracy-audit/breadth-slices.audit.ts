import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ts } from '@ts-morph/common';
import { Project } from 'ts-morph';
import { it } from 'vitest';
import { IndexerHistoryFixture } from '../../tests/properties/indexer-history-fixture.js';
import { dependenceSlice } from '../../src/queries/graph/dependence-slice.js';

const cases = [
  ['straight', 'let value = input;'],
  ['overwrite', 'let value = other; value = input;'],
  ['conditional', 'let value = other; if (input > 3) value = input;'],
  ['switch', 'let value = other; switch (input) { case 2: value = 10; break; default: value = 20; }'],
  ['fallthrough', 'let value = other; switch (input) { case 2: value = 10; default: value += input; }'],
  ['try-finally', 'let value = other; try { value = 0; } finally { value = input; }'],
  ['try-catch', 'let value = other; try { if (input > 3) throw input; } catch (error) { value = error as number; }'],
  ['loop-break', 'let value = other; for (let i=0;i<3;i++) { value = input; break; }'],
  ['loop-continue', 'let value = other; for (let i=0;i<3;i++) { if (i === 0) continue; value += input; }'],
  ['do-while', 'let value = 0; do { value += input; } while (false);'],
  ['while', 'let value = 0; let i=0; while (i++ < 2) { value += input; }'],
  ['for-of', 'let value = 0; for (const item of [input, other]) value += item;'],
  ['for-in', 'let value = 0; const items = { [String(input)]: other }; for (const key in items) value += Number(key);'],
  ['closure', 'let value = other; function update() { value = input; } update();'],
  ['arrow', 'let value = other; (() => { value = input; })();'],
  ['getter', 'let value = other; const obj = { get x() { value = input; return 0; } }; void obj.x;'],
  ['setter', 'let value = other; const obj = { set x(v: number) { value = v; } }; obj.x = input;'],
  ['class-initializer', 'let value = other; class C { x = (value = input); } new C();'],
  ['static-initializer', 'let value = other; class C { static x = (value = input); } void C;'],
  ['static-block', 'let value = other; class C { static { value = input; } } void C;'],
  ['destructure-declaration', 'const { value } = { value: input };'],
  ['destructure-assignment', 'let value = other; ({ value } = { value: input });'],
  ['array-destructure', 'let value = other; [value] = [input];'],
  ['destructure-default', 'const obj: { value?: number } = {}; const { value = input } = obj;'],
  ['logical-assignment', 'let value = 0; value ||= input;'],
  ['nullish-assignment', 'let value: number | null = null; value ??= input;'],
  ['conditional-assignment', 'let value = other; input > 3 ? value = input : value = 0;'],
  ['sequence', 'let value = other; (value = 0, value = input);'],
  ['postfix', 'let value = input; const discarded = value++; void discarded;'],
  ['eval', 'let value = other; eval("value = input");'],
  ['tag', 'let value = other; function tag(_parts: TemplateStringsArray) { value = input; } tag`x`;'],
  ['object-coercion', 'let value = other; const obj = { valueOf() { value = input; return 1; } }; void +obj;'],
  ['iterator', 'let value = other; const obj = { *[Symbol.iterator]() { value = input; yield 0; } }; [...obj];'],
  ['reflect', 'let value = other; Reflect.apply(() => { value = input; }, null, []);'],
] as const;

it.skipIf(process.env['SCIP_QUERY_AUDIT_SCOPE'] !== 'breadth')(
  'compares complete slice claims with independently observed input influence',
  async () => {
    const fixture = new IndexerHistoryFixture();
    const output = resolve(process.env['SCIP_QUERY_AUDIT_OUTPUT'] ?? '/tmp/scip-query-breadth-audit/corpus');
    mkdirSync(output, { recursive: true });
    try {
      const config = JSON.parse(readFileSync(join(fixture.root, 'tsconfig.json'), 'utf8'));
      delete config.compilerOptions.noLib;
      writeFileSync(join(fixture.root, 'tsconfig.json'), JSON.stringify(config));
      writeFileSync(
        join(fixture.root, '.scipquery.json'),
        JSON.stringify({ dbPath: '.cache', watch: { enabled: false } }),
      );
      for (const [id, body] of cases)
        fixture.write(`slice-${id}.ts`, `export function entry(input = 2, other = 11) {\n${body}\nreturn value;\n}`);
      const diagnostics = new Project({
        tsConfigFilePath: join(fixture.root, 'tsconfig.json'),
      }).getPreEmitDiagnostics();
      if (diagnostics.length)
        throw new Error(`Invalid slice fixture: ${diagnostics.map((d) => d.getMessageText()).join('\n')}`);
      const runtime = join(output, '.slice-runtime');
      mkdirSync(runtime, { recursive: true });
      for (const [file, source] of fixture.sources)
        writeFileSync(
          join(runtime, file.replace(/\.ts$/, '.js')),
          ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
          }).outputText,
        );
      const executions = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '-e',
            `
      const out = {}; for (const id of JSON.parse(process.argv[1])) { const f = require(process.argv[2] + '/slice-' + id + '.js').entry; out[id] = [[2,11],[5,11],[2,17]].map(args => f(...args)); }
      process.stdout.write(JSON.stringify(out));
    `,
            JSON.stringify(cases.map((c) => c[0])),
            runtime,
          ],
          { encoding: 'utf8', timeout: 30_000 },
        ),
      );
      await fixture.index({ allowExpensiveRebuild: true });
      const db = fixture.open();
      const rows = [];
      try {
        for (const [id, body] of cases) {
          const result = dependenceSlice(db, `slice-${id}.ts:3`, { variable: 'value' });
          const observed = executions[id] as number[];
          const influenced = ['input', 'other'].filter((_, i) => observed[0] !== observed[i + 1]);
          const represented = new Set(
            result.points.filter((p) => p.kind === 'parameter-definition').map((p) => p.name),
          );
          rows.push({
            id,
            body,
            executions: observed,
            influenced,
            missingInfluence: influenced.filter((p) => !represented.has(p)),
            result,
          });
        }
      } finally {
        db.close();
      }
      const env = { ...process.env };
      delete env['SCIP_QUERY_CACHE_DIR'];
      delete env['SCIP_QUERY_SESSION'];
      const projections = [];
      for (const id of ['straight', 'switch', 'getter', 'static-block', 'eval']) {
        const path = join(output, `slice-${id}-cli.json`);
        execFileSync(
          process.execPath,
          [
            resolve('dist/cli.js'),
            'dependence-slice',
            `slice-${id}.ts:3`,
            '--variable',
            'value',
            '--json',
            '--json-output',
            path,
          ],
          { cwd: fixture.root, env, encoding: 'utf8', timeout: 60_000 },
        );
        projections.push({ id, result: JSON.parse(readFileSync(path, 'utf8')).result });
      }
      writeFileSync(join(output, 'breadth-slices.json'), JSON.stringify({ rows, projections }, null, 2) + '\n');
      console.log(
        `Recorded ${rows.length} slice probes; complete slices missing exercised influences: ${rows.filter((r) => r.result.coverage.status === 'complete' && r.missingInfluence.length).length}`,
      );
    } finally {
      await fixture.dispose();
    }
  },
  180_000,
);
