import { selectEffectiveObjectField } from '../../source/ast/effective-object-field.js';
import { sourceBindingResolver } from '../../source/ast/source-binding-identity.js';
import type { SyntaxNode } from '../../source/ast/ast-types.js';
import { evaluateStaticValue } from '../../symbols/graph/static-value-flow.js';
import type { BoundaryFileContext } from './types.js';

/** Recognize an unshadowed platform fetch binding, rather than a same-named member or local. */
export function isPlatformFetch(context: BoundaryFileContext, call: SyntaxNode): boolean {
  const target = call.childForFieldName('function');
  if (
    !target ||
    !['fetch', 'globalThis.fetch', 'window.fetch', 'self.fetch'].includes(target.text.replace(/\s+/gu, ''))
  )
    return false;
  const bindings = sourceBindingResolver(context.file, context.root);
  return bindings.available && !bindings.hasLocalBinding(target);
}

export function effectiveObjectField(context: BoundaryFileContext, object: SyntaxNode | undefined, field: string) {
  return selectEffectiveObjectField(object, field, (key) => {
    const value = evaluateStaticValue(context, key);
    return value && ['literal', 'constant'].includes(value.evidence) && value.precision === 'literal'
      ? value.value
      : null;
  });
}

export function fetchRequestMethod(options: SyntaxNode | undefined, context: BoundaryFileContext): string | null {
  const field = effectiveObjectField(context, options, 'method');
  if (field.kind === 'absent') return 'GET';
  if (field.kind === 'unknown') return null;
  const value = evaluateStaticValue(context, field.node);
  return value && value.precision === 'literal' && ['literal', 'constant'].includes(value.evidence)
    ? value.value.toUpperCase()
    : null;
}
