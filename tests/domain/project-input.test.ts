import { describe, expect, it } from 'vitest';
import {
  projectInputSnapshotContentValue,
  sameProjectInputSnapshotContent,
  type ProjectInputSnapshot,
} from '../../src/domain/project-input.js';

describe('project input snapshot content identity', () => {
  it('treats derived semantic hashes as migration-compatible acceleration metadata', () => {
    const legacy = snapshot();
    const enriched: ProjectInputSnapshot = {
      ...legacy,
      files: legacy.files.map((file) => ({ ...file, semanticHash: `tokens-${file.hash}` })),
    };

    expect(sameProjectInputSnapshotContent(legacy, enriched)).toBe(true);
    expect(projectInputSnapshotContentValue(enriched)).toEqual(legacy);
  });

  it('still treats byte hash changes as different source content', () => {
    const before = snapshot();
    const after: ProjectInputSnapshot = {
      ...before,
      files: before.files.map((file) => (file.path === 'src/value.ts' ? { ...file, hash: 'changed' } : file)),
    };

    expect(sameProjectInputSnapshotContent(before, after)).toBe(false);
  });
});

function snapshot(): ProjectInputSnapshot {
  return {
    version: 3,
    languages: ['typescript'],
    pnpmWorkspaces: false,
    typescriptProjectMode: 'single',
    typescriptProjects: [],
    files: [
      { path: 'src/value.ts', size: 24, hash: 'source' },
      { path: 'tsconfig.json', size: 3, hash: 'config' },
    ],
  };
}
