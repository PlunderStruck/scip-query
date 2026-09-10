import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseAstSource } from '../../src/source/ast/ast-runtime.js';
import { sourceBindingResolver } from '../../src/source/ast/source-binding-identity.js';

function wrap(name: string, form: number): string {
  return [
    name,
    `(${name})`,
    `(${name} as typeof ${name})`,
    `(${name} satisfies typeof ${name})`,
    `${name}!`,
    `(<typeof ${name}>${name})`,
  ][form]!;
}

function finalCall(source: string) {
  const tree = parseAstSource('typescript', source);
  if (!tree) throw new Error('TypeScript fixture did not parse');
  const statement = tree.rootNode.namedChildren.at(-1);
  const target = statement?.namedChild(0)?.childForFieldName('function');
  if (!target) throw new Error('TypeScript fixture did not end in a call');
  return { target, bindings: sourceBindingResolver('fixture.ts', tree.rootNode) };
}

describe('TypeScript member write identity', () => {
  it.each(['\n// layout\n', '\n\n  ', '\r\n// layout\r\n'])(
    'preserves helper effects after leading trivia %j',
    (prefix) => {
      const { target, bindings } = finalCall(
        `${prefix}const service = { run() { return 1; } }; function change(value: typeof service) { value.run = () => 2; } change(service); service.run();`,
      );
      expect(bindings.hasObservedCallableWrite(target)).toBe(true);
    },
  );
  it.each([1, 8, 16, 32])('tracks unknown effects through %i nested containers', (depth) => {
    const nested = Array.from({ length: depth }).reduce<string>((value) => `{ child: ${value} }`, 'service');
    const { target, bindings } = finalCall(
      `const service = { run() { return 1; } }; unknown(${nested}); service.run();`,
    );
    expect(bindings.hasObservedCallableWrite(target)).toBe(true);
  });

  it('preserves a copied callable slot when an unknown consumer receives only the copy', () => {
    const { target, bindings } = finalCall(
      'const service = { run() { return 1; } }; unknown({ child: { ...service } }); service.run();',
    );
    expect(bindings.hasObservedCallableWrite(target)).toBe(false);
  });

  it('terminates unknown exposure through a cyclic container while retaining shared writes', () => {
    const { target, bindings } = finalCall(
      'const service = { run() { return 1; } }; const box = { self: undefined as any, service }; box.self = box; unknown(box); service.run();',
    );
    expect(bindings.hasObservedCallableWrite(target)).toBe(true);
  });

  it.each([
    'import { service } from "./owner.js";',
    'import service from "./owner.js";',
    'import * as service from "./owner.js";',
  ])('tracks direct writes to the local import binding: %s', (declaration) => {
    const { target, bindings } = finalCall(`${declaration}\nservice.run = () => 2;\nservice.run();`);
    expect(bindings.hasObservedCallableWrite(target)).toBe(true);
  });

  it.each([0, 1, 2, 3, 4, 5])('preserves parameter identity through wrapper %i', (form) => {
    const tree = parseAstSource(
      'typescript',
      `function entry(first: string) { return consume(${wrap('first', form)}); }`,
    )!;
    const bindings = sourceBindingResolver('fixture.ts', tree.rootNode);
    const callable = tree.rootNode.namedChild(0)!;
    const call = callable.childForFieldName('body')!.namedChild(0)!.namedChild(0)!;
    const argument = call.childForFieldName('arguments')!.namedChild(0)!;
    expect(bindings.directParameterPosition(argument)).toBe(0);
  });

  it.each([
    'function change(value: typeof service) { value.run = () => 2; } change(service);',
    'Object.assign(service, { run: () => 2 });',
    'Object.defineProperty(service, "run", { value: () => 2 });',
    'Object.defineProperties(service, { run: { value: () => 2 } });',
    'Reflect.set(service, "run", () => 2);',
    'const [...holder] = [service]; holder[0]!.run = () => 2;',
    'const [, ...holder] = [null, service]; holder[0]!.run = () => 2;',
    'function same<T>(value: T) { return value; } const alias = same(service); alias.run = () => 2;',
    'const alias = true && service; alias.run = () => 2;',
    'let alias; let other; alias = other = service; alias.run = () => 2;',
    'unknownConsumer({ nested: [service] });',
  ])('retains shared value effects from %s', (effect) => {
    const { target, bindings } = finalCall(
      `const service = { run() { return 1; }, count: 0 };\n${effect}\nservice.run();`,
    );
    expect(bindings.hasObservedCallableWrite(target)).toBe(true);
  });

  it.each([
    'Object.assign(service, { count: 2 });',
    'Reflect.set(service, "count", 2);',
    'function change(value: typeof service) { value.count++; } change(service);',
    'const [...holder] = [service]; holder[0] = { run() { return 2; }, count: 0 };',
  ])('preserves sibling and copy boundaries for %s', (effect) => {
    const { target, bindings } = finalCall(
      `const service = { run() { return 1; }, count: 0 };\n${effect}\nservice.run();`,
    );
    expect(bindings.hasObservedCallableWrite(target)).toBe(false);
  });

  it.each(['export', 'export default'])('selects the function inside a %s declaration', (modifier) => {
    const { target, bindings } = finalCall(`${modifier} function route() { return '/route'; }\nroute();`);
    const callable = bindings.callableValue(target);
    expect(callable?.type).toBe('function_declaration');
    expect(callable?.childForFieldName('body')?.text).toBe("{ return '/route'; }");
  });

  it('preserves reference sharing and copy boundaries across generated containers and wrappers', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.nat(100_000),
          form: fc.integer({ min: 0, max: 5 }),
          readForm: fc.integer({ min: 0, max: 5 }),
          container: fc.constantFrom('object', 'shorthand', 'array', 'assigned', 'spread', 'rest'),
          mutation: fc.constantFrom('method', 'sibling', 'slot', 'metadata'),
        }),
        ({ name, form, readForm, container, mutation }) => {
          const owner = `service_${name}`;
          const reference = wrap(owner, form);
          const arrangements = {
            object: [`const box = { value: ${reference} };`, 'box.value'],
            shorthand: [`const box = { ${owner} };`, `box.${owner}`],
            array: [`const box = [${reference}];`, 'box[0]!'],
            assigned: [`const box: { value?: typeof ${owner} } = {}; box.value = ${reference};`, 'box.value!'],
            spread: [`const parent = { value: ${reference} }; const box = { ...parent };`, 'box.value'],
            rest: [`const parent = { value: ${reference} }; const { ...box } = parent;`, 'box.value'],
          };
          const [setup, access] = arrangements[container];
          const writes = {
            method: `${access}.run = () => 2;`,
            sibling: `${access}.count++;`,
            slot: `${access} = { run() { return 2; }, count: 0 };`,
            metadata: `(${access}.run as typeof ${owner}.run & { tag?: number }).tag = 2;`,
          };
          const { target, bindings } = finalCall(
            [
              `const ${owner} = { run() { return 1; }, count: 0 };`,
              setup,
              writes[mutation],
              `${wrap(owner, readForm)}.run();`,
            ].join('\n'),
          );
          expect(bindings.available).toBe(true);
          expect(bindings.hasObservedCallableWrite(target)).toBe(mutation === 'method');
        },
      ),
      { numRuns: 1_000, seed: 20260910 },
    );
  });

  it('preserves target versus sibling writes across names, wrappers, aliases, and Unicode positions', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.nat(100_000),
          aliasForm: fc.integer({ min: 0, max: 5 }),
          writeForm: fc.integer({ min: 0, max: 5 }),
          readForm: fc.integer({ min: 0, max: 5 }),
          alias: fc.boolean(),
          aliasKind: fc.constantFrom('const', 'let', 'var', 'assigned'),
          replacesMethod: fc.boolean(),
          multiline: fc.boolean(),
        }),
        ({ name, aliasForm, writeForm, readForm, alias, aliasKind, replacesMethod, multiline }) => {
          const owner = `service_${name}`;
          const { target, bindings } = finalCall(
            [
              `const ${owner} = { run() { return 1; }, count: 0 };`,
              aliasKind === 'assigned'
                ? `let alias; alias = ${wrap(owner, aliasForm)};`
                : `${aliasKind} alias = ${wrap(owner, aliasForm)};`,
              'const label = "é😀";',
              `${wrap(alias ? 'alias' : owner, writeForm)}.${replacesMethod ? 'run' : 'count'} = ${replacesMethod ? '() => 2' : '2'};`,
              `${wrap(owner, readForm)}.run();`,
            ].join(multiline ? '\n' : ' '),
          );
          expect(bindings.available).toBe(true);
          expect(bindings.hasObservedWrite(target, true)).toBe(replacesMethod);
          // Reading the complete object still observes every member write.
          expect(bindings.hasObservedWrite(target.childForFieldName('object')!, true)).toBe(true);
        },
      ),
      { numRuns: 1_000, seed: 20260909 },
    );
  });

  it.each([
    'const { nested: alias } = service;',
    'let { nested: alias } = service;',
    'let alias; ({ nested: alias } = service);',
    'const { ["nested"]: alias } = service;',
    'const { nested: alias = other } = service;',
    'let alias = other; alias = service.nested;',
    'const alias = true ? service.nested : other;',
  ])('retains possible member origins from %s', (declaration) => {
    for (const field of ['count', 'run']) {
      const { target, bindings } = finalCall(
        [
          'const service = { nested: { run() { return 1; }, count: 0 } };',
          'const other = { run() { return 3; }, count: 0 };',
          declaration,
          `alias.${field} = ${field === 'run' ? '() => 2' : '2'};`,
          'service.nested.run();',
        ].join('\n'),
      );
      expect(bindings.hasObservedWrite(target, true)).toBe(field === 'run');
    }
  });

  it.each([
    ['alias.count = 2;', false],
    ['alias.run = () => 2;', true],
    ['service.nested = { count: 0, run() { return 2; } };', true],
    ['service.other.count = 2;', false],
    ['alias[key] = () => 2;', true],
    ['delete alias.run;', true],
    ['({ value: alias.run } = { value: () => 2 });', true],
  ] as const)('retains nested access paths for %s', (write, changed) => {
    const { target, bindings } = finalCall(
      [
        'const service = { nested: { run() { return 1; }, count: 0 }, other: { count: 0 } };',
        'const alias = (service.nested); const key: string = "run";',
        write,
        'service.nested.run();',
      ].join('\n'),
    );
    expect(bindings.hasObservedWrite(target, true)).toBe(changed);
  });
});
