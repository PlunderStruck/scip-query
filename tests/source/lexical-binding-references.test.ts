import { describe, expect, it } from 'vitest';
import { analyzeSourceFunctions } from '../../src/source/ast/function-metrics.js';
import { lexicalBindingReferences } from '../../src/source/ast/maintenance-bindings.js';

describe('lexical binding references', () => {
  it('resolves multiline typed and destructured variables without treating keys, comments, or strings as uses', () => {
    const source = [
      'function run() {',
      '  const {',
      '    payload: selected,',
      '    nested: { item },',
      '    ...rest',
      '  }: Input = read();',
      '  const typed:',
      '    Result = transform(selected);',
      '  report({ selected, item, rest, typed });',
      '  log("selected typed"); // selected',
      '  log({ selected: true, typed: false });',
      '}',
    ].join('\n');
    expect(lexicalBindingReferences(analyzeSourceFunctions('source.ts', source))).toEqual([
      { name: 'selected', startLine: 1, endLine: 5, referenceLines: [7, 8] },
      { name: 'item', startLine: 1, endLine: 5, referenceLines: [8] },
      { name: 'rest', startLine: 1, endLine: 5, referenceLines: [8] },
      { name: 'typed', startLine: 6, endLine: 7, referenceLines: [8] },
    ]);
  });

  it('keeps shadowed bindings separate and includes reads in closures of the same binding', () => {
    const source = [
      'const value = read();',
      'function closure() { return value; }',
      '{',
      '  const value = other();',
      '  consume(value);',
      '}',
      'function ignored(value: string) { return value; }',
      'consume(value);',
    ].join('\n');
    expect(lexicalBindingReferences(analyzeSourceFunctions('source.ts', source))).toEqual([
      { name: 'value', startLine: 0, endLine: 0, referenceLines: [1, 7] },
      { name: 'value', startLine: 3, endLine: 3, referenceLines: [4] },
    ]);
  });

  it('handles array holes, multiple declarations, and loop bindings', () => {
    const source = [
      'const [first, , ...tail] = read(), other = first;',
      'for (const item of tail) { consume(item, other); }',
    ].join('\n');
    expect(lexicalBindingReferences(analyzeSourceFunctions('source.ts', source))).toEqual([
      { name: 'first', startLine: 0, endLine: 0, referenceLines: [0] },
      { name: 'tail', startLine: 0, endLine: 0, referenceLines: [1] },
      { name: 'other', startLine: 0, endLine: 0, referenceLines: [1] },
      { name: 'item', startLine: 1, endLine: 1, referenceLines: [1] },
    ]);
  });

  it('does not produce references from malformed source', () => {
    expect(lexicalBindingReferences(analyzeSourceFunctions('source.ts', 'const { = ;'))).toEqual([]);
  });
});
