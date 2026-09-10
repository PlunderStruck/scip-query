import type { AuditCase } from './cases.js';

// Independent expectations describe closed executions, not copied tool answers.
function value(id: string, setup: string, expression: string, expected: unknown, prefix = ''): AuditCase {
  return {
    id: `breadth-${id}`,
    area: 'breadth-value',
    value: true,
    expected,
    source: `${prefix}\nexport function entry() {\n${setup}\n/* probe */ const probe = ${expression};\nreturn probe;\n}`,
  };
}

const sharedEscapes: AuditCase[] = [];
const escapes = [
  ['factory', 'export function access() { return box; }', 'access()', 'import { access }'],
  ['closure', 'export const access = () => box;', 'access()', 'import { access }'],
  ['object-getter', 'export const access = { get current() { return box; } };', 'access.current', 'import { access }'],
  ['array', 'export const access = [box];', 'access[0]!', 'import { access }'],
  ['object', 'export const access = { current: box };', 'access.current', 'import { access }'],
  ['map', 'export const access = new Map([["key", box]]);', 'access.get("key")!', 'import { access }'],
  ['set', 'export const access = new Set([box]);', '[...access][0]!', 'import { access }'],
  ['default-factory', 'export default function access() { return box; }', 'access()', 'import access'],
  ['destructure', 'export const access = { current: box };', 'current', 'import { access }'],
  ['reexport', 'export function access() { return box; }', 'access()', 'import { access }'],
] as const;
for (const [name, expose, alias, imported] of escapes) {
  for (const directReader of [false, true]) {
    const id = `escape-${name}-${directReader ? 'imported-reader' : 'owner-reader'}`;
    const owner = `${id}-owner.ts`;
    const writer = `${id}-writer.ts`;
    const reader = directReader ? 'box.path' : 'read()';
    const c = value(
      id,
      'change();',
      reader,
      '/right',
      `import { ${directReader ? 'box' : 'read'} } from './${owner.replace('.ts', '.js')}';\nimport { change } from './${writer.replace('.ts', '.js')}';`,
    );
    c.files = {
      [owner]: `export const box = { path: '/wrong', stable: '/stable' };\n${expose}\nexport function read() { return box.path; }`,
      [writer]: `${imported} from './${name === 'reexport' ? id + '-barrel.js' : owner.replace('.ts', '.js')}';\nexport function change() { ${name === 'destructure' ? 'const { current } = access;' : ''} ${alias}.path = '/right'; }`,
    };
    if (name === 'reexport') c.files[`${id}-barrel.ts`] = `export { access } from './${owner.replace('.ts', '.js')}';`;
    sharedEscapes.push(c);
  }
}

