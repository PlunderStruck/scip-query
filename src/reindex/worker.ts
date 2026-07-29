/**
 * Child process worker for background reindexing.
 * Invoked by the watcher via fork(). Reads config from env vars.
 */
import { reindex } from './index.js';
import type { RefreshTriggerKind, SupportedLanguage, TypeScriptProjectMode } from '../domain/types.js';
import { parsePositiveInteger } from '../domain/number-parsing.js';
import { monitorParentProcess } from '../platform/parent-process-monitor.js';
import { parseProcessIdentity } from '../platform/process-identity.js';
import { sanitizeTerminalLine } from '../platform/terminal-output.js';

const projectRoot = process.env['SCIP_REINDEX_PROJECT_ROOT'];
const outputScip = process.env['SCIP_REINDEX_OUTPUT_SCIP'];
const outputDb = process.env['SCIP_REINDEX_OUTPUT_DB'];
const languagesRaw = process.env['SCIP_REINDEX_LANGUAGES'];
const indexerConcurrency = parsePositiveInteger(process.env['SCIP_REINDEX_INDEXER_CONCURRENCY']);
const pnpmWorkspaces = process.env['SCIP_REINDEX_PNPM_WORKSPACES'] === '1';
const typescriptConfig = parseTypeScriptWorkerConfig(process.env['SCIP_REINDEX_TYPESCRIPT_CONFIG']);
const clojureConfigPath = process.env['SCIP_REINDEX_CLOJURE_CONFIG_PATH'] || undefined;
const triggerKind = parseRefreshTriggerKind(process.env['SCIP_REINDEX_TRIGGER_KIND']);
const triggerDetail = process.env['SCIP_REINDEX_TRIGGER_DETAIL'];
const parentIdentity = parseParentIdentity(process.env['SCIP_REINDEX_PARENT_IDENTITY']);

if (!projectRoot || !outputScip || !outputDb || !parentIdentity) {
  console.error('reindex-worker: missing required env vars');
  process.exit(1);
}
const requiredProjectRoot = projectRoot;
const requiredOutputScip = outputScip;
const requiredOutputDb = outputDb;
const requiredParentIdentity = parentIdentity;

const languages = languagesRaw ? (languagesRaw.split(',').filter(Boolean) as SupportedLanguage[]) : undefined;
const cancellation = new AbortController();
const parentMonitor = monitorParentProcess(requiredParentIdentity, (reason) => {
  cancellation.abort(new Error(`Reindex worker owner lost: ${reason}`));
});

void run();

async function run(): Promise<void> {
  try {
    await reindex({
      projectRoot: requiredProjectRoot,
      outputScip: requiredOutputScip,
      outputDb: requiredOutputDb,
      languages: languages?.length ? languages : undefined,
      pnpmWorkspaces,
      typescriptProjectMode: typescriptConfig.projectMode,
      typescriptProjects: typescriptConfig.projects,
      clojureConfigPath,
      indexerConcurrency,
      trigger: { kind: triggerKind, detail: triggerDetail || undefined },
      signal: cancellation.signal,
      onStatus: (msg) => process.stderr.write(`[reindex] ${sanitizeTerminalLine(msg)}\n`),
    });
  } catch (err) {
    console.error(`reindex-worker error: ${sanitizeTerminalLine(String(err))}`);
    process.exitCode = 1;
  } finally {
    parentMonitor.stop();
  }
}

function parseParentIdentity(value: string | undefined) {
  if (!value) return null;
  try {
    return parseProcessIdentity(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

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
