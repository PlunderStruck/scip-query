import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mailbox from '../../src/storage/bounded-mailbox.js';
import { tryFilesWithQueryService } from '../../src/runtime/query-service.js';

const fixture = vi.hoisted(() => ({ build: 'build-a', config: { semantic: { enabled: true } } }));
vi.mock('../../src/platform/cli-version.js', () => ({ cliVersion: 'test', cliBuildIdentity: () => fixture.build }));
vi.mock('../../src/runtime/cli-context.js', () => ({
  resolveCliProjectContext: (projectRoot: string) => ({
    projectRoot,
    dbPath: `${projectRoot}/index.db`,
    config: fixture.config,
  }),
}));
vi.mock('../../src/storage/sqlite-generation.js', () => ({
  publishedSqliteGenerationIdentity: () => 'same-generation',
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('persistent query service session inputs', () => {
  it('reuses identical inputs and separates changed runtime bytes or effective configuration', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-service-inputs-'));
    writeFileSync(join(root, 'index.db'), 'fixture');
    writeFileSync(join(root, 'server.js'), 'fixture');
    vi.stubEnv('SCIP_QUERY_QUERY_SERVICE', '1');
    vi.stubEnv('SCIP_QUERY_QUERY_SERVICE_SERVER_PATH', join(root, 'server.js'));
    const sessions: string[] = [];
    vi.spyOn(mailbox, 'boundedMailboxPaths').mockImplementation((directory) => {
      sessions.push(directory);
      throw new Error('stop before mailbox admission');
    });
    try {
      tryFilesWithQueryService(root, 'src');
      tryFilesWithQueryService(root, 'src');
      fixture.build = 'build-b';
      tryFilesWithQueryService(root, 'src');
      fixture.config = { semantic: { enabled: false } };
      tryFilesWithQueryService(root, 'src');
      expect(sessions).toHaveLength(4);
      expect(sessions[0]).toBe(sessions[1]);
      expect(sessions[2]).not.toBe(sessions[1]);
      expect(sessions[3]).not.toBe(sessions[2]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
