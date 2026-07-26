import { describe, expect, it, vi } from 'vitest';
import {
  installTerminalConsoleSanitizer,
  sanitizeTerminalLine,
  sanitizeTerminalText,
  writeSerializedJson,
} from '../../src/platform/terminal-output.js';

const dangerous =
  'path\x1b[31mred\x1b[0m' +
  '\x1b]8;;https://attacker.test\x07link\x1b]8;;\x07' +
  '\x1b]52;c;Y2xpcGJvYXJk\x07' +
  '\r\b\n\t\u202Eend';

describe('terminal output sanitization', () => {
  it('removes CSI, OSC hyperlink, and OSC clipboard protocols and neutralizes row controls', () => {
    expect(sanitizeTerminalLine(dangerous)).toBe('pathredlink\u240D\u2408\u2424\u2409\uFFFDend');
  });

  it('preserves only explicitly allowed human text layout', () => {
    expect(sanitizeTerminalText(dangerous)).toBe('pathredlink\u240D\u2408\n\t\uFFFDend');
  });

  it('handles C1 and unterminated terminal strings without leaking payloads', () => {
    expect(sanitizeTerminalLine(`before\u009b31mred\u009b0mafter`)).toBe('beforeredafter');
    expect(sanitizeTerminalLine(`before\u009d52;c;secret`)).toBe('before');
  });

  it('sanitizes string console arguments while preserving structured values', () => {
    const calls: unknown[][] = [];
    const target = {
      log: vi.fn((...values: unknown[]) => calls.push(values)),
      error: vi.fn(),
      warn: vi.fn(),
    };
    const restore = installTerminalConsoleSanitizer(target);
    const structured = { value: dangerous };

    target.log(dangerous, structured);
    restore();

    expect(calls).toEqual([['pathredlink\u240D\u2408\n\t\uFFFDend', structured]]);
  });

  it('writes serialized JSON without applying human terminal transformations', () => {
    const json = JSON.stringify({ value: dangerous });
    let rendered = '';
    writeSerializedJson(json, (value) => {
      rendered += value;
    });

    expect(rendered).toBe(`${json}\n`);
    expect(JSON.parse(rendered)).toEqual({ value: dangerous });
  });
});
