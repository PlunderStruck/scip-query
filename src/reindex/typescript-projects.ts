// Compatibility re-export: project discovery is an input/fingerprint concern
// shared by reindexing, freshness checks, and shared-generation lookup.
export {
  activeTypeScriptProjectConfigPaths,
  discoverTypeScriptProjectRoots,
  isTypeScriptProjectConfigPath,
  typeScriptProjectInputPaths,
} from '../platform/typescript-projects.js';
