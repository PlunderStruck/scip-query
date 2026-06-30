import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  groupAnalysisTasks,
  runAnalysisTasks,
  runIsolatedJsonProcessAsync,
} from '../../src/runtime/isolated-analysis-runner.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('analysis scheduler', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('preserves input order while running tasks concurrently', async () => {
    const completionOrder: number[] = [];
    let active = 0;
    let maxActive = 0;

    const results = await runAnalysisTasks([30, 5, 10], 2, async (duration) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(duration);
      active -= 1;
      completionOrder.push(duration);
      return duration / 5;
    });

    expect(results).toEqual([6, 1, 2]);
    expect(completionOrder).toEqual([5, 10, 30]);
    expect(maxActive).toBe(2);
  });

  it('groups first-seen task families and keeps unrelated tasks as singletons', () => {
    const reactTasks = new Set(['react-component', 'react-hook']);
    const vueTasks = new Set(['vue-component', 'suppressions']);

    expect(
      groupAnalysisTasks(
        ['overview', 'react-component', 'dead', 'vue-component', 'react-hook', 'suppressions'],
        [reactTasks, vueTasks],
      ),
    ).toEqual([['overview'], ['react-component', 'react-hook'], ['dead'], ['vue-component', 'suppressions']]);
  });

  it('reads JSON from an isolated child process', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-analysis-scheduler-'));
    tempDirs.push(tempDir);
    const scriptPath = join(tempDir, 'child.cjs');
    writeFileSync(
      scriptPath,
      [
        'process.stdout.write(JSON.stringify({',
        '  command: process.argv[2],',
        '  args: process.argv.slice(3),',
        '}));',
      ].join('\n'),
    );

    await expect(
      runIsolatedJsonProcessAsync<{ command: string; args: string[] }>({
        cliPath: scriptPath,
        command: 'probe',
        args: ['alpha', 'beta'],
        label: 'Scheduler child',
      }),
    ).resolves.toEqual({ command: 'probe', args: ['alpha', 'beta'] });
  });
});
