import { describe, expect, it } from 'vitest';
import { resolveSpawnableExecutable, toPortableCommand } from '../../src/platform/binary.js';

describe('toPortableCommand', () => {
  it('runs .js bin targets through the current Node executable', () => {
    const result = toPortableCommand('/x/node_modules/@sourcegraph/scip-typescript/dist/main.js', [
      'index',
      '--output',
      'out.scip',
    ]);
    expect(result.binary).toBe(process.execPath);
    expect(result.args).toEqual([
      '/x/node_modules/@sourcegraph/scip-typescript/dist/main.js',
      'index',
      '--output',
      'out.scip',
    ]);
  });

  it.each(['main.cjs', 'main.mjs', 'MAIN.JS'])('rewrites %s the same way', (file) => {
    expect(toPortableCommand(`/bin/${file}`, []).binary).toBe(process.execPath);
  });

  it('leaves native executables and bare names untouched', () => {
    expect(toPortableCommand('scip-java', ['index'])).toEqual({ binary: 'scip-java', args: ['index'] });
    expect(toPortableCommand('C:\\tools\\scip.exe', [])).toEqual({ binary: 'C:\\tools\\scip.exe', args: [] });
  });
});

describe('resolveSpawnableExecutable', () => {
  it('returns the first match on POSIX', () => {
    const resolved = resolveSpawnableExecutable('scip-typescript', {
      isWindows: false,
      lookup: () => '/usr/local/bin/scip-typescript\n',
    });
    expect(resolved).toBe('/usr/local/bin/scip-typescript');
  });

  it('rejects Windows shim scripts and picks only real executables', () => {
    const shimOnly = resolveSpawnableExecutable('scip-typescript', {
      isWindows: true,
      lookup: () =>
        'C:\\Users\\a\\AppData\\Roaming\\npm\\scip-typescript\r\nC:\\Users\\a\\AppData\\Roaming\\npm\\scip-typescript.cmd\r\n',
    });
    expect(shimOnly).toBeNull();

    const withExe = resolveSpawnableExecutable('scip', {
      isWindows: true,
      lookup: () => 'C:\\tools\\scip\r\nC:\\tools\\scip.exe\r\n',
    });
    expect(withExe).toBe('C:\\tools\\scip.exe');
  });

  it('returns null when lookup fails', () => {
    const resolved = resolveSpawnableExecutable('missing', {
      isWindows: true,
      lookup: () => {
        throw new Error('not found');
      },
    });
    expect(resolved).toBeNull();
  });
});
