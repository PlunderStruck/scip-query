import { afterEach, describe, expect, it, vi } from 'vitest';
import { displayPathRange, displaySnippet, render } from '../../src/runtime/render.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('human renderer terminal safety', () => {
  it('makes malicious path, symbol, documentation, source, and table rows inert', () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)));
    const attack = 'owned\x1b]52;c;c2VjcmV0\x07\r\b\n\t\u202E';

    render.groupedByFile(
      [{ relativePath: attack, symbol: attack }],
      (item) => `${item.symbol} ${displayPathRange(item.relativePath, 0, 1)}`,
    );
    render.sectionedReport([
      {
        title: attack,
        explanation: attack,
        rows: [displaySnippet(attack)],
      },
    ]);
    render.table([attack], [attack]);

    const hasTerminalControl = [...output.join('\n')].some((character) => {
      const code = character.charCodeAt(0);
      return (code <= 0x09 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) && code !== 0x0a;
    });
    expect(hasTerminalControl).toBe(false);
    expect(output.join('\n')).not.toContain('\u202E');
    expect(output.join('\n')).not.toContain('c2VjcmV0');
    expect(output).toEqual(
      expect.arrayContaining([
        `owned\u240D\u2408\u2424\u2409\uFFFD`,
        expect.stringContaining('owned\u240D\u2408\u2424\u2409\uFFFD'),
      ]),
    );
  });

  it('preserves source-shaped line breaks only when a section opts in', () => {
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)));

    render.sectionedReport([
      { title: 'SOURCE', rows: ['file.ts:1-2\n     1  first\n     2  second'], preserveRowNewlines: true },
      { title: 'UNTRUSTED', rows: ['first\nsecond'] },
    ]);

    expect(output).toContain('file.ts:1-2');
    expect(output).toContain('     1  first');
    expect(output).toContain('     2  second');
    expect(output).toContain('first␤second');
  });
});
