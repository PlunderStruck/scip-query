import { describe, expect, it } from 'vitest';
import { nodesOfTypes } from '../../src/source/ast/ast-node-index.js';
import { parseAstSource } from '../../src/source/ast/ast-runtime.js';

const source = `
const registry = { name: 'first', run: () => start() };
function start() {
  finish('a');
  const nested = { name: 'second' };
  return nested;
}
finish('b');
`;

describe('per-root node type index', () => {
  it('answers indexed type scans in document order, matching a direct scan', () => {
    const tree = parseAstSource('typescript', source);
    expect(tree).not.toBeNull();
    const root = tree!.rootNode;

    for (const request of [['call_expression'], ['pair'], ['pair', 'call_expression']] as const) {
      const indexed = nodesOfTypes(root, [...request]).map((node) => [node.type, node.startIndex]);
      const direct = root.descendantsOfType([...request]).map((node) => [node.type, node.startIndex]);
      expect(indexed).toEqual(direct);
    }
  });

  it('confines a subtree scan to the subtree', () => {
    const tree = parseAstSource('typescript', source);
    const root = tree!.rootNode;
    const fn = nodesOfTypes(root, 'call_expression').find((node) => node.text.startsWith('start'))!;
    const startFn = root
      .descendantsOfType('function_declaration')
      .find((node) => node.text.includes('function start'))!;

    const calls = nodesOfTypes(startFn, 'call_expression');
    expect(calls.map((node) => node.text)).toEqual(["finish('a')"]);
    expect(fn).toBeDefined();
  });

  it('falls back to a direct scan for unindexed types', () => {
    const tree = parseAstSource('typescript', source);
    const root = tree!.rootNode;
    expect(nodesOfTypes(root, 'function_declaration').map((node) => node.type)).toEqual(['function_declaration']);
  });
});
