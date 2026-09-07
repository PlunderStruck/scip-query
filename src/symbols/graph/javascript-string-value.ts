import { ts } from '@ts-morph/common';
import type { SyntaxNode } from '../../source/ast/ast-types.js';

interface JavaScriptStringValue {
  value: string;
  interpolated: boolean;
}

const VALUES = new WeakMap<SyntaxNode, JavaScriptStringValue | null>();

/** Decode string syntax with the compiler; expressions in templates stay unknown. */
export function javaScriptStringValue(node: SyntaxNode): JavaScriptStringValue | null {
  if (node.type !== 'string' && node.type !== 'template_string') return null;
  if (VALUES.has(node)) return VALUES.get(node)!;
  const value = parseStringValue(node.text);
  VALUES.set(node, value);
  return value;
}

function parseStringValue(text: string): JavaScriptStringValue | null {
  // The compiler stores parser diagnostics on SourceFile even though the public
  // SourceFile interface omits them. Reject recovery trees, including invalid escapes.
  const source = ts.createSourceFile(
    'literal.ts',
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  ) as ts.SourceFile & {
    parseDiagnostics: readonly ts.Diagnostic[];
  };
  if (source.parseDiagnostics.length > 0 || source.statements.length !== 1) return null;
  const statement = source.statements[0]!;
  if (!ts.isExpressionStatement(statement)) return null;
  const expression = statement.expression;
  if (ts.isStringLiteralLike(expression)) return { value: expression.text, interpolated: false };
  if (!ts.isTemplateExpression(expression)) return null;
  return {
    value: expression.head.text + expression.templateSpans.map((span) => '{}' + span.literal.text).join(''),
    interpolated: true,
  };
}
