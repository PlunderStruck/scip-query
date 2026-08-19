import { lstatSync } from 'node:fs';

interface FilesystemEntryIdentity {
  device: bigint;
  inode: bigint;
  birthtimeNs: bigint;
  kind: 'directory' | 'file';
}

export interface WorktreeLivenessIdentity {
  projectRoot: string;
  projectDirectory: FilesystemEntryIdentity;
  gitControlDirectory?: { path: string; identity: FilesystemEntryIdentity };
}

/**
 * Captures the exact filesystem objects that make one watcher root usable.
 * Device, inode, birth time, and entry kind distinguish deletion/replacement
 * from the same pathname continuing to name the original worktree.
 */
export function captureWorktreeLivenessIdentity(
  projectRoot: string,
  gitControlDirectory?: string,
): WorktreeLivenessIdentity {
  const projectDirectory = readEntryIdentity(projectRoot);
  if (projectDirectory.kind !== 'directory') throw new Error(`Watcher root is not a directory: ${projectRoot}`);

  if (!gitControlDirectory) return { projectRoot, projectDirectory };
  const gitIdentity = readEntryIdentity(gitControlDirectory);
  if (gitIdentity.kind !== 'directory') {
    throw new Error(`Git control path is not a directory: ${gitControlDirectory}`);
  }
  return {
    projectRoot,
    projectDirectory,
    gitControlDirectory: { path: gitControlDirectory, identity: gitIdentity },
  };
}

export function worktreeLivenessIdentityIsCurrent(identity: WorktreeLivenessIdentity): boolean {
  try {
    if (!sameEntryIdentity(identity.projectDirectory, readEntryIdentity(identity.projectRoot))) return false;
    const gitControl = identity.gitControlDirectory;
    return !gitControl || sameEntryIdentity(gitControl.identity, readEntryIdentity(gitControl.path));
  } catch {
    return false;
  }
}

function readEntryIdentity(path: string): FilesystemEntryIdentity {
  const stat = lstatSync(path, { bigint: true });
  const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : undefined;
  if (!kind || stat.isSymbolicLink()) throw new Error(`Unsupported watcher identity path: ${path}`);
  return {
    device: stat.dev,
    inode: stat.ino,
    birthtimeNs: stat.birthtimeNs,
    kind,
  };
}

function sameEntryIdentity(left: FilesystemEntryIdentity, right: FilesystemEntryIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs &&
    left.kind === right.kind
  );
}
