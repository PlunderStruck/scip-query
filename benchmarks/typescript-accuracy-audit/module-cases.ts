import type { AuditCase } from './cases.js';

function scenario(
  id: string,
  owner: string,
  imported: string,
  setup: string,
  expression: string,
  expected: number,
  extra: Record<string, string> = {},
  required = false,
): AuditCase {
  const prefix = `module-${id}`;
  const substitute = (text: string) =>
    text
      .replaceAll('@owner', `./${prefix}-owner.js`)
      .replaceAll('@barrel', `./${prefix}-barrel.js`)
      .replaceAll('@writer', `./${prefix}-writer.js`);
  return {
    id: prefix,
    area: 'modules',
    expected,
    required,
    source: `${substitute(imported)}\n${substitute(setup)}\nexport function entry() {\n/* probe */ return ${expression};\n}`,
    files: {
      [`${prefix}-owner.ts`]: substitute(owner),
      ...Object.fromEntries(
        Object.entries(extra).map(([name, source]) => [`${prefix}-${name}.ts`, substitute(source)]),
      ),
    },
  };
}
const owner = `export function original() { return 1; }
export function replacement() { return 2; }
export class Service { run() { return 1; } }
export const service = new Service();`;

export const moduleCases: AuditCase[] = [
  scenario('named-control', owner, 'import { original } from "@owner";', '', 'original()', 1, {}, true),
  scenario('namespace-control', owner, 'import * as api from "@owner";', '', 'api.original()', 1, {}, true),
  scenario(
    'default-control',
    'export default function original() { return 1; }',
    'import original from "@owner";',
    '',
    'original()',
    1,
    {},
    true,
  ),
  scenario(
    'anonymous-default',
    'export default function() { return 1; }',
    'import original from "@owner";',
    '',
    'original()',
    1,
    {},
    true,
  ),
  scenario('default-arrow', 'export default () => 1;', 'import original from "@owner";', '', 'original()', 1, {}, true),
  scenario(
    'reexport-control',
    owner,
    'import { renamed } from "@barrel";',
    '',
    'renamed()',
    1,
    { barrel: 'export { original as renamed } from "@owner";' },
    true,
  ),
  scenario(
    'star-control',
    owner,
    'import { original } from "@barrel";',
    '',
    'original()',
    1,
    { barrel: 'export * from "@owner";' },
    true,
  ),
  scenario(
    'namespace-reexport-control',
    owner,
    'import { api } from "@barrel";',
    '',
    'api.original()',
    1,
    { barrel: 'export * as api from "@owner";' },
    true,
  ),
  scenario(
    'direct-import-write',
    owner,
    'import { service, replacement } from "@owner";',
    'service.run = replacement;',
    'service.run()',
    2,
  ),
  scenario(
    'side-effect-import-write',
    owner,
    'import { service } from "@owner"; import "@writer";',
    '',
    'service.run()',
    2,
    { writer: 'import { service, replacement } from "@owner"; service.run = replacement;' },
  ),
  scenario(
    'writer-function',
    owner,
    'import { service } from "@owner"; import { change } from "@writer";',
    'change();',
    'service.run()',
    2,
    {
      writer: 'import { service, replacement } from "@owner"; export function change() { service.run = replacement; }',
    },
  ),
  scenario(
    'imported-object-assign',
    owner,
    'import { service, replacement } from "@owner";',
    'Object.assign(service, { run: replacement });',
    'service.run()',
    2,
  ),
  scenario(
    'owner-object-assign',
    owner + '\nObject.assign(service, { run: replacement });',
    'import { service } from "@owner";',
    '',
    'service.run()',
    2,
  ),
  scenario(
    'owner-direct-write',
    owner + '\nservice.run = replacement;',
    'import { service } from "@owner";',
    '',
    'service.run()',
    2,
  ),
  scenario(
    'namespace-member-write',
    'export namespace api { export function run() { return 1; } }\napi.run = () => 2;',
    'import { api } from "@owner";',
    '',
    'api.run()',
    2,
  ),
  scenario(
    'namespace-reexport-write',
    owner,
    'import { api } from "@barrel"; import "@writer";',
    '',
    'api.service.run()',
    2,
    {
      barrel: 'export * as api from "@owner";',
      writer: 'import { service, replacement } from "@owner"; service.run = replacement;',
    },
  ),
  scenario(
    'live-let-export',
    'function original() { return 1; } function replacement() { return 2; }\nexport let selected = original; selected = replacement;',
    'import { selected } from "@owner";',
    '',
    'selected()',
    2,
  ),
  scenario(
    'default-snapshot',
    'let selected = () => 1; export default selected; selected = () => 2;',
    'import selected from "@owner";',
    '',
    'selected()',
    1,
  ),
  scenario(
    'default-live-alias',
    'let selected = () => 1; export { selected as default }; selected = () => 2;',
    'import selected from "@owner";',
    '',
    'selected()',
    2,
  ),
  scenario(
    'function-replacement',
    owner.replace('export function original() { return 1; }', 'export let original = () => 1;') +
      '\noriginal = replacement;',
    'import { original } from "@owner";',
    '',
    'original()',
    2,
  ),
  scenario(
    'function-replacement-barrel',
    owner.replace('export function original() { return 1; }', 'export let original = () => 1;') +
      '\noriginal = replacement;',
    'import { original } from "@barrel";',
    '',
    'original()',
    2,
    { barrel: 'export * from "@owner";' },
  ),
];
