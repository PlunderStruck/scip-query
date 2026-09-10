export interface AuditCase {
  id: string;
  area: string;
  source: string;
  expected: unknown;
  required?: boolean;
  value?: boolean;
  files?: Record<string, string>;
  interpretation?: string;
  flow?: { expected: Array<[number, number]>; required: boolean };
  /** Last executed callable is the single marked invocation; verified with a separate instrumented execution. */
  traceCallee?: boolean;
}

const prelude = `export function original() { return 1; }
export function replacement() { return 2; }
class Service { count = 0; run() { return 1; } }
const service = new Service();
`;

function mutation(id: string, statement: string, expected = 2, area = 'mutation'): AuditCase {
  return {
    id,
    area,
    expected,
    source: `${prelude}export function entry() {\n${statement}\n/* probe */ return service.run();\n}`,
  };
}

const mutationCases = [
  mutation('direct-write', 'service.run = replacement;'),
  mutation('sibling-write', 'service.count++;', 1),
  mutation(
    'helper-parameter-write',
    'function change(value: typeof service) { value.run = replacement; } change(service);',
  ),
  mutation(
    'helper-return-alias',
    'function same<T>(value: T) { return value; } const alias = same(service); alias.run = replacement;',
  ),
  mutation(
    'helper-callback-write',
    'function visit(fn: (value: typeof service) => void) { fn(service); } visit(value => { value.run = replacement; });',
  ),
  mutation('closure-write', 'const change = () => { service.run = replacement; }; change();'),
  mutation('never-called-write', 'const change = () => { service.run = replacement; }; void change;', 1, 'ordering'),
  mutation('unreachable-write', 'if (false) service.run = replacement;', 1, 'ordering'),
  mutation('object-assign', 'Object.assign(service, { run: replacement });'),
  mutation('object-define-property', 'Object.defineProperty(service, "run", { value: replacement });'),
  mutation('object-define-properties', 'Object.defineProperties(service, { run: { value: replacement } });'),
  mutation('reflect-set', 'Reflect.set(service, "run", replacement);'),
  mutation('object-values', 'const box = { service }; Object.values(box)[0]!.run = replacement;', 2, 'containers'),
  mutation('object-entries', 'const box = { service }; Object.entries(box)[0]![1].run = replacement;', 2, 'containers'),
  mutation('array-rest', 'const [...aliases] = [service]; aliases[0]!.run = replacement;', 2, 'containers'),
  mutation(
    'array-rest-offset',
    'const [, ...aliases] = [service, service]; aliases[0]!.run = replacement;',
    2,
    'containers',
  ),
  mutation('array-spread', 'const aliases = [...[service]]; aliases[0]!.run = replacement;', 2, 'containers'),
  mutation(
    'array-push',
    'const aliases: typeof service[] = []; aliases.push(service); aliases[0]!.run = replacement;',
    2,
    'containers',
  ),
  mutation('array-pop', 'const alias = [service].pop()!; alias.run = replacement;', 2, 'containers'),
  mutation('array-at', 'const alias = [service].at(0)!; alias.run = replacement;', 2, 'containers'),
  mutation(
    'array-map',
    'const aliases = [service].map(value => value); aliases[0]!.run = replacement;',
    2,
    'containers',
  ),
  mutation('array-for-of', 'for (const alias of [service]) alias.run = replacement;', 2, 'containers'),
  mutation('array-for-each', '[service].forEach(alias => { alias.run = replacement; });', 2, 'containers'),
  mutation(
    'map-get',
    'const aliases = new Map([["key", service]]); aliases.get("key")!.run = replacement;',
    2,
    'containers',
  ),
  mutation(
    'set-value',
    'const aliases = new Set([service]); aliases.values().next().value!.run = replacement;',
    2,
    'containers',
  ),
  mutation('rest-assignment', 'let copy: { count: number }; ({ ...copy } = service); copy.count++;', 1, 'containers'),
  mutation(
    'nested-rest-assignment',
    'let copy: { nested: typeof service }; ({ ...copy } = { nested: service }); copy.nested.run = replacement;',
    2,
    'containers',
  ),
  mutation(
    'object-assign-copy',
    'const copy = Object.assign({}, { nested: service }); copy.nested.run = replacement;',
    2,
    'containers',
  ),
  mutation(
    'promise-callback-write',
    'await Promise.resolve(service).then(value => { value.run = replacement; });',
    2,
    'async',
  ),
  mutation('await-return-alias', 'const alias = await Promise.resolve(service); alias.run = replacement;', 2, 'async'),
  mutation(
    'generator-alias',
    'function* values() { yield service; } const alias = values().next().value!; alias.run = replacement;',
    2,
    'async',
  ),
  mutation(
    'logical-and-alias',
    'const alias = Boolean(1) && service; if (alias) alias.run = replacement;',
    2,
    'binding',
  ),
  mutation(
    'logical-or-alias',
    'let empty: typeof service | null = null; const alias = empty || service; alias.run = replacement;',
    2,
    'binding',
  ),
  mutation(
    'nullish-alias',
    'let empty: typeof service | null = null; const alias = empty ?? service; alias.run = replacement;',
    2,
    'binding',
  ),
  mutation(
    'conditional-alias',
    'const alias = Boolean(1) ? service : { run: original, count: 0 }; alias.run = replacement;',
    2,
    'binding',
  ),
  mutation(
    'destructure-default-alias',
    'const { value = service } = {} as { value?: typeof service }; value.run = replacement;',
    2,
    'binding',
  ),
  mutation(
    'assignment-chain',
    'let one: typeof service; let two: typeof service; one = two = service; one.run = replacement;',
    2,
    'binding',
  ),
  mutation(
    'logical-assignment-alias',
    'let alias: typeof service | undefined; alias ??= service; alias.run = replacement;',
    2,
    'binding',
  ),
].map((item) =>
  item.source.includes('await ')
    ? { ...item, source: item.source.replace('export function entry()', 'export async function entry()') }
    : item,
);