const values: AuditCase[] = [
  value('positive-literal', '', '"/right"', '/right'),
  value('positive-helper', '', 'read()', '/right', 'function read() { return "/right"; }'),
  value('positive-property', 'const box = { path: "/right" };', 'box.path', '/right'),
  value(
    'object-create-prototype',
    'const base = { path: "/wrong" }; const alias = Object.create(base); alias.path = "/right";',
    'base.path',
    '/wrong',
  ),
  value(
    'object-create-setter',
    'const box = { path: "/wrong" }; const base = { set x(v: string) { box.path = v; } }; const alias = Object.create(base); alias.x = "/right";',
    'box.path',
    '/right',
  ),
  value(
    'prototype-getter',
    'const box = { path: "/wrong" }; const target = Object.create({ get x() { box.path = "/right"; return 0; } }); void target.x;',
    'box.path',
    '/right',
  ),
  value(
    'define-getter-read',
    'const box = { path: "/wrong" }; const target = {}; Object.defineProperty(target, "x", { get() { box.path = "/right"; return 0; } }); void (target as any).x;',
    'box.path',
    '/right',
  ),
  value(
    'reflect-delete',
    'const box: { path?: string } = { path: "/wrong" }; Reflect.deleteProperty(box, "path");',
    'box.path ?? "/right"',
    '/right',
  ),
  value(
    'reflect-prototype',
    'const box = { path: "/wrong" }; const target = {}; Reflect.setPrototypeOf(target, { get x() { box.path = "/right"; return 0; } }); void (target as any).x;',
    'box.path',
    '/right',
  ),
  value(
    'assign-getter',
    'const box = { path: "/wrong" }; Object.assign({}, { get x() { box.path = "/right"; return 0; } });',
    'box.path',
    '/right',
  ),
  value(
    'stringify-getter',
    'const box = { path: "/wrong" }; JSON.stringify({ get x() { box.path = "/right"; return 0; } });',
    'box.path',
    '/right',
  ),
  value(
    'stringify-tojson',
    'const box = { path: "/wrong" }; JSON.stringify({ toJSON() { box.path = "/right"; return 0; } });',
    'box.path',
    '/right',
  ),
  value(
    'regex-replacer',
    'const box = { path: "/wrong" }; "x".replace(/x/, () => { box.path = "/right"; return "y"; });',
    'box.path',
    '/right',
  ),
  value(
    'array-sort-callback',
    'const box = { path: "/wrong" }; [2,1].sort(() => { box.path = "/right"; return 1; });',
    'box.path',
    '/right',
  ),
  value(
    'symbol-key-coercion',
    'const box = { path: "/wrong" }; const key = { toString() { box.path = "/right"; return "x"; } }; const target: any = {}; target[key as any] = 1;',
    'box.path',
    '/right',
  ),
  value(
    'with-same-primitive-pass',
    'const box = { path: "/right" }; function consume(_x: string) {} consume(box.path);',
    'box.path',
    '/right',
  ),
  value(
    'argument-order-assignment',
    'let path = "/wrong"; function read(_x: string, _y: string) { return path; }',
    'read(path, path = "/right")',
    '/right',
  ),
  value(
    'default-writes-sibling',
    'let path = "/wrong"; function read(_x = (path = "/right")) { return path; }',
    'read()',
    '/right',
  ),
  value(
    'parameter-shadows-path',
    'const path = "/wrong"; function read(path: string) { return path; }',
    'read("/right")',
    '/right',
  ),
  value('async-helper', '', 'read()', '/right', 'async function read() { return "/right"; }'),
  value('generator-helper', '', 'read().next().value', '/right', 'function* read() { yield "/right"; }'),
  value('optional-null-call', 'const read = null as (() => string) | null;', 'read?.() ?? "/right"', '/right'),
  value(
    'optional-effect-skipped',
    'let path = "/right"; const read = null as ((x: string) => string) | null; read?.(path = "/wrong");',
    'path',
    '/right',
  ),
  value(
    'nullish-false',
    'const input: boolean | null = JSON.parse("false");',
    '(input ?? true) ? "/wrong" : "/right"',
    '/right',
  ),
  value(
    'nullish-zero',
    'const input: number | null = JSON.parse("0");',
    '(input ?? 1) === 0 ? "/right" : "/wrong"',
    '/right',
  ),
  value('logical-short-circuit', '', 'false && "wrong" || "/right"', '/right'),
  value('numeric-separator', '', '1_000 + 2', 1002),
  value('hexadecimal', '', '0xff + 1', 256),
  value('binary', '', '0b101 + 1', 6),
  value('octal', '', '0o10 + 1', 9),
  value('bigint-equality', '', '1n === 1n ? "/right" : "/wrong"', '/right'),
  value('negative-zero', '', 'Object.is(-0, 0) ? "/wrong" : "/right"', '/right'),
  value('nan-equality', 'const input = Number("not a number");', 'input === input ? "/wrong" : "/right"', '/right'),
  value('surrogate-length', '', '"😀".length', 2),
  value('unicode-escaped-string', '', '"\\u{1F600}"', '😀'),
  value('template-escape', '', '`\\u{1F600}`', '😀'),
  value('regex-escape-string', '', '"a\\x2fb"', 'a/b'),
  value('string-line-continuation', '', '"/ri\\\nght"', '/right'),
];

