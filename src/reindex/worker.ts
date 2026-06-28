/**
 * Child process worker for background reindexing.
 * Invoked by the watcher via fork(). Reads config from env vars.
 */
import { reindex } from './index.js';
import type { RefreshTriggerKind, SupportedLanguage, TypeScriptProjectMode } from '../domain/types.js';

const projectRoot = process.env['SCIP_REINDEX_PROJECT_ROOT'];
const outputScip = process.env['SCIP_REINDEX_OUTPUT_SCIP'];
const outputDb = process.env['SCIP_REINDEX_OUTPUT_DB'];
const languagesRaw = process.env['SCIP_REINDEX_LANGUAGES'];
const indexerConcurrency = parsePositiveInteger(process.env['SCIP_REINDEX_INDEXER_CONCURRENCY']);
const pnpmWorkspaces = process.env['SCIP_REINDEX_PNPM_WORKSPACES'] === '1';
const typescriptConfig = parseTypeScriptWorkerConfig(process.env['SCIP_REINDEX_TYPESCRIPT_CONFIG']);
const triggerKind = parseRefreshTriggerKind(process.env['SCIP_REINDEX_TRIGGER_KIND']);
const triggerDetail = process.env['SCIP_REINDEX_TRIGGER_DETAIL'];

if (!projectRoot || !outputScip || !outputDb) {
  console.error('reindex-worker: missing required env vars');
  process.exit(1);
}

const languages = languagesRaw ? (languagesRaw.split(',').filter(Boolean) as SupportedLanguage[]) : undefined;

reindex({
  projectRoot,
  outputScip,
  outputDb,
  languages: languages?.length ? languages : undefined,
  pnpmWorkspaces,
  typescriptProjectMode: typescriptConfig.projectMode,
  typescriptProjects: typescriptConfig.projects,
  indexerConcurrency,
  trigger: { kind: triggerKind, detail: triggerDetail || undefined },
  onStatus: (msg) => process.stderr.write(`[reindex] ${msg}\n`),
})
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(`reindex-worker error: ${err}`);
    process.exit(1);
  });

function parseRefreshTriggerKind(value: string | undefined): RefreshTriggerKind {
  switch (value) {
    case 'manual-cli':
    case 'setup':
    case 'watch-source':
    case 'watch-git-head':
    case 'watch-git-index':
    case 'watch-git-state':
      return value;
    default:
      return 'unknown';
  }
}

function parseTypeScriptWorkerConfig(value: string | undefined): {
  projectMode?: TypeScriptProjectMode;
  projects?: string[];
} {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const record = parsed as { projectMode?: unknown; projects?: unknown };
    const projectMode =
      record.projectMode === 'single' || record.projectMode === 'workspace' ? record.projectMode : undefined;
    const projects = Array.isArray(record.projects)
      ? record.projects.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      : undefined;
    return { projectMode, projects: projects && projects.length > 0 ? projects : undefined };
  } catch {
    return {};
  }
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