const calls: Array<[string, string, number, boolean?]> = [
  ['direct-call', 'original()', 1, true],
  ['parenthesized-call', '(original)()', 1, true],
  ['asserted-call', '(original as () => number)()', 1, true],
  ['satisfies-call', '(original satisfies () => number)()', 1, true],
  ['non-null-call', 'original!()', 1, true],
  ['optional-call', 'original?.()', 1, true],
  ['bracket-call', 'service["run"]()', 1, true],
  ['wrapped-bracket-call', 'service[("run" as const)]()', 1, true],
  ['template-bracket-call', 'service[`run`]()', 1, true],
  ['call-method', 'original.call(undefined)', 1],
  ['apply-method', 'original.apply(undefined, [])', 1],
  ['bound-call', 'original.bind(undefined)()', 1],
  ['reflect-apply', 'Reflect.apply(original, undefined, [])', 1],
  ['returned-function', '(() => original)()()', 1],
  ['conditional-function', '(Boolean(1) ? original : replacement)()', 1],
  ['comma-function', '(replacement(), original)()', 1],
  ['immediate-function', '(function inline() { return 1; })()', 1],
  ['immediate-arrow', '(() => 1)()', 1],
];

const classCases: Array<[string, string, string, number]> = [
  [
    'inherited-method',
    'class Base { run() { return 1; } } class Child extends Base {}',
    'const instance = new Child();',
    1,
  ],
  [
    'override-through-base',
    'class Base { run() { return 1; } } class Child extends Base { override run() { return 2; } }',
    'const instance: Base = new Child();',
    2,
  ],
  [
    'constructor-method-write',
    'class Base { run() { return 1; } constructor() { this.run = replacement; } }',
    'const instance = new Base();',
    2,
  ],
  [
    'other-method-write',
    'class Base { run() { return 1; } change() { this.run = replacement; } }',
    'const instance = new Base(); instance.change();',
    2,
  ],
  [
    'prototype-method-write',
    'class Base { run() { return 1; } }',
    'Base.prototype.run = replacement; const instance = new Base();',
    2,
  ],
  [
    'prototype-assign',
    'class Base { run() { return 1; } }',
    'Object.assign(Base.prototype, { run: replacement }); const instance = new Base();',
    2,
  ],
  [
    'prototype-reflect',
    'class Base { run() { return 1; } }',
    'Reflect.set(Base.prototype, "run", replacement); const instance = new Base();',
    2,
  ],
  ['getter-callable', 'class Base { get run() { return replacement; } }', 'const instance = new Base();', 2],
  [
    'proxy-callable',
    'class Base { run() { return 1; } }',
    'const instance = new Proxy(new Base(), { get(target, key, receiver) { return key === "run" ? replacement : Reflect.get(target, key, receiver); } });',
    2,
  ],
  [
    'set-prototype',
    'class Base { run() { return 1; } }',
    'const instance = new Base(); Object.setPrototypeOf(instance, { run: replacement });',
    2,
  ],
  ['field-function', 'class Base { run = original; }', 'const instance = new Base();', 1],
  [
    'static-override',
    'class Base { static run() { return 1; } } class Child extends Base { static override run() { return 2; } }',
    'const instance: typeof Base = Child;',
    2,
  ],
];

