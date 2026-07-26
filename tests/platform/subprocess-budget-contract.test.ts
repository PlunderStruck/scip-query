import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();
const SOURCE_ROOT = join(PROJECT_ROOT, 'src');
const REVIEW_MARKER = 'scip-query: process-lifetime-reviewed';
const FINITE_CALLEES = new Set(['execFile', 'execFileSync', 'spawnSync']);
const SESSION_CALLEES = new Set(['spawn', 'fork']);

interface ProcessBoundaryViolation {
  file: string;
  line: number;
  callee: string;
  reason: string;
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(path);
    }
  };
  visit(root);
  return out.sort();
}

function importedChildProcessCallees(sourceFile: ts.SourceFile): Map<string, string> {
  const imported = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== 'node:child_process'
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      imported.set(specifier.name.text, specifier.propertyName?.text ?? specifier.name.text);
    }
  }
  return imported;
}

function objectHasTimeout(expression: ts.Expression | undefined): boolean {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      property.name.getText() === 'timeout',
  );
}

function hasReviewedSessionMarker(source: string, node: ts.Node): boolean {
  const prefix = source.slice(Math.max(0, node.getFullStart() - 500), node.getStart());
  return prefix.includes(REVIEW_MARKER);
}

function processBoundaryViolations(file: string, source: string): ProcessBoundaryViolation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imported = importedChildProcessCallees(sourceFile);
  const violations: ProcessBoundaryViolation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = imported.get(node.expression.text);
      if (callee && (FINITE_CALLEES.has(callee) || SESSION_CALLEES.has(callee))) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (FINITE_CALLEES.has(callee) && !objectHasTimeout(node.arguments[2])) {
          violations.push({
            file,
            line,
            callee,
            reason: 'finite subprocess call has no inline timeout budget',
          });
        }
        if (SESSION_CALLEES.has(callee) && !hasReviewedSessionMarker(source, node)) {
          violations.push({
            file,
            line,
            callee,
            reason: `session subprocess has no "${REVIEW_MARKER}" ownership annotation`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

describe('subprocess budget contract', () => {
  it('rejects a newly introduced finite child process with no deadline', () => {
    const fixture = [
      "import { execFileSync } from 'node:child_process';",
      "execFileSync('git', ['status'], { encoding: 'utf8' });",
    ].join('\n');

    expect(processBoundaryViolations('fixture.ts', fixture)).toEqual([
      expect.objectContaining({
        callee: 'execFileSync',
        reason: expect.stringContaining('no inline timeout'),
      }),
    ]);
  });

  it('requires every production child boundary to have a finite budget or an exact lifetime-owner review', () => {
    const violations = sourceFiles(SOURCE_ROOT).flatMap((file) =>
      processBoundaryViolations(relative(PROJECT_ROOT, file), readFileSync(file, 'utf8')),
    );
    expect(violations).toEqual([]);
  });
});
