import type { AuditCase } from './cases.js';

function value(id: string, setup: string, expression: string, expected: unknown, prefix = ''): AuditCase {
  return {
    id: `exact-value-${id}`,
    area: 'exact-value',
    value: true,
    expected,
    source: `${prefix}\nexport function entry() {\n${setup}\n/* probe */ const probe = ${expression};\nreturn probe;\n}`,
  };
}

function call(id: string, source: string, expected: unknown): AuditCase {
  return { id: `exact-call-${id}`, area: 'exact-call', source, expected, traceCallee: true };
}

const values: AuditCase[] = [
  value('control', '', '"/right"', '/right'),
  value('local-helper', '', 'read()', '/right', 'function read() { return "/right"; }'),
  value(
    'argument-ambient-binding',
    '',
    'read(missing)',
    { throws: 'missing is not defined' },
    'declare const missing: string; function read(_x: unknown) { return "/wrong"; }',
  ),
  value(
    'argument-destructure-null',
    '',
    'read(null)',
    { throws: "Cannot destructure property 'x' of 'object null' as it is null." },
    'function read({ x }: any) { return "/wrong"; }',
  ),
  value(
    'argument-array-null',
    '',
    'read(null)',
    { throws: 'object null is not iterable (cannot read property Symbol(Symbol.iterator))' },
    'function read([x]: any) { return "/wrong"; }',
  ),
  value(
    'argument-spread-null',
    'const absent: any = null;',
    'read(...absent)',
    { throws: 'absent is not iterable (cannot read property null)' },
    'function read(..._x: unknown[]) { return "/wrong"; }',
  ),
  value(
    'destructure-getter',
    'const input = { get x(): string { throw new Error("getter"); } };',
    'read(input)',
    { throws: 'getter' },
    'function read({ x }: { x: string }) { return "/wrong"; }',
  ),
  value(
    'destructure-iterator',
    'const input = { *[Symbol.iterator]() { throw new Error("iterator"); } };',
    'read(input)',
    { throws: 'iterator' },
    'function read([x]: Iterable<string>) { return "/wrong"; }',
  ),
  value(
    'destructure-default-throw',
    '',
    'read()',
    { throws: 'default' },
    'function fail(): any { throw new Error("default"); } function read({ x } = fail()) { return "/wrong"; }',
  ),
  value(
    'unary-coercion',
    'const input = { valueOf() { throw new Error("coercion"); } };',
    'read(+input)',
    { throws: 'coercion' },
    'function read(_x: unknown) { return "/wrong"; }',
  ),
  value(
    'binary-coercion',
    'const input: any = { [Symbol.toPrimitive]() { throw new Error("coercion"); } };',
    'read(input + "")',
    { throws: 'coercion' },
    'function read(_x: unknown) { return "/wrong"; }',
  ),
  value(
    'template-coercion',
    'const input = { toString() { throw new Error("coercion"); } };',
    'read(`${input}`)',
    { throws: 'coercion' },
    'function read(_x: unknown) { return "/wrong"; }',
  ),
  value(
    'bigint-mixing',
    'const input: any = 1n;',
    'read(input + 1)',
    { throws: 'Cannot mix BigInt and other types, use explicit conversions' },
    'function read(_x: unknown) { return "/wrong"; }',
  ),
  value(
    'initializer-destructure',
    '',
    'read()',
    { throws: "Cannot destructure property 'x' of 'null' as it is null." },
    'function read() { const { x } = null as any; return "/wrong"; }',
  ),
  value(
    'initializer-unary',
    '',
    'read()',
    { throws: 'coercion' },
    'const input = { valueOf() { throw new Error("coercion"); } }; function read() { const x = +input; return "/wrong"; }',
  ),
  value(
    'initializer-spread',
    '',
    'read()',
    { throws: 'iterator' },
    'const input = { *[Symbol.iterator]() { throw new Error("iterator"); } }; function read() { const x = [...input]; return "/wrong"; }',
  ),
  value(
    'initializer-class-static',
    '',
    'read()',
    { throws: 'static' },
    'function read() { const X = class { static { throw new Error("static"); } }; return "/wrong"; }',
  ),
  value('optional-null', 'const read = null as unknown as (() => string);', 'read?.()', { undefined: true }),
  value('getter-result', 'const box = { get path() { return "/right"; } };', 'box.path', '/right'),
  value(
    'spread-getter-effect',
    'const box = { path: "/wrong" }; const input = { get x() { box.path = "/right"; return 0; } }; const copied = { ...input };',
    'box.path',
    '/right',
  ),
  value(
    'computed-key-effect',
    'const box = { path: "/wrong" }; const key = { toString() { box.path = "/right"; return "x"; } }; const made = { [key as any]: 1 };',
    'box.path',
    '/right',
  ),
  value(
    'rest-getter-effect',
    'const box = { path: "/wrong" }; const input = { get x() { box.path = "/right"; return 0; } }; const { ...copy } = input;',
    'box.path',
    '/right',
  ),
  value(
    'reflect-receiver',
    'const box = { path: "/wrong" }; const other = {}; Reflect.set(other, "path", "/right", box);',
    'box.path',
    '/right',
  ),
  value(
    'object-create-alias',
    'const box = { path: "/wrong" }; const holder = Object.create(null, { inner: { value: box } }); holder.inner.path = "/right";',
    'box.path',
    '/right',
  ),
  value(
    'reflect-get-alias',
    'const box = { path: "/wrong" }; const holder = { box }; const alias = Reflect.get(holder, "box"); alias.path = "/right";',
    'box.path',
    '/right',
  ),
  value(
    'object-values-alias',
    'const box = { path: "/wrong" }; const holder = { box }; const [alias] = Object.values(holder); alias!.path = "/right";',
    'box.path',
    '/right',
  ),
  value(
    'object-entries-alias',
    'const box = { path: "/wrong" }; const holder = { box }; const [[key, alias]] = Object.entries(holder); alias.path = "/right";',
    'box.path',
    '/right',
  ),
  value(
    'array-find-alias',
    'const box = { path: "/wrong" }; const alias = [box].find(() => true)!; alias.path = "/right";',
    'box.path',
    '/right',
  ),
  value(
    'object-spread-copy-control',
    'const box = { path: "/right" }; const copy = { ...box }; copy.path = "/wrong";',
    'box.path',
    '/right',
  ),
  value(
    'nested-spread-reference',
    'const box = { path: "/wrong" }; const copy = { ...{ box } }; copy.box.path = "/right";',
    'box.path',
    '/right',
  ),
  value('eval-property-write', 'const box = { path: "/wrong" }; eval("box.path = \'/right\'");', 'box.path', '/right'),
  value(
    'finally-return',
    '',
    'read()',
    '/right',
    'function read() { try { return "/wrong"; } finally { return "/right"; } }',
  ),
  value('catch-return', '', 'read()', '/right', 'function read() { try { throw 1; } catch { return "/right"; } }'),
  value(
    'closure-parameter',
    'function make(path: string) { return () => path; } const read = make("/right");',
    'read()',
    '/right',
  ),
  value(
    'closure-mutation',
    'const box = { path: "/wrong" }; const read = () => box.path; const write = () => { box.path = "/right"; }; write();',
    'read()',
    '/right',
  ),
  value(
    'namespace-property',
    'state.change();',
    'state.box.path',
    '/right',
    'namespace state { export const box = { path: "/wrong" }; export function change() { box.path = "/right"; } }',
  ),
];

