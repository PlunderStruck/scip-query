import type { AuditCase } from './cases.js';

const forms: Array<[string, string, string, Array<[number, number]>, string, boolean]> = [
  [
    'direct',
    '',
    'consume(first, second)',
    [
      [0, 0],
      [1, 1],
    ],
    'left/right',
    true,
  ],
  [
    'swapped',
    '',
    'consume(second, first)',
    [
      [1, 0],
      [0, 1],
    ],
    'right/left',
    true,
  ],
  [
    'parentheses',
    '',
    'consume((first), (second))',
    [
      [0, 0],
      [1, 1],
    ],
    'left/right',
    true,
  ],
  [
    'assertion',
    '',
    'consume(first as string, second!)',
    [
      [0, 0],
      [1, 1],
    ],
    'left/right',
    true,
  ],
  [
    'satisfies',
    '',
    'consume(first satisfies string, second)',
    [
      [0, 0],
      [1, 1],
    ],
    'left/right',
    true,
  ],
  [
    'constant-alias',
    'const alias = first;',
    'consume(alias, second)',
    [
      [0, 0],
      [1, 1],
    ],
    'left/right',
    false,
  ],
  ['transformed', '', 'consume(first + "!", second)', [[1, 1]], 'left!/right', true],
  ['literal', '', 'consume("literal", second)', [[1, 1]], 'literal/right', true],
  [
    'spread-tuple',
    'const values: [string, string] = [first, second];',
    'consume(...values)',
    [
      [0, 0],
      [1, 1],
    ],
    'left/right',
    false,
  ],
  ['local-shadow', 'const alias = { first: "local" };', 'consume(alias.first, second)', [[1, 1]], 'local/right', true],
];

export const flowCases: AuditCase[] = forms.map(([name, setup, call, expected, runtime, required]) => ({
  id: `flow-${name}`,
  area: 'dataflow',
  expected: runtime,
  flow: { expected, required },
  source: `export function consume(a: string, b: string) { return a + "/" + b; }\nexport function entry(first = "left", second = "right") {\n${setup}\n/* probe */ return ${call};\n}`,
}));
