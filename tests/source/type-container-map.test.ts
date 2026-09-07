import { describe, expect, it } from 'vitest';
import { parseAstSource } from '../../src/source/ast/ast-runtime.js';
import { buildTypeContainerMap } from '../../src/source/facts/source-type-containers.js';

describe('source type containment', () => {
  it('retains Rust field, variant and alias consumers without self-links', () => {
    const tree = parseAstSource(
      'rust',
      [
        'struct Payload {}',
        'struct Holder { value: Payload, next: Box<Holder> }',
        'enum Choice { Value(Payload) }',
        'type Alias = Payload;',
      ].join('\n'),
    );
    expect(tree).not.toBeNull();
    const containers = buildTypeContainerMap(tree!, 'rust');
    expect(containers.get('Payload')).toEqual(new Set(['Holder', 'Choice', 'Alias']));
    expect(containers.get('Box')).toEqual(new Set(['Holder']));
    expect(containers.has('Holder')).toBe(false);
  });

  it('includes Python superclass and annotation consumers without self-links', () => {
    const tree = parseAstSource(
      'python',
      ['class Child(Base):', '    value: Payload', '    self_ref: Child'].join('\n'),
    );
    expect(tree).not.toBeNull();
    const containers = buildTypeContainerMap(tree!, 'python');
    expect(containers.get('Base')).toEqual(new Set(['Child']));
    expect(containers.get('Payload')).toEqual(new Set(['Child']));
    expect(containers.has('Child')).toBe(false);
  });

  it('includes TypeScript interfaces, aliases and classes in one consumer map', () => {
    const tree = parseAstSource(
      'typescript',
      ['interface Shape { value: Value; self: Shape }', 'type Alias = Value;', 'class Holder { item: Value; }'].join(
        '\n',
      ),
    );
    expect(tree).not.toBeNull();
    const containers = buildTypeContainerMap(tree!, 'typescript');
    expect(containers.get('Value')).toEqual(new Set(['Shape', 'Alias', 'Holder']));
    expect(containers.has('Shape')).toBe(false);
  });
});
