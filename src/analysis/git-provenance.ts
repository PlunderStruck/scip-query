import { runGit } from './git-history.js';

/** The git state a report was computed from, for comparing two runs of the same repository. */
export interface GitProvenance {
  /** Full HEAD commit id. */
  head: string;
  /** Current branch, or null when HEAD is detached. */
  branch: string | null;
  /** Paths `git status --porcelain` reports as modified, staged, or untracked. */
  dirtyPaths: number;
}

/**
 * Observe HEAD, the branch, and the working-tree dirt count. Null when the
 * project is not a git repository or git is unavailable; every field is read
 * in one pass so the three values describe the same moment.
 */
export function gitProvenance(projectRoot: string): GitProvenance | null {
  let head: string;
  try {
    head = runGit(projectRoot, ['rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{40,64}$/u.test(head)) return null;
  return { head, branch: currentBranch(projectRoot), dirtyPaths: dirtyPathCount(projectRoot) };
}

function currentBranch(projectRoot: string): string | null {
  try {
    const ref = runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    return ref && ref !== 'HEAD' ? ref : null;
  } catch {
    return null;
  }
}

function dirtyPathCount(projectRoot: string): number {
  try {
    return runGit(projectRoot, ['status', '--porcelain'])
      .split('\n')
      .filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}
