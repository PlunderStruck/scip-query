import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { ts } from '@ts-morph/common';
import { Project } from 'ts-morph';
import { IndexerHistoryFixture } from '../../tests/properties/indexer-history-fixture.js';
import { getSourceFacts } from '../../src/source/facts/source-facts.js';
import { getAst } from '../../src/source/ast/ast-core.js';
import { evaluateStaticValue } from '../../src/symbols/graph/static-value-flow.js';
import {
  scipOccurrenceCallTargetsForRange,
  scipOccurrenceTargetsForFile,
} from '../../src/symbols/graph/scip-occurrence-call-targets.js';
import { graphEvidence } from '../../src/queries/graph/graph-evidence.js';
import type { SyntaxNode } from '../../src/source/ast/ast-types.js';
import type { IndexedDefinition } from '../../src/domain/types.js';
import { cases as baseCases } from './cases.js';
import { moduleCases } from './module-cases.js';
import { flowCases } from './flow-cases.js';
import { invariantCases } from './invariant-cases.js';
import { exactClaimCases } from './exact-claim-cases.js';
import { breadthCases } from './breadth-cases.js';
import { transpileWithCallTrace } from './runtime-call-trace.js';

const originalCases = [...baseCases, ...moduleCases, ...flowCases, ...invariantCases];
const scope = process.env['SCIP_QUERY_AUDIT_SCOPE'];
const cases =
  scope === 'breadth'
    ? breadthCases
    : scope === 'exact-claims'
      ? exactClaimCases
      : scope === 'all-claims'
        ? [...originalCases, ...exactClaimCases]
        : originalCases;

const output = resolve(process.env['SCIP_QUERY_AUDIT_OUTPUT'] ?? '/tmp/scip-query-ts-discovery');
mkdirSync(output, { recursive: true });
const fixture = new IndexerHistoryFixture();
const config = {
  compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, types: [] },
  include: ['*.ts'],
};
writeFileSync(join(fixture.root, 'tsconfig.json'), JSON.stringify(config));
writeFileSync(join(fixture.root, '.scipquery.json'), JSON.stringify({ dbPath: '.cache', watch: { enabled: false } }));

function program() {
  // ts-morph supplies the bundled compiler's own virtual standard libraries.
  // The unrelated top-level TypeScript package may have a different version.
  return new Project({ tsConfigFilePath: join(fixture.root, 'tsconfig.json') }).getProgram().compilerObject;
}
function diagnostics(p: ts.Program) {
  return ts.getPreEmitDiagnostics(p).map((d) => ({
    file: d.file ? relative(fixture.root, d.file.fileName) : null,
    line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null,
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  }));
}
function save(name: string, value: unknown) {
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
}
function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}
function sourceNodes(node: SyntaxNode): SyntaxNode[] {
  return [node, ...node.namedChildren.flatMap(sourceNodes)];
}
function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  )
    node = node.expression;
  return node;
}
function targetToken(node: ts.Node): ts.Node | null {
  const expression =
    ts.isCallExpression(node) || ts.isNewExpression(node)
      ? node.expression
      : ts.isTaggedTemplateExpression(node)
        ? node.tag
        : null;
  if (!expression) return null;
  const target = unwrap(expression);
  return ts.isPropertyAccessExpression(target)
    ? target.name
    : ts.isElementAccessExpression(target)
      ? unwrap(target.argumentExpression)
      : target;
}
function declarationIdentity(node: ts.Declaration) {
  const source = node.getSourceFile();
  const start = source.getLineAndCharacterOfPosition(node.getStart());
  const end = source.getLineAndCharacterOfPosition(node.end);
  return {
    file: relative(fixture.root, source.fileName),
    line: start.line,
    column: start.character,
    endLine: end.line,
    endColumn: end.character,
  };
}
function literalReturn(p: ts.Program, definition: IndexedDefinition): unknown {
  const source = p.getSourceFile(join(fixture.root, definition.relativePath));
  if (!source) return undefined;
  let result: unknown;
  walk(source, (node) => {
    if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node)) return;
    if (
      node.name?.getText() !== definition.leaf ||
      source.getLineAndCharacterOfPosition(node.getStart()).line !== definition.startLine
    )
      return;
    const start = source.getLineAndCharacterOfPosition(node.getStart());
    const end = source.getLineAndCharacterOfPosition(node.end);
    if (start.character < (definition.startChar ?? 0) || end.line > definition.endLine) return;
    if (end.line === definition.endLine && definition.endChar && end.character > definition.endChar) return;
    const statements = node.body?.statements;
    if (statements?.length !== 1 || !ts.isReturnStatement(statements[0]!)) return;
    const value = statements[0]!.expression;
    if (value && ts.isNumericLiteral(value)) result = Number(value.text);
    if (value && ts.isStringLiteral(value)) result = value.text;
  });
  return result;
}

