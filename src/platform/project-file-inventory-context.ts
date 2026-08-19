type ProjectFileListingStore = Map<string, string>;
interface ProjectFileListingState {
  active?: ProjectFileListingStore;
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
  projectFileListingState.active = new Map();
  try {
    return run();
  } finally {
    projectFileListingState.active = previous;
  }
}

/** Enter a cache before an asynchronous CLI pre-action and release it after the command action. */
export function enterProjectFileListingCache(): () => void {
  const previous = projectFileListingState.active;
  projectFileListingState.active = new Map();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    projectFileListingState.active = previous;
  };
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
