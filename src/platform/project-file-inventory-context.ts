type ProjectFileListingStore = Map<string, string>;
interface ProjectFileListingState {
  active?: ProjectFileListingStore;
  canonicalProjectRoots?: Map<string, string>;
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

export function cachedProjectFileListing(projectRoot: string, maxBytes: number, load: () => string): string {
  const listings = projectFileListingState.active;
  const cached = listings?.get(projectRoot);
  if (cached !== undefined) {
    if (Buffer.byteLength(cached, 'utf8') <= maxBytes) return cached;
  }

  const loaded = load();
  listings?.set(projectRoot, loaded);
  return loaded;
}