const valuePrograms: Array<[string, string, string, unknown]> = [
  ['literal', '', '"/right"', '/right'],
  ['exported-return', 'export function path() { return "/right"; }', 'path()', '/right'],
  ['arrow-return', 'const path = () => "/right";', 'path()', '/right'],
  ['parameter-return', 'function path(value: string) { return value; }', 'path("/right")', '/right'],
  ['default-parameter', 'function path(value = "/default") { return value; }', 'path("/right")', '/right'],
  ['default-omitted', 'function path(value = "/default") { return value; }', 'path()', '/default'],
  [
    'argument-throws',
    'function fail(): never { throw new Error("expected"); } function path(value: never) { return "/wrong"; }',
    'path(fail())',
    { throws: 'expected' },
  ],
  [
    'initializer-throws',
    'function fail(): never { throw new Error("expected"); } function path() { const ignored = fail(); return "/wrong"; }',
    'path()',
    { throws: 'expected' },
  ],
  ['async-return', 'async function path() { return "/right"; }', 'path()', '/right'],
  ['generator-return', 'function* path() { return "/right"; }', 'path().next().value', '/right'],
  ['conditional-return', 'function path() { if (Boolean(1)) return "/right"; return "/other"; }', 'path()', '/right'],
  ['finally-return', 'function path() { try { return "/wrong"; } finally { return "/right"; } }', 'path()', '/right'],
  ['member-literal', 'const paths = { path: "/right", other: 0 }; paths.other++;', 'paths.path', '/right'],
  ['member-bracket', 'const paths = { path: "/right" };', 'paths["path"]', '/right'],
  ['member-wrapped-bracket', 'const paths = { path: "/right" };', 'paths[("path" as const)]', '/right'],
  ['member-template-bracket', 'const paths = { path: "/right" };', 'paths[`path`]', '/right'],
  [
    'member-helper-mutation',
    'const paths = { path: "/wrong" }; function change(value: typeof paths) { value.path = "/right"; } change(paths);',
    'paths.path',
    '/right',
  ],
  [
    'member-object-assign',
    'const paths = { path: "/wrong" }; Object.assign(paths, { path: "/right" });',
    'paths.path',
    '/right',
  ],
  [
    'member-reflect-write',
    'const paths = { path: "/wrong" }; Reflect.set(paths, "path", "/right");',
    'paths.path',
    '/right',
  ],
  ['getter-value', 'const paths = { get path() { return "/right"; } };', 'paths.path', '/right'],
  [
    'object-spread-override',
    'const left = { path: "/wrong" }; const paths = { ...left, path: "/right" };',
    'paths.path',
    '/right',
  ],
  [
    'object-spread-last',
    'const right = { path: "/right" }; const paths = { ...{ path: "/wrong" }, ...right };',
    'paths.path',
    '/right',
  ],
  ['template-value', 'const part = "right";', '`/${part}`', '/right'],
  ['concat-value', 'const part = "right";', '"/" + part', '/right'],
];

