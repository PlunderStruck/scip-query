import { describe, expect, it } from 'vitest';
import {
  parseProcessIdentity,
  readProcessIdentity,
  sameProcessIdentity,
  type ProcessIdentity,
} from '../../src/platform/process-identity.js';

const IDENTITY: ProcessIdentity = {
  version: 1,
  pid: 42,
  platform: 'linux',
  startToken: '987654',
};

describe('process identity', () => {
  it('reads Linux start ticks from proc stat even when the command name contains spaces and parentheses', () => {
    const identity = readProcessIdentity(42, {
      platform: 'linux',
      readFile: () => '42 (scip query (worker)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20 21\n',
      run: () => {
        throw new Error('unexpected command');
      },
    });

    expect(identity).toEqual(IDENTITY);
  });

  it('reads a stable process start token from ps on macOS', () => {
    const calls: Array<{ binary: string; args: readonly string[] }> = [];
    const identity = readProcessIdentity(77, {
      platform: 'darwin',
      readFile: () => {
        throw new Error('unexpected read');
      },
      run: (binary, args) => {
        calls.push({ binary, args });
        return 'Sat Jul 25 12:34:56 2026\n';
      },
    });

    expect(identity).toEqual({
      version: 1,
      pid: 77,
      platform: 'darwin',
      startToken: 'Sat Jul 25 12:34:56 2026',
    });
    expect(calls).toEqual([{ binary: 'ps', args: ['-p', '77', '-o', 'lstart='] }]);
  });

  it('uses a millisecond process-start token on Windows', () => {
    const identity = readProcessIdentity(88, {
      platform: 'win32',
      readFile: () => {
        throw new Error('unexpected read');
      },
      run: (_binary, args) => {
        expect(args.join(' ')).toContain('Get-Process -Id 88');
        return '1785000000123\r\n';
      },
    });

    expect(identity).toEqual({
      version: 1,
      pid: 88,
      platform: 'win32',
      startToken: '1785000000123',
    });
  });

  it('returns null when identity is unavailable and strictly validates persisted records', () => {
    expect(
      readProcessIdentity(42, {
        platform: 'linux',
        readFile: () => {
          throw new Error('gone');
        },
        run: () => {
          throw new Error('unexpected command');
        },
      }),
    ).toBeNull();
    expect(parseProcessIdentity(IDENTITY)).toEqual(IDENTITY);
    expect(parseProcessIdentity({ ...IDENTITY, pid: 43 })).toEqual({ ...IDENTITY, pid: 43 });
    expect(parseProcessIdentity({ ...IDENTITY, startToken: '' })).toBeNull();
    expect(parseProcessIdentity({ ...IDENTITY, version: 2 })).toBeNull();
  });

  it('matches every identity component and rejects PID reuse', () => {
    expect(sameProcessIdentity(IDENTITY, { ...IDENTITY })).toBe(true);
    expect(sameProcessIdentity(IDENTITY, { ...IDENTITY, startToken: 'later' })).toBe(false);
    expect(sameProcessIdentity(IDENTITY, { ...IDENTITY, pid: 43 })).toBe(false);
    expect(sameProcessIdentity(IDENTITY, { ...IDENTITY, platform: 'darwin' })).toBe(false);
  });
});
