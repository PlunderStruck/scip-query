import type { RefreshTrigger } from '../../src/domain/types.js';
import { afterEach, expect, it, vi } from 'vitest';
import { isAutomaticTrigger } from '../../src/reindex/reindex-activity.js';

const reindex = vi.fn(async (_options: { trigger: RefreshTrigger }) => undefined);
const stop = vi.fn();
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

it.each(['watch-startup', 'watch-demand', 'watch-source', 'watch-git-state'])(
  'preserves %s across the worker boundary for automatic activity accounting',
  async (kind) => {
    vi.resetModules();
    vi.doMock('../../src/reindex/index.js', () => ({ reindex }));
    vi.doMock('../../src/platform/parent-process-monitor.js', () => ({ monitorParentProcess: () => ({ stop }) }));
    vi.stubEnv('SCIP_REINDEX_PROJECT_ROOT', '/project');
    vi.stubEnv('SCIP_REINDEX_OUTPUT_SCIP', '/cache/index.scip');
    vi.stubEnv('SCIP_REINDEX_OUTPUT_DB', '/cache/index.db');
    vi.stubEnv('SCIP_REINDEX_TRIGGER_KIND', kind);
    vi.stubEnv(
      'SCIP_REINDEX_PARENT_IDENTITY',
      JSON.stringify({
        version: 1,
        pid: process.pid,
        platform: process.platform,
        startToken: 'fixture-parent',
      }),
    );
    await import('../../src/reindex/worker.js');
    expect(reindex).toHaveBeenCalledOnce();
    const options = reindex.mock.calls[0]![0];
    expect(options.trigger.kind).toBe(kind);
    expect(isAutomaticTrigger(options.trigger)).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  },
);
