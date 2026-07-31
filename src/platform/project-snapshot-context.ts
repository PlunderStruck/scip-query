import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalPath } from './git-worktree.js';

export interface ProjectSnapshotFile {
  relativePath: string;
  content: Buffer;
  size: number;
  fingerprintSize?: number;
  sha256: string;
}

const projectSnapshotStorage = new AsyncLocalStorage<{
  projectRoot: string;
  paths: readonly string[];
  files: Map<string, ProjectSnapshotFile>;
  missing: ReadonlySet<string>;
  fingerprints: Map<string, Pick<ProjectSnapshotFile, 'size' | 'sha256' | 'fingerprintSize'>>;
  readBaseFile?(relativePath: string): ProjectSnapshotFile | undefined;
}>();

export function withProjectSnapshot<T>(
  snapshot: {
    projectRoot: string;
    paths: readonly string[];
    files: Map<string, ProjectSnapshotFile>;
    missing: ReadonlySet<string>;
    fingerprints: Map<string, Pick<ProjectSnapshotFile, 'size' | 'sha256' | 'fingerprintSize'>>;
    readBaseFile?(relativePath: string): ProjectSnapshotFile | undefined;
  },
  callback: () => T,
): T {
  return projectSnapshotStorage.run(
    {
      projectRoot: canonicalPath(snapshot.projectRoot),
      paths: snapshot.paths,
      files: snapshot.files,
      missing: snapshot.missing,
      fingerprints: snapshot.fingerprints,
      ...(snapshot.readBaseFile ? { readBaseFile: snapshot.readBaseFile } : {}),
    },
    callback,
  );
}

export function projectSnapshotFile(projectRoot: string, relativePath: string): ProjectSnapshotFile | undefined {
  const snapshot = activeSnapshotFor(projectRoot);
  if (!snapshot || snapshot.missing.has(relativePath)) return undefined;
  const existing = snapshot.files.get(relativePath);
  if (existing) return existing;
  const resolved = snapshot.readBaseFile?.(relativePath);
  if (resolved) snapshot.files.set(relativePath, resolved);
  return resolved;
}

export function projectSnapshotPathState(projectRoot: string, relativePath: string): 'present' | 'missing' | undefined {
  const snapshot = activeSnapshotFor(projectRoot);
  if (!snapshot) return undefined;
  return snapshot.missing.has(relativePath) ? 'missing' : snapshot.paths.includes(relativePath) ? 'present' : 'missing';
}

export function projectSnapshotFingerprint(
  projectRoot: string,
  relativePath: string,
): Pick<ProjectSnapshotFile, 'size' | 'sha256' | 'fingerprintSize'> | undefined {
  return activeSnapshotFor(projectRoot)?.fingerprints.get(relativePath);
}

export function projectSnapshotPaths(projectRoot: string): readonly string[] | undefined {
  const snapshot = activeSnapshotFor(projectRoot);
  return snapshot?.paths;
}

function activeSnapshotFor(projectRoot: string) {
  const snapshot = projectSnapshotStorage.getStore();
  if (!snapshot) return undefined;
  return snapshot.projectRoot === canonicalPath(projectRoot) ? snapshot : undefined;
}
