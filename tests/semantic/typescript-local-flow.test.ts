import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeTypeScriptLocalFlow,
  type TypeScriptLocalFlowEdge,
  type TypeScriptLocalFlowPoint,
} from '../../src/semantic/typescript/local-flow.js';

const fixturePath = join(process.cwd(), 'tests/fixtures/typescript-local-flow/fixture.ts');
const source = readFileSync(fixturePath, 'utf8');

function pointAt(
  points: readonly TypeScriptLocalFlowPoint[],
  name: string,
  kind: TypeScriptLocalFlowPoint['kind'],
  line: number,
): TypeScriptLocalFlowPoint {
  const point = points.find(
    (candidate) => candidate.name === name && candidate.kind === kind && candidate.line === line,
  );
  expect(point, `${kind} ${name} at zero-based line ${line}`).toBeDefined();
  return point!;
}

function expectEdge(
  edges: readonly TypeScriptLocalFlowEdge[],
  kind: TypeScriptLocalFlowEdge['kind'],
  from: TypeScriptLocalFlowPoint,
  to: TypeScriptLocalFlowPoint,
  strength: TypeScriptLocalFlowEdge['strength'] = 'exact',
): void {
  expect(edges).toContainEqual(expect.objectContaining({ kind, fromPointId: from.id, toPointId: to.id, strength }));
}

describe('TypeScript local definition-use and control dependence', () => {
  it('meets the preregistered assignment, alias, argument, and return obligations', () => {
    const result = analyzeTypeScriptLocalFlow(source, fixturePath);

    const inputDefinition = pointAt(result.points, 'input', 'parameter-definition', 0);
    const inputUse = pointAt(result.points, 'input', 'use', 1);
    const currentDefinition = pointAt(result.points, 'current', 'definition', 1);
    const currentUse = pointAt(result.points, 'current', 'use', 2);
    const firstDefinition = pointAt(result.points, 'first', 'definition', 2);
    const firstUse = pointAt(result.points, 'first', 'use', 3);
    const reassignment = pointAt(result.points, 'current', 'definition', 3);
    const returned = pointAt(result.points, 'current', 'use', 4);

    expectEdge(result.edges, 'reaching-definition', inputDefinition, inputUse);
    expectEdge(result.edges, 'value-source', inputUse, currentDefinition);
    expectEdge(result.edges, 'reaching-definition', currentDefinition, currentUse);
    expectEdge(result.edges, 'value-source', currentUse, firstDefinition);
    expectEdge(result.edges, 'reaching-definition', firstDefinition, firstUse);
    expectEdge(result.edges, 'value-source', firstUse, reassignment);
    expectEdge(result.edges, 'reaching-definition', reassignment, returned);

    const argumentAliasDefinition = pointAt(result.points, 'alias', 'definition', 39);
    const argumentAliasUse = pointAt(result.points, 'alias', 'use', 40);
    expectEdge(result.edges, 'reaching-definition', argumentAliasDefinition, argumentAliasUse);
  });

  it('keeps both branch-reaching definitions and derives predicate control dependence', () => {
    const result = analyzeTypeScriptLocalFlow(source, fixturePath);
    const initial = pointAt(result.points, 'selected', 'definition', 8);
    const branch = pointAt(result.points, 'selected', 'definition', 10);
    const returned = pointAt(result.points, 'selected', 'use', 12);
    const predicate = pointAt(result.points, 'predicate', 'predicate', 9);

    expectEdge(result.edges, 'reaching-definition', initial, returned);
    expectEdge(result.edges, 'reaching-definition', branch, returned);
    expectEdge(result.edges, 'control-dependence', predicate, branch);
  });

  it('distinguishes closure and cross-callable field candidates from exact local flow', () => {
    const result = analyzeTypeScriptLocalFlow(source, fixturePath);
    const capturedDefinition = pointAt(result.points, 'input', 'parameter-definition', 20);
    const capturedUse = pointAt(result.points, 'input', 'use', 21);
    expectEdge(result.edges, 'closure-capture', capturedDefinition, capturedUse, 'candidate');

    const fieldDefinition = pointAt(result.points, 'this.value', 'definition', 29);
    const fieldUse = pointAt(result.points, 'this.value', 'use', 30);
    expectEdge(result.edges, 'reaching-definition', fieldDefinition, fieldUse);
    expect(result.coverage.status).toBe('partial');
    expect(result.coverage.unsupported).toContain(
      'Closure capture identity is known, but invocation order and intervening writes remain candidate flow.',
    );
  });

  it('orders same-statement aliases and preserves a property receiver use', () => {
    const result = analyzeTypeScriptLocalFlow(source, fixturePath);
    const inputDefinition = pointAt(result.points, 'input', 'parameter-definition', 43);
    const inputUse = pointAt(result.points, 'input', 'use', 44);
    const firstDefinition = pointAt(result.points, 'first', 'definition', 44);
    const firstUse = pointAt(result.points, 'first', 'use', 45);
    const secondDefinition = pointAt(result.points, 'second', 'definition', 45);
    const secondUse = pointAt(result.points, 'second', 'use', 46);

    expectEdge(result.edges, 'reaching-definition', inputDefinition, inputUse);
    expectEdge(result.edges, 'reaching-definition', firstDefinition, firstUse);
    expectEdge(result.edges, 'reaching-definition', secondDefinition, secondUse);
    expect(result.points).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'use', name: 'second.value', line: 46 })]),
    );
  });

  it('does not project exact reaching definitions through unsupported exceptional flow', () => {
    const result = analyzeTypeScriptLocalFlow(source, fixturePath);
    const selectedDefinition = result.points.find(
      (point) => point.kind === 'definition' && point.name === 'selected' && point.line > 47,
    );
    const selectedUse = result.points.find(
      (point) => point.kind === 'use' && point.name === 'selected' && point.line > 55,
    );
    expect(selectedDefinition).toBeDefined();
    expect(selectedUse).toBeDefined();
    expect(result.edges).not.toContainEqual(
      expect.objectContaining({
        kind: 'reaching-definition',
        fromPointId: selectedDefinition!.id,
        toPointId: selectedUse!.id,
      }),
    );
    expect(result.coverage.unsupported).toContain(
      'Exceptional control-flow and finally completion are not included in the local compiler CFG.',
    );
  });

  it('reports cross-callable field flow as a candidate instead of an exact local fact', () => {
    const result = analyzeTypeScriptLocalFlow(source, fixturePath);
    const definition = result.points.find(
      (point) => point.kind === 'definition' && point.name === 'this.value' && point.line > 59,
    );
    const use = result.points.find((point) => point.kind === 'use' && point.name === 'this.value' && point.line > 59);

    expect(definition).toBeDefined();
    expect(use).toBeDefined();
    expectEdge(result.edges, 'field-definition-to-use', definition!, use!, 'candidate');
    expect(result.coverage.unsupported).toContain(
      'Cross-callable field flow lacks receiver points-to and invocation-order analysis.',
    );
  });
});
