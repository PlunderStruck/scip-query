import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Project } from 'ts-morph';
import { ts } from '@ts-morph/common';
import { deserializeSCIP } from '@c4312/scip';
import { it } from 'vitest';
import { IndexerHistoryFixture } from '../../tests/properties/indexer-history-fixture.js';
import { getAllDefinitions } from '../../src/symbols/definition-catalog.js';
import { getAst } from '../../src/source/ast/ast-core.js';
import { sourceBindingResolver } from '../../src/source/ast/source-binding-identity.js';
import type { SyntaxNode } from '../../src/source/ast/ast-types.js';
import { cases } from './cases.js';
import { moduleCases } from './module-cases.js';

it('records raw producer and binding evidence for the discovered identity gaps', async () => {
  const output = resolve(process.env['SCIP_QUERY_AUDIT_OUTPUT'] ?? '/tmp/scip-query-ts-discovery');
  mkdirSync(output, { recursive: true });
  const fixture = new IndexerHistoryFixture();
  const selected = [...cases, ...moduleCases].filter((item) =>
    [
      'field-function',
      'getter-callable',
      'direct-write',
      'module-direct-import-write',
      'module-anonymous-default',
      'module-default-arrow',
    ].includes(item.id),
  );
  try {
    const configPath = join(fixture.root, 'tsconfig.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    delete config.compilerOptions.noLib;
    writeFileSync(configPath, JSON.stringify(config));
    for (const item of selected) {
      fixture.write(`${item.id}.ts`, item.source);
      for (const [file, source] of Object.entries(item.files ?? {})) fixture.write(file, source);
    }
    const project = new Project({ tsConfigFilePath: configPath });
    if (project.getPreEmitDiagnostics().length) throw new Error('Invalid diagnosis fixtures');
    await fixture.index({ allowExpensiveRebuild: true });
    const index = deserializeSCIP(readFileSync(join(fixture.cache, 'index.scip')));
    const db = fixture.open();
    try {
      const definitions = getAllDefinitions(db);
      const identities = index.documents
        .filter((doc) => selected.some((item) => doc.relativePath.startsWith(item.id)))
        .map((doc) => ({
          file: doc.relativePath,
          producerSymbols: doc.symbols.map((symbol) => symbol.symbol),
          producerOccurrences: doc.occurrences.map(({ symbol, range, symbolRoles }) => ({
            symbol,
            range,
            symbolRoles,
          })),
          catalog: definitions
            .filter((d) => d.relativePath === doc.relativePath)
            .map(({ symbol, leaf, startLine, startChar }) => ({ symbol, leaf, startLine, startChar })),
        }));
      const bindings = selected
        .filter((item) => ['direct-write', 'module-direct-import-write'].includes(item.id))
        .map((item) => {
          const file = `${item.id}.ts`;
          const root = getAst(db, file)!.rootNode;
          const walk = (node: SyntaxNode): SyntaxNode[] => [node, ...node.namedChildren.flatMap(walk)];
          const probe = walk(root).find(
            (node) =>
              node.type === 'member_expression' &&
              node.text === 'service.run' &&
              node.startPosition.row === item.source.split('\n').findIndex((line) => line.includes('/* probe */')),
          )!;
          const compiler = project.getSourceFileOrThrow(file).compilerNode;
          const checker = project.getTypeChecker().compilerObject;
          const identifiers: Array<Record<string, unknown>> = [];
          const visit = (node: ts.Node): void => {
            if (ts.isIdentifier(node) && node.text === 'service') {
              const symbol = checker.getSymbolAtLocation(node);
              identifiers.push({
                text: node.text,
                start: node.getStart(),
                valueDeclaration: symbol?.valueDeclaration ? ts.SyntaxKind[symbol.valueDeclaration.kind] : null,
                declarations: symbol?.declarations?.map((d) => ts.SyntaxKind[d.kind]) ?? [],
              });
            }
            ts.forEachChild(node, visit);
          };
          visit(compiler);
          return {
            id: item.id,
            hasObservedCallableWrite: sourceBindingResolver(file, root).hasObservedCallableWrite(probe),
            identifiers,
          };
        });
      writeFileSync(join(output, 'diagnosis.json'), JSON.stringify({ identities, bindings }, null, 2) + '\n');
      console.log(`Recorded ${identities.length} producer/catalog files and ${bindings.length} binding controls`);
    } finally {
      db.close();
    }
  } finally {
    await fixture.dispose();
  }
}, 120_000);