for (const [name, write, expected] of [
  ['reverse', 'paths.reverse();', '/right'],
  ['sort', 'paths.sort();', '/right'],
  ['copywithin', 'paths.copyWithin(0, 1);', '/right'],
  ['fill', 'paths.fill("/right");', '/right'],
  ['splice', 'paths.splice(0, 1, "/right");', '/right'],
  ['shift', 'paths.shift();', '/right'],
  ['unshift', 'paths.unshift("/right");', '/right'],
  ['push-control', 'paths.push("/right");', '/wrong'],
  ['length', 'paths.length = 0;', '/right'],
] as const)
  values.push(value(`array-${name}`, `const paths = ["/wrong", "/right"]; ${write}`, 'paths[0] ?? "/right"', expected));

const calls: AuditCase[] = [];
for (const [name, setup] of [
  ['array-reverse', 'const items = [obj, { run: second }]; items.reverse(); items[1]!.run = second;'],
  ['factory', 'function access() { return obj; } access().run = second;'],
  ['weakmap', 'const key = {}; const map = new WeakMap([[key, obj]]); map.get(key)!.run = second;'],
  ['promise', 'await Promise.resolve(obj).then(x => { x.run = second; });'],
  ['iterator', 'const values = new Set([obj]); values.values().next().value!.run = second;'],
  ['descriptors', 'Object.defineProperties(obj, { run: { value: second } });'],
  ['reflect-apply', 'Reflect.apply(function(this: typeof obj) { this.run = second; }, obj, []);'],
  ['bound-writer', 'function change(this: typeof obj) { this.run = second; } change.bind(obj)();'],
] as const)
  calls.push({
    id: `breadth-call-${name}`,
    area: 'breadth-call',
    expected: 2,
    traceCallee: true,
    source: `function first() { return 1; }\nfunction second() { return 2; }\nconst obj = { run: first };\nexport async function entry() {\n${setup}\n/* probe */ return obj.run();\n}`,
  });

const arithmetic: AuditCase[] = [];
for (const [name, expression, expected] of [
  ['addition', '1 + 2', 3],
  ['subtraction', '5 - 2', 3],
  ['multiplication', '2 * 3', 6],
  ['division', '6 / 2', 3],
  ['remainder', '7 % 4', 3],
  ['exponent', '2 ** 3', 8],
  ['shift', '1 << 2', 4],
  ['bitwise', '1 | 2', 3],
  ['unary', '-2', -2],
  ['separator', '1_000 + 2', 1002],
  ['hex', '0xff + 1', 256],
  ['boolean', 'true', true],
  ['null', 'null', null],
  ['undefined', 'undefined', undefined],
] as const) {
  arithmetic.push(value(`path-${name}`, '', `"/item/" + (${expression})`, `/item/${expected}`));
  arithmetic.push(value(`template-${name}`, '', '`/item/${' + expression + '}`', `/item/${expected}`));
}

const ownProperties: AuditCase[] = [];
for (const [name, setup, expected] of [
  [
    'spread-shadow',
    'const first: { path?: string } = { path: "/wrong" }; const obj = { path: "/first", ...first, path2: "/unused" };',
    '/wrong',
  ],
  ['spread-override', 'const first = { path: "/wrong" }; const obj = { ...first, path: "/right" };', '/right'],
  ['computed-key', 'const key = "pa" + "th"; const obj = { path: "/wrong", [key]: "/right" };', '/right'],
  ['proto-own', 'const obj = { __proto__: { path: "/wrong" }, path: "/right" };', '/right'],
  ['get-set', 'const obj = { get path() { return "/right"; }, set path(_value: string) {} };', '/right'],
  ['numeric-property', 'const obj = { 0x10: "/right" };', '/right'],
] as const)
  ownProperties.push(value(`own-${name}`, setup, name === 'numeric-property' ? 'obj[16]' : 'obj.path', expected));

export const breadthCases: AuditCase[] = [...sharedEscapes, ...values, ...calls, ...arithmetic, ...ownProperties];