const calls = [
  call(
    'direct-control',
    'function original() { return 1; }\nexport function entry() {\n/* probe */ return original();\n}',
    1,
  ),
  call('arrow-control', 'const original = () => 1;\nexport function entry() {\n/* probe */ return original();\n}', 1),
  call(
    'alias-same-line',
    'const original = () => 1; const replacement = () => 2; const alias = replacement; export function entry() {\n/* probe */ return alias();\n}',
    2,
  ),
  call(
    'alias-multiple-lines',
    'const original = () => 1;\nconst replacement = () => 2;\nconst alias = replacement;\nexport function entry() {\n/* probe */ return alias();\n}',
    2,
  ),
  call(
    'eval-function-write',
    'function original() { return 1; }\nfunction replacement() { return 2; }\nexport function entry() { eval("original = replacement");\n/* probe */ return original();\n}',
    2,
  ),
  call(
    'eval-let-write',
    'let original = () => 1;\nconst replacement = () => 2;\nexport function entry() { eval("original = replacement");\n/* probe */ return original();\n}',
    2,
  ),
  call(
    'closure-function-write',
    'let original = function originalBody() { return 1; };\nfunction replacement() { return 2; }\nfunction change() { original = replacement; }\nexport function entry() { change();\n/* probe */ return original();\n}',
    2,
  ),
  call(
    'capture-before-write',
    'let original = function originalBody() { return 1; };\nfunction replacement() { return 2; }\nconst saved = original;\nexport function entry() { original = replacement;\n/* probe */ return saved();\n}',
    1,
  ),
  call(
    'argument-reassign-snapshot',
    'let original = function originalBody(_x?: unknown) { return 1; };\nfunction replacement() { return 2; }\nexport function entry() {\n/* probe */ return original(original = replacement);\n}',
    1,
  ),
  call(
    'bound-function',
    'function original() { return 1; }\nconst bound = original.bind(null);\nexport function entry() {\n/* probe */ return bound();\n}',
    1,
  ),
  call(
    'constructor-proxy',
    'class Base { value: number; constructor() { this.value = 1; } }\nclass Other { value: number; constructor() { this.value = 2; } }\nconst ProxyBase = new Proxy(Base, { construct() { return new Other(); } });\nexport function entry() {\n/* probe */ return new ProxyBase().value;\n}',
    2,
  ),
  call(
    'constructor-replaced-eval',
    'class Base { value: number; constructor() { this.value = 1; } }\nclass Other { value: number; constructor() { this.value = 2; } }\nexport function entry() { eval("Base = Other");\n/* probe */ return new Base().value;\n}',
    2,
  ),
  call(
    'constructor-return-object',
    'class Base { value = 1; constructor() { return { value: 2 }; } }\nexport function entry() {\n/* probe */ return new Base().value;\n}',
    2,
  ),
  call(
    'getter-function',
    'function original() { return 1; }\nconst holder = { get read() { return original; } };\nexport function entry() {\n/* probe */ return holder.read();\n}',
    1,
  ),
];

