import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { quoteShellArgument } from '../../src/platform/shell-arguments.js';

describe('shell argument quoting', () => {
  it('quotes POSIX values, including embedded apostrophes', () => {
    expect(quoteShellArgument("owner's helper", { platform: 'darwin' })).toBe(`'owner'"'"'s helper'`);
  });

  it.runIf(process.platform !== 'win32')(
    'round-trips printed selectors through the host shell as one literal argument',
    () => {
      const values = [
        '',
        "owner's helper",
        'src/a b.ts:2',
        '$(echo expanded)',
        '`echo expanded`',
        'line\nnext',
        '"quoted"',
      ];
      const command = `printf '%s\\0' ${values.map((value) => quoteShellArgument(value)).join(' ')}`;
      expect(execFileSync('/bin/sh', ['-c', command]).toString().split('\0')).toEqual([...values, '']);
    },
  );

  it('keeps safe continuation arguments compact when requested', () => {
    expect(quoteShellArgument('src/example.ts', { platform: 'linux', omitSafeQuotes: true })).toBe('src/example.ts');
  });

  it('quotes Windows hook arguments with the existing percent and quote escaping', () => {
    expect(quoteShellArgument('100% "ready"', { platform: 'win32' })).toBe('"100%% \\"ready\\""');
  });
});
