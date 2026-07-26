import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveIndexerBinaryForProject,
  revalidateTrustedProjectTool,
  trustProjectLocalIndexerBinary,
} from '../../src/platform/indexer-toolchain.js';

const roots: string[] = [];
const toolchain = {
  language: 'clojure' as const,
  indexerBinary: 'definitely-missing-scip-clojure',
  projectLocalBinaries: ['node_modules/.bin/scip-clojure'],
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project-local indexer trust', () => {
  it('does not select repository code without the explicit trust option', () => {
    const root = project();
    const tool = writeTool(root, 'exit 0\n');

    expect(resolveIndexerBinaryForProject(toolchain, root)).toBeNull();
    expect(resolveIndexerBinaryForProject(toolchain, root, { trustProjectTools: true })).toBe(realpathSync(tool));
  });

  it('binds consent to the canonical file identity and content', () => {
    const root = project();
    writeTool(root, 'exit 0\n');
    const identity = trustProjectLocalIndexerBinary(toolchain, root);
    expect(identity).toMatchObject({
      relativePath: 'node_modules/.bin/scip-clojure',
      executable: true,
    });
    expect(identity?.sha256).toMatch(/^[a-f0-9]{64}$/);

    writeFileSync(identity!.canonicalPath, '#!/bin/sh\nexit 17\n');
    chmodSync(identity!.canonicalPath, 0o755);

    expect(() => revalidateTrustedProjectTool(root, identity!)).toThrow('refusing changed project-local indexer');
  });

  it('rejects a project-local symlink whose canonical target escapes the checkout', () => {
    const root = project();
    const outside = project();
    const outsideTool = join(outside, 'scip-clojure');
    writeFileSync(outsideTool, '#!/bin/sh\nexit 0\n');
    chmodSync(outsideTool, 0o755);
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
    symlinkSync(outsideTool, join(root, 'node_modules/.bin/scip-clojure'));

    expect(() => trustProjectLocalIndexerBinary(toolchain, root)).toThrow(
      expect.objectContaining({
        name: 'UnsafeProjectPathError',
        reason: 'outside-project',
      }),
    );
  });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-project-tool-'));
  roots.push(root);
  return root;
}

function writeTool(root: string, body: string): string {
  const path = join(root, 'node_modules/.bin/scip-clojure');
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
  return path;
}
