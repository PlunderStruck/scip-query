import { describe, expect, it } from 'vitest';
import { quoteShellArgument } from '../../src/platform/shell-arguments.js';

describe('shell argument quoting', () => {
  it('quotes POSIX values, including embedded apostrophes', () => {
    expect(quoteShellArgument("owner's helper", { platform: 'darwin' })).toBe(`'owner'"'"'s helper'`);
  });

  it('keeps safe continuation arguments compact when requested', () => {
    expect(quoteShellArgument('src/example.ts', { platform: 'linux', omitSafeQuotes: true })).toBe('src/example.ts');
  });

  it('quotes Windows hook arguments with the existing percent and quote escaping', () => {
    expect(quoteShellArgument('100% "ready"', { platform: 'win32' })).toBe('"100%% \\"ready\\""');
  });
});