try {
  for (const item of cases) {
    fixture.write(`${item.id}.ts`, item.source);
    for (const [file, source] of Object.entries(item.files ?? {})) fixture.write(file, source);
  }
  let p = program();
  const invalid = diagnostics(p);
  save('diagnostics.json', invalid);
  const invalidFiles = new Set(invalid.map((d) => d.file));
  const validCases = cases.filter(
    (item) => ![`${item.id}.ts`, ...Object.keys(item.files ?? {})].some((file) => invalidFiles.has(file)),
  );
  for (const item of cases.filter((item) => !validCases.includes(item))) {
    fixture.write(`${item.id}.ts`, null);
    for (const file of Object.keys(item.files ?? {})) fixture.write(file, null);
  }
  p = program();
  const remainingDiagnostics = diagnostics(p);
  if (remainingDiagnostics.length)
    throw new Error(`Shared fixture diagnostics: ${JSON.stringify(remainingDiagnostics)}`);
  console.log(
    `Compiler-valid cases: ${validCases.length}/${cases.length}; excluded invalid fixtures: ${cases.length - validCases.length}`,
  );
  const runtime = join(scope === 'breadth' ? output : fixture.root, '.runtime');
  mkdirSync(runtime, { recursive: true });
  for (const [file, source] of fixture.sources)
    writeFileSync(
      join(runtime, file.replace(/\.ts$/, '.js')),
      ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText,
    );
  const runtimeResults = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        `
    (async () => { const results = {}; for (const id of JSON.parse(process.argv[1])) { try { const value = await require(process.argv[2] + '/' + id + '.js').entry(); results[id] = { value: value === undefined ? { undefined: true } : value }; } catch (error) { results[id] = { throws: error.message }; } } process.stdout.write(JSON.stringify(results)); })();
  `,
        JSON.stringify(validCases.map((item) => item.id)),
        runtime,
      ],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    ),
  );
  save('runtime.json', runtimeResults);

  const tracedRuntime: Record<
    string,
    {
      result: unknown;
      trace: Array<{ file: string; startLine: number; startColumn: number; endLine: number; endColumn: number }>;
    }
  > = {};
  if (validCases.some((item) => item.traceCallee)) {
    const traced = join(scope === 'breadth' ? output : fixture.root, '.runtime-traced');
    mkdirSync(traced, { recursive: true });
    for (const [file, source] of fixture.sources)
      writeFileSync(join(traced, file.replace(/\.ts$/, '.js')), transpileWithCallTrace(source, file));
    Object.assign(
      tracedRuntime,
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            '-e',
            `
        (async () => { const results = {}; for (const id of JSON.parse(process.argv[1])) {
          globalThis.__scipAuditTrace = [];
          let result; try { const value = await require(process.argv[2] + '/' + id + '.js').entry(); result = { value: value === undefined ? { undefined: true } : value }; }
          catch (error) { result = { throws: error.message }; }
          results[id] = { result, trace: globalThis.__scipAuditTrace };
        } process.stdout.write(JSON.stringify(results)); })();
      `,
            JSON.stringify(validCases.filter((item) => item.traceCallee).map((item) => item.id)),
            traced,
          ],
          { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
        ),
      ),
    );
    for (const [id, observation] of Object.entries(tracedRuntime))
      if (JSON.stringify(observation.result) !== JSON.stringify(runtimeResults[id]))
        throw new Error(`Instrumentation changed execution: ${id}`);
    save('runtime-call-traces.json', tracedRuntime);
  }
  await fixture.index({ allowExpensiveRebuild: true });
  save('index-status.json', fixture.statuses);
  save('cases.json', validCases);
  copyFileSync(join(fixture.cache, 'index.scip'), join(output, 'index.scip'));
  const db = fixture.open();
  const checker = p.getTypeChecker();
  const results: Array<Record<string, unknown>> = [];
  try {
    for (const item of validCases) {
      const file = `${item.id}.ts`;
      const source = p.getSourceFile(join(fixture.root, file))!;
      const line = item.source.split('\n').findIndex((text) => text.includes('/* probe */'));
      const calls: ts.Node[] = [];
      let wholeFileInvocations = 0;
      walk(source, (node) => {
        if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node))
          wholeFileInvocations++;
        if (
          (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) &&
          source.getLineAndCharacterOfPosition(node.getStart()).line === line
        )
          calls.push(node);
      });
      const facts = getSourceFacts(db, file);
      const inventory = facts?.callSites.filter((site) => site.line === line) ?? [];
      const resolved = scipOccurrenceCallTargetsForRange(db, file, line, line);
      const refs = scipOccurrenceTargetsForFile(db, file);
      const compilerChecks = calls.flatMap((call) => {
        const token = targetToken(call);
        if (
          !token ||
          (!ts.isIdentifier(token) &&
            !ts.isPrivateIdentifier(token) &&
            !ts.isStringLiteralLike(token) &&
            !ts.isNumericLiteral(token))
        )
          return [];
        let symbol = checker.getSymbolAtLocation(token);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const expected = symbol?.declarations?.map(declarationIdentity).filter((d) => !d.file.startsWith('..')) ?? [];
        if (!expected.length) return [];
        const start = source.getLineAndCharacterOfPosition(token.getStart());
        const end = source.getLineAndCharacterOfPosition(token.end);
        const actual =
          refs?.targets
            .filter(
              (t) =>
                t.sourceRange?.startLine === start.line &&
                t.sourceRange.startColumn === start.character &&
                t.sourceRange.endLine === end.line &&
                t.sourceRange.endColumn === end.character,
            )
            .map((t) => ({
              file: t.definition.relativePath,
              line: t.definition.startLine,
              column: t.definition.startChar ?? 0,
              endLine: t.definition.endLine,
              endColumn: t.definition.endChar ?? 0,
              symbol: t.definition.symbol,
            })) ?? [];
        return [
          {
            token: token.getText(),
            expected,
            actual,
            matched: expected.some((d) => actual.some((a) => a.file === d.file && a.line === d.line)),
            rangeMatched: expected.some((d) =>
              actual.some(
                (a) =>
                  a.file === d.file &&
                  (a.line > d.line || (a.line === d.line && a.column >= d.column)) &&
                  (a.endLine < d.endLine || (a.endLine === d.endLine && a.endColumn <= d.endColumn)),
              ),
            ),
          },
        ];
      });
      const actualRuntime = runtimeResults[item.id];
      const expectedRuntime =
        item.expected && typeof item.expected === 'object' && 'throws' in item.expected
          ? item.expected
          : { value: item.expected };
      const runtimeMatches = JSON.stringify(actualRuntime) === JSON.stringify(expectedRuntime);
      const contradictions =
        calls.length === 1 && !item.value
          ? resolved.targets.flatMap((target) => {
              const value = literalReturn(p, target.definition);
              return value !== undefined && JSON.stringify(value) !== JSON.stringify(actualRuntime?.value)
                ? [
                    {
                      symbol: target.definition.symbol,
                      declarationReturns: value,
                      observed: actualRuntime,
                      implementationStatus: target.implementationStatus,
                    },
                  ]
                : [];
            })
          : [];
      let evaluated: unknown = null;
      if (item.value) {
        const root = getAst(db, file)!.rootNode;
        const probe = sourceNodes(root).find(
          (node) => node.type === 'variable_declarator' && node.childForFieldName('name')?.text === 'probe',
        );
        evaluated = evaluateStaticValue({ db, file, root }, probe?.childForFieldName('value'));
      }
      const graph = graphEvidence(
        db,
        { locations: [`${file}:${line + 1}`] },
        { families: ['execution'], direction: 'outgoing', maxDepth: 1, maxEdges: 100 },
      );
      const flow = item.flow
        ? graphEvidence(
            db,
            { symbols: [`scip-typescript npm history-fixture 1.0.0 \`${file}\`/entry().`] },
            { families: ['dataflow'], direction: 'outgoing', maxDepth: 3, maxEdges: 200 },
          )
        : null;
      const candidate = {
        id: item.id,
        area: item.area,
        source: item.source,
        required: !!item.required,
        expectedRuntime,
        actualRuntime,
        runtimeMatches,
        tracedRuntime: tracedRuntime[item.id] ?? null,
        invocationCount: calls.length,
        sourceInvocationCount: inventory.length,
        wholeFileInvocations,
        wholeFileSourceInvocations: facts?.callSites.length ?? 0,
        compilerChecks,
        targets: resolved.targets.map((t) => ({
          symbol: t.definition.symbol,
          leaf: t.definition.leaf,
          isFunctionLike: t.definition.isFunctionLike,
          declarationReturns: literalReturn(p, t.definition),
          implementationStatus: t.implementationStatus,
          implementationReason: t.implementationReason,
          location: {
            file: t.definition.relativePath,
            startLine: t.definition.startLine,
            startColumn: t.definition.startChar,
            endLine: t.definition.endLine,
            endColumn: t.definition.endChar,
          },
        })),
        unresolved: resolved.unresolvedCallsites,
        contradictions,
        evaluated,
        flow: flow
          ? {
              expected: item.flow,
              transfers: flow.edges.filter((e) => e.subtype === 'argument-to-parameter'),
              coverage: flow.coverage,
            }
          : null,
        graph: { edges: graph.edges, coverage: graph.coverage },
      };
      results.push(candidate);
      if (results.length % 50 === 0) console.log(`Analyzed ${results.length}/${validCases.length}`);
    }
  } finally {
    db.close();
  }
  save('results.json', results);
  const summary = {
    cases: cases.length,
    valid: validCases.length,
    invalid: invalidFiles.size,
    runtimeExpectationFailures: results.filter((r) => !r.runtimeMatches).map((r) => r.id),
    invocationMismatches: results.filter((r) => r.invocationCount !== r.sourceInvocationCount).map((r) => r.id),
    declarationMismatches: results
      .filter((r) => (r.compilerChecks as Array<{ matched: boolean }>).some((c) => !c.matched))
      .map((r) => r.id),
    declarationRangeMismatches: results
      .filter((r) => (r.compilerChecks as Array<{ rangeMatched: boolean }>).some((c) => !c.rangeMatched))
      .map((r) => r.id),
    contradictedTargets: results.filter((r) => (r.contradictions as unknown[]).length).map((r) => r.id),
    contradictedValues: results
      .filter((r) => {
        const value = r.evaluated as { precision?: string; value?: unknown } | null;
        return (
          value?.precision === 'literal' &&
          JSON.stringify(value.value) !== JSON.stringify((r.actualRuntime as { value?: unknown }).value)
        );
      })
      .map((r) => r.id),
    requiredUnresolved: results.filter((r) => r.required && !(r.targets as unknown[]).length).map((r) => r.id),
    unresolved: results.filter((r) => (r.unresolved as number) > 0).map((r) => r.id),
  };
  save('summary.json', summary);
  console.log(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(summary).map(([key, value]) => [key, Array.isArray(value) ? value.length : value]),
      ),
      null,
      2,
    ),
  );
} finally {
  await fixture.dispose();
}
