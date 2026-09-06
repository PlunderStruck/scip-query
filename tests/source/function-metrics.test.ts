import { describe, expect, it } from 'vitest';
import { analyzeSourceFunctions } from '../../src/source/ast/function-metrics.js';

const measure = (source: string) => analyzeSourceFunctions('code.ts', source).functions;

describe('current-source function metrics', () => {
  it('measures decisions and nesting independently for each function', () => {
    const [outer, inner] = measure(`function outer(xs: number[]) {
      for (const x of xs) { if (x > 0 && x < 10) { while (ready()) consume(x); } }
      function inner(x: boolean) { if (x) return 1; else return 2; }
    }`);
    expect(outer).toMatchObject({ cyclomatic: 5, cognitive: 7 });
    expect(inner).toMatchObject({ name: 'outer.inner', cyclomatic: 2, cognitive: 2 });
    expect(outer!.contributions.every((part) => part.line > 0 && part.column > 0)).toBe(true);
  });

  it('counts switch cases, catch, ternary, nullish and else-if explicitly', () => {
    const [fn] = measure(`function choose(x: number) {
      if (x) return x ?? 0; else if (x === 0) return x ? 1 : 2;
      try { switch(x) { case 1: return 1; case 2: return 2; default: return 0; } }
      catch { return -1; }
    }`);
    expect(fn).toMatchObject({ cyclomatic: 8, cognitive: 6 });
  });

  it('preserves values and property names in duplicate evidence', () => {
    const a = measure('function one(x) { const y = x + 1; return { result: y, label: "allow" }; }')[0]!;
    const b = measure(
      'function two(input) { const output = input + 1; return { result: output, label: "allow" }; }',
    )[0]!;
    const c = measure('function one(x) { const y = x + 1; return { result: y, label: "deny" }; }')[0]!;
    expect(a.bodyHash).not.toBe(b.bodyHash);
    expect(a.renamedBodyHash).toBe(b.renamedBodyHash);
    expect(a.renamedBodyHash).not.toBe(c.renamedBodyHash);
    const renamedProperty = measure('function one(x) { const y = x + 1; return { y: y, label: "allow" }; }')[0]!;
    expect(a.renamedBodyHash).not.toBe(renamedProperty.renamedBodyHash);
  });

  it('preserves shorthand destructuring keys while allowing bound local names to differ', () => {
    const left = measure('function a(input) { const { left } = input; return left; }')[0]!;
    const right = measure('function b(input) { const { right } = input; return right; }')[0]!;
    expect(left.renamedBodyHash).not.toBe(right.renamedBodyHash);
    const aliasA = measure('function a(input) { const { value: first } = input; return first; }')[0]!;
    const aliasB = measure('function b(input) { const { value: second } = input; return second; }')[0]!;
    expect(aliasA.renamedBodyHash).toBe(aliasB.renamedBodyHash);
    const restA = measure('function a(input) { const { ...first } = input; return first; }')[0]!;
    const restB = measure('function b(input) { const { ...second } = input; return second; }')[0]!;
    expect(restA.renamedBodyHash).toBe(restB.renamedBodyHash);
  });

  it('retains contribution order, logical sequences and labeled jumps under nesting', () => {
    const [fn] = measure(`function choose(a, b, c) {
      outer: for (;;) {
        if (a && (b && c)) break outer;
        if (a ?? b) continue outer;
      }
    }`);
    expect(fn).toMatchObject({ cyclomatic: 7, cognitive: 8 });
    expect(fn!.contributions.map(({ kind, cyclomatic, cognitive }) => [kind, cyclomatic, cognitive])).toEqual([
      ['ForStatement', 1, 1],
      ['if', 1, 2],
      ['&&', 1, 1],
      ['&&', 1, 0],
      ['labeled-jump', 0, 1],
      ['if', 1, 2],
      ['??', 1, 0],
      ['labeled-jump', 0, 1],
    ]);
  });

  it('ignores comments and whitespace but refuses parse failures', () => {
    const a = measure('const f = (x) => { return x + 1; };')[0]!;
    const b = measure('const g = (x) => { /* comment */ return x+1; };')[0]!;
    expect(a.bodyHash).toBe(b.bodyHash);
    expect(analyzeSourceFunctions('broken.ts', 'function f( {').errors).not.toHaveLength(0);
    expect(measure('function f( {')).toEqual([]);
  });

  it('resolves local bindings by lexical identity instead of erasing global names', () => {
    const a = measure('function a() { external(); { const external = 1; consume(external); } }')[0]!;
    const b = measure('function b() { different(); { const different = 1; consume(different); } }')[0]!;
    expect(a.renamedBodyHash).not.toBe(b.renamedBodyHash);
    const c = measure('function c(input) { { const local = input + 1; consume(local); } }')[0]!;
    const d = measure('function d(value) { { const renamed = value + 1; consume(renamed); } }')[0]!;
    expect(c.renamedBodyHash).toBe(d.renamedBodyHash);
  });
});
