import { ts } from '@ts-morph/common';

/** Compiler instrumentation is used only in a second execution, never in the indexed source. */
export function transpileWithCallTrace(source: string, file: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    transformers: {
      before: [
        (context) => (sourceFile) => {
          const factory = context.factory;
          function visit(node: ts.Node): ts.VisitResult<ts.Node> {
            const visited = ts.visitEachChild(node, visit, context);
            if (
              !ts.isFunctionDeclaration(node) &&
              !ts.isFunctionExpression(node) &&
              !ts.isArrowFunction(node) &&
              !ts.isMethodDeclaration(node) &&
              !ts.isConstructorDeclaration(node) &&
              !ts.isGetAccessorDeclaration(node) &&
              !ts.isSetAccessorDeclaration(node)
            )
              return visited;
            if (!node.body) return visited;
            const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            const end = sourceFile.getLineAndCharacterOfPosition(node.end);
            const observation = {
              file,
              startLine: start.line,
              startColumn: start.character,
              endLine: end.line,
              endColumn: end.character,
            };
            const record = factory.createExpressionStatement(
              factory.createCallExpression(
                factory.createPropertyAccessExpression(
                  factory.createPropertyAccessExpression(factory.createIdentifier('globalThis'), '__scipAuditTrace'),
                  'push',
                ),
                undefined,
                [
                  factory.createObjectLiteralExpression(
                    Object.entries(observation).map(([key, value]) =>
                      factory.createPropertyAssignment(
                        key,
                        typeof value === 'number'
                          ? factory.createNumericLiteral(value)
                          : factory.createStringLiteral(value),
                      ),
                    ),
                  ),
                ],
              ),
            );
            const current = visited as typeof node;
            const body = current.body!;
            const statements = ts.isBlock(body) ? [...body.statements] : [factory.createReturnStatement(body)];
            let directives = 0;
            while (
              directives < statements.length &&
              ts.isExpressionStatement(statements[directives]!) &&
              ts.isStringLiteral((statements[directives] as ts.ExpressionStatement).expression)
            )
              directives++;
            statements.splice(directives, 0, record);
            const block = factory.createBlock(statements, true);
            if (ts.isFunctionDeclaration(current))
              return factory.updateFunctionDeclaration(
                current,
                current.modifiers,
                current.asteriskToken,
                current.name,
                current.typeParameters,
                current.parameters,
                current.type,
                block,
              );
            if (ts.isFunctionExpression(current))
              return factory.updateFunctionExpression(
                current,
                current.modifiers,
                current.asteriskToken,
                current.name,
                current.typeParameters,
                current.parameters,
                current.type,
                block,
              );
            if (ts.isArrowFunction(current))
              return factory.updateArrowFunction(
                current,
                current.modifiers,
                current.typeParameters,
                current.parameters,
                current.type,
                current.equalsGreaterThanToken,
                block,
              );
            if (ts.isMethodDeclaration(current))
              return factory.updateMethodDeclaration(
                current,
                current.modifiers,
                current.asteriskToken,
                current.name,
                current.questionToken,
                current.typeParameters,
                current.parameters,
                current.type,
                block,
              );
            if (ts.isConstructorDeclaration(current))
              return factory.updateConstructorDeclaration(current, current.modifiers, current.parameters, block);
            if (ts.isGetAccessorDeclaration(current))
              return factory.updateGetAccessorDeclaration(
                current,
                current.modifiers,
                current.name,
                current.parameters,
                current.type,
                block,
              );
            return factory.updateSetAccessorDeclaration(
              current,
              current.modifiers,
              current.name,
              current.parameters,
              block,
            );
          }
          return ts.visitNode(sourceFile, visit) as ts.SourceFile;
        },
      ],
    },
  }).outputText;
}
