import { describe, expect, it } from 'vitest';
import { parseProcessIdentity } from '../../src/domain/process-identity.js';
import { projectInputSnapshotOrNull } from '../../src/domain/project-input.js';

describe('worker 2 validation ordering regressions', () => {
  it('retains process identity property access ordering through validation and projection', () => {
    const reads: string[] = [];
    const values = { version: 1, pid: 42, platform: 'linux', startToken: 'started' };
    const input = Object.fromEntries(Object.keys(values).map((key) => [key, undefined]));
    for (const key of Object.keys(values) as Array<keyof typeof values>) {
      Object.defineProperty(input, key, {
        get() {
          reads.push(key);
          return values[key];
        },
      });
    }
    expect(parseProcessIdentity(input)).toEqual(values);
    expect(reads).toEqual([
      'version',
      'pid',
      'pid',
      'pid',
      'platform',
      'platform',
      'startToken',
      'startToken',
      'pid',
      'platform',
      'startToken',
    ]);
  });

  it('rejects the version before consulting later process fields', () => {
    expect(
      parseProcessIdentity({
        version: 2,
        get pid() {
          throw new Error('must not read');
        },
      }),
    ).toBeNull();
  });

  it('retains snapshot acceptance for sparse file arrays and returns the input identity', () => {
    const snapshot = {
      version: 1,
      languages: [],
      pnpmWorkspaces: false,
      typescriptProjectMode: '',
      typescriptProjects: [],
      files: new Array(2),
    };
    expect(projectInputSnapshotOrNull(snapshot)).toBe(snapshot);
  });
});
