import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rootIndexFallbackWarning } from '../../src/runtime/cli-context.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('cli context', () => {
  it('renders a dated warning for legacy root index fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-cli-context-'));
    tempDirs.push(root);
    const dbPath = join(root, 'index.db');
    const configuredPath = join(root, '.cache', 'scip-query', 'index.db');
    mkdirSync(join(root, '.cache', 'scip-query'), { recursive: true });
    writeFileSync(dbPath, '');

    const warning = rootIndexFallbackWarning(dbPath, configuredPath);

    expect(warning).toContain('using legacy project-root index.db');
    expect(warning).toContain(dbPath);
    expect(warning).toContain(configuredPath);
    expect(warning).toContain('modified ');
    expect(warning).toContain("run 'scip-query reindex'");
  });
});
