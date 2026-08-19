/**
 * One Git index observation that carries project paths and the visibility bits
 * capable of hiding tracked bytes from status. The sequence identifies when
 * this process observed it; it does not claim that Git itself is immutable.
 */
export interface GitProjectFileInventory {
  taggedOutput: string;
  pathBytes: number;
  indexAllowsTreeFingerprintReuse: boolean;
  sequence: number;
}

type ProjectFileListingStore = Map<string, GitProjectFileInventory>;
interface ProjectFileListingState {
  active?: ProjectFileListingStore;
  canonicalProjectRoots?: Map<string, string>;
  sequence?: number;
}

const PROJECT_FILE_LISTING_STORAGE = Symbol.for('scip-query.project-file-listing-context.v1');
const sharedGlobals = globalThis as unknown as Record<PropertyKey, unknown>;
const existingState = sharedGlobals[PROJECT_FILE_LISTING_STORAGE];
const projectFileListingState: ProjectFileListingState =
  existingState && typeof existingState === 'object' ? (existingState as ProjectFileListingState) : {};
sharedGlobals[PROJECT_FILE_LISTING_STORAGE] = projectFileListingState;

/** Share one Git file-listing result across a bounded database command. */
export function withProjectFileListingCache<T>(run: () => T): T {
  if (projectFileListingState.active) return run();
  const previous = projectFileListingState.active;
  const previousCanonicalProjectRoots = projectFileListingState.canonicalProjectRoots;
  projectFileListingState.active = new Map();
  projectFileListingState.canonicalProjectRoots = new Map();
  try {
    return run();
  } finally {
    projectFileListingState.active = previous;
    projectFileListingState.canonicalProjectRoots = previousCanonicalProjectRoots;
  }
}

/** Enter a cache before an asynchronous CLI pre-action and release it after the command action. */
export function enterProjectFileListingCache(): () => void {
  const previous = projectFileListingState.active;
  const previousCanonicalProjectRoots = projectFileListingState.canonicalProjectRoots;
  projectFileListingState.active = new Map();
  projectFileListingState.canonicalProjectRoots = new Map();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    projectFileListingState.active = previous;
    projectFileListingState.canonicalProjectRoots = previousCanonicalProjectRoots;
  };
}

/** Keep one physical project-root identity for every file read in a bounded command. */
export function cachedCanonicalProjectRoot(projectRoot: string, load: () => string): string {
  const roots = projectFileListingState.active ? projectFileListingState.canonicalProjectRoots : undefined;
  const cached = roots?.get(projectRoot);
  if (cached !== undefined) return cached;

  const loaded = load();
  roots?.set(projectRoot, loaded);
  return loaded;
}

export function gitProjectFileInventorySequence(): number {
  return projectFileListingState.sequence ?? 0;
}

export function cachedGitProjectFileInventory(
  projectRoot: string,
  maxPathBytes: number,
  load: () => string,
): GitProjectFileInventory {
  const listings = projectFileListingState.active;
  const cached = listings?.get(projectRoot);
  if (cached && cached.pathBytes <= maxPathBytes) return cached;

  const observed = decodeGitProjectFileInventory(load(), (projectFileListingState.sequence ?? 0) + 1);
  projectFileListingState.sequence = observed.sequence;
  if (observed.pathBytes > maxPathBytes) {
    throw new RangeError(`Git project file listing exceeded ${maxPathBytes} path bytes.`);
  }
  listings?.set(projectRoot, observed);
  return observed;
}

/**
 * Returns a cached visibility decision only when that exact inventory was
 * observed after the caller's status boundary. Callers must consume it in the
 * immediately following mutation-free preflight.
 */
export function cachedGitProjectFileIndexVisibilityAfter(projectRoot: string, sequence: number): boolean | undefined {
  const cached = projectFileListingState.active?.get(projectRoot);
  return cached && cached.sequence > sequence ? cached.indexAllowsTreeFingerprintReuse : undefined;
}

export function* gitProjectFileInventoryPaths(inventory: GitProjectFileInventory): IterableIterator<string> {
  let offset = 0;
  while (offset < inventory.taggedOutput.length) {
    const end = inventory.taggedOutput.indexOf('\0', offset);
    if (end < 0) return;
    yield inventory.taggedOutput.slice(offset + 2, end);
    offset = end + 1;
  }
}

function decodeGitProjectFileInventory(taggedOutput: string, sequence: number): GitProjectFileInventory {
  let offset = 0;
  let recordCount = 0;
  let indexAllowsTreeFingerprintReuse = true;
  while (offset < taggedOutput.length) {
    const end = taggedOutput.indexOf('\0', offset);
    if (end < 0 || end <= offset + 2 || taggedOutput[offset + 1] !== ' ') {
      throw new Error('Git returned a malformed tagged project file listing.');
    }
    const tag = taggedOutput[offset];
    indexAllowsTreeFingerprintReuse &&= tag === 'H' || tag === '?';
    recordCount += 1;
    offset = end + 1;
  }
  return {
    taggedOutput,
    pathBytes: Buffer.byteLength(taggedOutput, 'utf8') - recordCount * 2,
    indexAllowsTreeFingerprintReuse,
    sequence,
  };
}
