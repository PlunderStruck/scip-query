import { describe, expect, it } from 'vitest';
import { cliInvocationPrefix } from '../../src/runtime/cli-invocation.js';

describe('CLI invocation prefix', () => {
  it('uses the short command for an installed scip-query executable', () => {
    expect(
      cliInvocationPrefix(
        ['/opt/homebrew/Cellar/node/26.7.0/bin/node', '/opt/homebrew/bin/scip-query'],
        '/opt/homebrew/Cellar/node/26.7.0/bin/node',
      ),
    ).toEqual(['scip-query']);
  });

  it('pins the runtime and script for a development entrypoint', () => {
    expect(cliInvocationPrefix(['/usr/local/bin/node', '/repo/dist/cli.js'], '/usr/local/bin/node')).toEqual([
      '/usr/local/bin/node',
      '/repo/dist/cli.js',
    ]);
  });

  it('falls back to the installed command when no script path is available', () => {
    expect(cliInvocationPrefix(['/usr/local/bin/node'], '/usr/local/bin/node')).toEqual(['scip-query']);
  });
});
