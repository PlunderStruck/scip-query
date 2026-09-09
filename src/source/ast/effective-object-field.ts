import type { SyntaxNode } from './ast-types.js';

export type EffectiveObjectField = { kind: 'absent' } | { kind: 'unknown' } | { kind: 'value'; node: SyntaxNode };

/** Resolve an object's final own field, retaining uncertainty when later spreads or computed keys may override it. */
export function selectEffectiveObjectField(
  object: SyntaxNode | undefined,
  field: string,
  evaluateKey: (node: SyntaxNode) => string | null,
): EffectiveObjectField {
  if (!object) return { kind: 'absent' };
  if (object.type !== 'object') return { kind: 'unknown' };
  let result: EffectiveObjectField = { kind: 'absent' };
  for (const member of object.namedChildren) {
    result = memberField(member, field, evaluateKey) ?? result;
  }
  return result;
}

/** Null leaves the previous field intact; unknown records a possible override. */
function memberField(
  member: SyntaxNode,
  field: string,
  evaluateKey: (node: SyntaxNode) => string | null,
): EffectiveObjectField | null {
  if (member.type === 'comment') return null;
  if (member.type === 'shorthand_property_identifier')
    return member.text === field ? { kind: 'value', node: member } : null;
  if (member.type !== 'pair') return { kind: 'unknown' };
  const key = member.childForFieldName('key');
  const name = fieldName(key, evaluateKey);
  if (name === null) return { kind: 'unknown' };
  if (name !== field) return null;
  const node = member.childForFieldName('value');
  return node ? { kind: 'value', node } : { kind: 'unknown' };
}

function fieldName(
  key: SyntaxNode | null | undefined,
  evaluateKey: (node: SyntaxNode) => string | null,
): string | null {
  if (!key) return null;
  return key.type === 'property_identifier' ? key.text : evaluateKey(key);
}