function moduleValue(id: string, writer: string, statement: string): AuditCase {
  const owner = `${id}-owner.ts`;
  const change = `${id}-writer.ts`;
  const probe = value(
    id,
    statement,
    'box.path',
    '/right',
    `import { box } from "./${owner.replace('.ts', '.js')}";\nimport { change } from "./${change.replace('.ts', '.js')}";`,
  );
  probe.area = 'cross-file-value';
  probe.files = {
    [owner]: 'export const box = { path: "/wrong" };',
    [change]: `import { box } from "./${owner.replace('.ts', '.js')}";\nexport function change() { ${writer} }`,
  };
  return probe;
}

const modules: AuditCase[] = [
  moduleValue('imported-closure-writer', 'box.path = "/right";', 'change();'),
  moduleValue('imported-assign-writer', 'Object.assign(box, { path: "/right" });', 'change();'),
  moduleValue('imported-reflect-writer', 'Reflect.set(box, "path", "/right");', 'change();'),
];

for (const [id, statement] of [
  ['callback-sync', 'change();'],
  ['promise-callback', 'await Promise.resolve().then(change);'],
  ['await-writer', 'await change();'],
] as const) {
  const item = moduleValue(`async-${id}`, 'box.path = "/right";', statement);
  if (statement.includes('await'))
    item.source = item.source.replace('export function entry()', 'export async function entry()');
  modules.push(item);
}

// All variants have the same semantics and independent expected outcome.
const variants = values.flatMap((item) => [
  { ...item, id: `${item.id}-leading-trivia`, source: `\n\n/* λ😀 coordinate control */\n${item.source}` },
  { ...item, id: `${item.id}-crlf`, source: item.source.replaceAll('\n', '\r\n') },
]);

const crossFileMatrix: AuditCase[] = [];
for (const [writerIndex, writer] of [
  'box.path = "/right";',
  'Object.assign(box, { path: "/right" });',
  'Reflect.set(box, "path", "/right");',
].entries()) {
  for (const [scheduleIndex, statement] of [
    'change();',
    '(() => change())();',
    'await Promise.resolve().then(change);',
    'await change();',
  ].entries()) {
    for (const style of ['named', 'renamed', 'namespace', 'barrel', 'default']) {
      const id = `exact-matrix-${writerIndex}-${scheduleIndex}-${style}`;
      const owner = `${id}-owner.ts`;
      const writerFile = `${id}-writer.ts`;
      const barrel = `${id}-barrel.ts`;
      const ownerJs = owner.replace('.ts', '.js');
      const imports = {
        named: `import { box } from "./${ownerJs}";`,
        renamed: `import { box as imported } from "./${ownerJs}";`,
        namespace: `import * as imported from "./${ownerJs}";`,
        barrel: `import { box } from "./${barrel.replace('.ts', '.js')}";`,
        default: `import box from "./${ownerJs}";`,
      };
      const expression =
        style === 'renamed' ? 'imported.path' : style === 'namespace' ? 'imported.box.path' : 'box.path';
      const item = value(
        id,
        statement,
        expression,
        '/right',
        `${imports[style as keyof typeof imports]}\nimport { change } from "./${writerFile.replace('.ts', '.js')}";`,
      );
      item.id = id;
      item.area = 'cross-file-matrix';
      item.source = item.source.replace('export function entry()', 'export async function entry()');
      item.files = {
        [owner]: 'export const box = { path: "/wrong" }; export default box;',
        [writerFile]: `import { box } from "./${ownerJs}"; export function change() { ${writer} }`,
        [barrel]: `export { box } from "./${ownerJs}";`,
      };
      crossFileMatrix.push(item);
    }
  }
}