export const cases: AuditCase[] = [
  ...mutationCases,
  ...calls.map(([id, expression, expected, required]) => ({
    id,
    area: 'calls',
    expected,
    required,
    source: `${prelude}export function entry() {\n/* probe */ return ${expression};\n}`,
  })),
  ...classCases.map(([id, declarations, setup, expected]) => ({
    id,
    area: 'classes',
    expected,
    source: `${prelude}${declarations}\nexport function entry() {\n${setup}\n/* probe */ return instance.run();\n}`,
    interpretation:
      id === 'getter-callable'
        ? 'Getter evaluation and invocation of its returned value are separate operations.'
        : undefined,
  })),
  ...valuePrograms.map(([id, declarations, expression, expected]) => ({
    id: `value-${id}`,
    area: 'values',
    value: true,
    expected,
    source: `${declarations}\nexport function entry() {\n/* probe */ const probe = ${expression};\nreturn probe;\n}`,
  })),
  {
    id: 'tagged-template',
    area: 'calls',
    expected: 1,
    required: true,
    source:
      'export function tag(_parts: TemplateStringsArray) { return 1; }\nexport function entry() {\n/* probe */ return tag`hello`;\n}',
  },
  {
    id: 'constructor',
    area: 'calls',
    expected: 1,
    required: true,
    source: 'class Box { value = 1; }\nexport function entry() {\n/* probe */ return new Box().value;\n}',
  },
  {
    id: 'saved-function-snapshot',
    area: 'ordering',
    expected: 1,
    source: `${prelude}const saved = service.run; service.run = replacement;\nexport function entry() {\n/* probe */ return saved();\n}`,
  },
  {
    id: 'write-after-call',
    area: 'ordering',
    expected: 1,
    source: `${prelude}export function entry() {\n/* probe */ const result = service.run();\nservice.run = replacement; return result;\n}`,
  },
  {
    id: 'write-then-restore',
    area: 'ordering',
    expected: 1,
    source: `${prelude}service.run = replacement; service.run = original;\nexport function entry() {\n/* probe */ return service.run();\n}`,
  },
];

// Exhaustive within this finite Cartesian product: 5 holders × 4 alias forms ×
// 4 writes × 4 receiver wrappers = 320 independently executable programs.
const holders = [
  ['', 'service'],
  ['const holder = { value: service };', 'holder.value'],
  ['const holder = [service];', 'holder[0]!'],
  ['const holder = { ...{ value: service } };', 'holder.value'],
  ['const [...holder] = [service];', 'holder[0]!'],
];
const aliases = [
  (x: string) => x,
  (x: string) => `(${x})`,
  (x: string) => `(${x} as typeof service)`,
  (x: string) => `(${x} satisfies typeof service)`,
];
const writes = [
  (x: string) => `${x}.run = replacement;`,
  (x: string) => `Reflect.set(${x}, "run", replacement);`,
  (x: string) => `Object.assign(${x}, { run: replacement });`,
  (x: string) => `${x}.count++;`,
];
for (let h = 0; h < holders.length; h++)
  for (let a = 0; a < aliases.length; a++)
    for (let w = 0; w < writes.length; w++)
      for (let r = 0; r < aliases.length; r++) {
        const [setup, value] = holders[h]!;
        cases.push({
          id: `generated-${h}-${a}-${w}-${r}`,
          area: 'generated',
          expected: w === 3 ? 1 : 2,
          source: `${prelude}export function entry() {\n${setup}\nconst alias = ${aliases[a]!(value!)};\n${writes[w]!('alias')}\n/* probe */ return ${aliases[r]!('service')}.run();\n}`,
        });
      }
