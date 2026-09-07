import { describe, expect, it } from 'vitest';
import { buildDeclarationCandidatesMap, maskStructuralLine } from '../../src/symbols/definition-catalog.js';

describe('declaration source fallback compatibility', () => {
  it('masks escaped quotes and comment markers inside strings without hiding later structure', () => {
    const quoted = String.raw`"escaped \" // }"`;
    const line = `call(${quoted}) { // ignored }`;
    const actual = maskStructuralLine(line);
    expect(actual).toBe(`call(${' '.repeat(quoted.length)}) { ${' '.repeat('// ignored }'.length)}`);
    expect(actual).toHaveLength(line.length);
  });

  it('keeps quote state local to each line and retains the established block-comment handling', () => {
    expect(maskStructuralLine('"unterminated {')).toBe(' '.repeat('"unterminated {'.length));
    expect(maskStructuralLine('next() { /* retained } */')).toBe('next() { /* retained } */');
    expect(maskStructuralLine('`template ${call()}`; tail()')).toBe(
      `${' '.repeat('`template ${call()}`'.length)}; tail()`,
    );
  });

  it('retains first-name insertion order and deduplicates repeated matches on one line', () => {
    const lines = ['function first() { second(); first(); }', 'const second = (arg) => first(arg);', 'first();'];
    expect([...buildDeclarationCandidatesMap(lines)]).toEqual([
      ['first', [0, 1, 2]],
      ['second', [0, 1]],
    ]);
  });
});