const aliasMatrix: AuditCase[] = [];
for (const [index, initializer] of [
  'replacement',
  '(replacement)',
  '(replacement as () => number)',
  '(replacement satisfies () => number)',
  'replacement!',
].entries()) {
  for (const separator of [' ', '\n']) {
    const id = `alias-${index}-${separator === ' ' ? 'same-line' : 'separate-lines'}`;
    aliasMatrix.push(
      call(
        id,
        `const original = () => 1;${separator}const replacement = () => 2;${separator}const alias = ${initializer};\nexport function entry() {\n/* probe */ return alias();\n}`,
        2,
      ),
    );
  }
}

const decoratorCalls = ['Base', '(Base)', '(Base as typeof Base)'].map((expression, index) =>
  call(
    `decorated-constructor-${index}`,
    `function replace(_value: any, _context: any) { return class Other { value: number; constructor() { this.value = 2; } }; }\n@replace\nclass Base { value: number; constructor() { this.value = 1; } }\nexport function entry() {\n/* probe */ return new ${expression}().value;\n}`,
    2,
  ),
);

function transfer(
  id: string,
  declaration: string,
  invocation: string,
  expected: Array<[number, number]>,
  setup = '',
): AuditCase {
  return {
    id: `exact-flow-${id}`,
    area: 'parameter-transfer',
    expected: '/right',
    source: `${declaration}\nexport function entry(first = "a", second = "b") {\n${setup}\n/* probe */ ${invocation};\nreturn "/right";\n}`,
    flow: { expected, required: false },
  };
}

const transfers = [
  transfer('control', 'function consume(first: string, second: string) {}', 'consume(first, second)', [
    [0, 0],
    [1, 1],
  ]),
  transfer(
    'this-parameter',
    'function consume(this: void, first: string, second: string) {}',
    'consume(first, second)',
    [
      [0, 0],
      [1, 1],
    ],
  ),
  transfer('generic', 'function consume<T>(first: T, second: T) {}', 'consume(first, second)', [
    [0, 0],
    [1, 1],
  ]),
  transfer('rest-tuple', 'function consume(...items: [string, string]) {}', 'consume(first, second)', [
    [0, 0],
    [1, 0],
  ]),
  transfer('rest-array', 'function consume(...items: string[]) {}', 'consume(first, second)', [
    [0, 0],
    [1, 0],
  ]),
  transfer('default-second', 'function consume(first: string, second = "default") {}', 'consume(first)', [[0, 0]]),
  transfer(
    'explicit-undefined',
    'function consume(first: string, second = "default") {}',
    'consume(first, undefined)',
    [[0, 0]],
  ),
  transfer(
    'overload',
    'function consume(first: string, second: string): void; function consume(first: unknown, second: unknown) {}',
    'consume(first, second)',
    [
      [0, 0],
      [1, 1],
    ],
  ),
  transfer('optional-call', 'function consume(first: string, second: string) {}', 'consume?.(first, second)', [
    [0, 0],
    [1, 1],
  ]),
  transfer(
    'wrapped-target',
    'function consume(first: string, second: string) {}',
    '(consume as typeof consume)(first, second)',
    [
      [0, 0],
      [1, 1],
    ],
  ),
  transfer(
    'spread-tuple-control',
    'function consume(first: string, second: string) {}',
    'consume(...args)',
    [
      [0, 0],
      [1, 1],
    ],
    'const args: [string, string] = [first, second];',
  ),
  transfer(
    'spread-reversed',
    'function consume(first: string, second: string) {}',
    'consume(...args)',
    [
      [1, 0],
      [0, 1],
    ],
    'const args: [string, string] = [first, second]; args.reverse();',
  ),
  transfer(
    'spread-index-write',
    'function consume(first: string, second: string) {}',
    'consume(...args)',
    [
      [1, 0],
      [1, 1],
    ],
    'const args: [string, string] = [first, second]; args[0] = second;',
  ),
];

export const exactClaimCases: AuditCase[] = [
  ...values,
  ...calls,
  ...modules,
  ...variants,
  ...crossFileMatrix,
  ...aliasMatrix,
  ...decoratorCalls,
  ...transfers,
];
