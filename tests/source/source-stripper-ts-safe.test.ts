import { describe, expect, it } from 'vitest';
import { stripComments, stripCommentsAndStringsTsSafe } from '../../src/source/primitives/source-stripper.js';

const cases = [
  {
    label: 'quoted comment openers',
    input: 'const url = "https://host/*x*/"; // hide\nnext()',
    comments: 'const url = "https://host/*x*/";        \nnext()',
    strings: 'const url =                    ;        \nnext()',
  },
  {
    label: 'multiline block',
    input: 'a/*x\ny*/b',
    comments: 'a   \n   b',
    strings: 'a   \n   b',
  },
  {
    label: 'unterminated block',
    input: 'a/*tail',
    comments: 'a      ',
    strings: 'a      ',
  },
  {
    label: 'unterminated single quote',
    input: "a = 'tail\nnext()",
    comments: "a = 'tail\nnext()",
    strings: 'a =      \nnext()',
  },
  {
    label: 'multiline template',
    input: 'a = `one\ntwo`; b',
    comments: 'a = `one\ntwo`; b',
    strings: 'a =     \n    ; b',
  },
  {
    label: 'escaped closing quote',
    input: "a = 'don\\'t'; // tail",
    comments: "a = 'don\\'t';        ",
    strings: 'a =         ;        ',
  },
  {
    label: 'trailing escape',
    input: "'x\\",
    comments: "'x\\",
    strings: '    ',
  },
  {
    label: 'empty source',
    input: '',
    comments: '',
    strings: '',
  },
];

describe('TypeScript-safe comment and string masking', () => {
  it.each(cases)('$label', ({ input, comments, strings }) => {
    expect(stripComments(input)).toBe(comments);
    expect(stripCommentsAndStringsTsSafe(input)).toBe(strings);
  });
});
