/**
 * Child process worker for background reindexing.
 * Invoked by the watcher via fork(). Reads config from env vars.
 */
import { reindex } from './reindex/index.js';
import type { SupportedLanguage } from './types.js';

const projectRoot = process.env['SCIP_REINDEX_PROJECT_ROOT'];
const outputScip = process.env['SCIP_REINDEX_OUTPUT_SCIP'];
const outputDb = process.env['SCIP_REINDEX_OUTPUT_DB'];
const languagesRaw = process.env['SCIP_REINDEX_LANGUAGES'];
const pnpmWorkspaces = process.env['SCIP_REINDEX_PNPM_WORKSPACES'] === '1';

if (!projectRoot || !outputScip || !outputDb) {
  console.error('reindex-worker: missing required env vars');
  process.exit(1);
}

const languages = languagesRaw
  ? (languagesRaw.split(',').filter(Boolean) as SupportedLanguage[])
  : undefined;

reindex({
  projectRoot,
  outputScip,
  outputDb,
  languages: languages?.length ? languages : undefined,
  pnpmWorkspaces,
  onStatus: (msg) => process.stderr.write(`[reindex] ${msg}\n`),
}).then(() => {
  process.exit(0);
}).catch((err) => {
  console.error(`reindex-worker error: ${err}`);
  process.exit(1);
});
