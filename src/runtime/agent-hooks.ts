import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProjectConfig, ScipQueryConfig } from '../domain/types.js';
import { diffGate } from '../queries/impact/diff-gate.js';
import type { DiffGateResult } from '../queries/impact/diff-gate.js';
import { reindex } from '../reindex/index.js';
import { createGitignoreFilter } from '../source/gitignore-filter.js';
import { ScipDatabase } from '../storage/db.js';
import { loadProjectConfig, resolveIndexPaths, resolveWatchConfig } from './config.js';
import { getIndexFreshness } from './index-freshness.js';
import { getProjectCapabilities, getProjectReadiness } from './project-readiness.js';
import { formatGateBlockReason, isStopHookReentry, readHookInput } from './agent-setup.js';

const SKIP_HOOK_INSTALL_ENV = 'SCIP_QUERY_SKIP_HOOK_INSTALL';
const STOP_HOOK_MODE_ENV = 'SCIP_QUERY_STOP_HOOK_MODE';
const SCIP_HOOK_COMMAND_PREFIX = 'scip-query hook-';
const LEGACY_STOP_HOOK_COMMAND = 'scip-query diff-gate --hook';

export type StopHookMode = 'warn' | 'feedback' | 'block';

export interface ClaudeHookJsonOutput {
  decision?: 'block';
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: 'Stop';
    additionalContext: string;
  };
}

export interface InstallUserAgentHooksResult {
  installed: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  skipped: Array<{ target: string; reason: string }>;
}

type HookProvider = 'codex' | 'claude';

interface CommandHook {
  type: 'command';
  command: string;
  args?: string[];
  timeout?: number;
  statusMessage?: string;
}

interface HookGroup {
  matcher?: string;
  hooks: CommandHook[];
  [key: string]: unknown;
}

type HookEventName = 'SessionStart' | 'UserPromptSubmit' | 'Stop';

type HookConfig = Record<string, unknown> & {
  hooks?: Partial<Record<HookEventName, HookGroup[]>>;
};

interface HookPayload {
  hook_event_name?: unknown;
  hookEventName?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  source?: unknown;
}

export function installUserAgentHooks(
  opts: {
    homeDir?: string;
    env?: Record<string, string | undefined>;
  } = {},
): InstallUserAgentHooksResult {
  const result = emptyHookInstallResult();
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();

  if (shouldSkipUserHookInstall(env)) {
    result.skipped.push({ target: 'user agent hooks', reason: `${SKIP_HOOK_INSTALL_ENV}=1` });
    return result;
  }

  installProviderHooks({
    provider: 'codex',
    rootDir: join(home, '.codex'),
    configPath: join(home, '.codex', 'hooks.json'),
    label: 'Codex/hooks.json',
    result,
  });
  installProviderHooks({
    provider: 'claude',
    rootDir: join(home, '.claude'),
    configPath: join(home, '.claude', 'settings.json'),
    label: 'Claude/settings.json',
    result,
  });

  return result;
}

export function installProjectAgentHooks(
  projectRoot: string,
  opts: {
    homeDir?: string;
    env?: Record<string, string | undefined>;
    removeLegacyUserHooks?: boolean;
  } = {},
): InstallUserAgentHooksResult {
  const result = emptyHookInstallResult();
  const env = opts.env ?? process.env;

  if (shouldSkipUserHookInstall(env)) {
    result.skipped.push({ target: 'project agent hooks', reason: `${SKIP_HOOK_INSTALL_ENV}=1` });
    return result;
  }

  installProviderHooks({
    provider: 'codex',
    rootDir: join(projectRoot, '.codex'),
    configPath: join(projectRoot, '.codex', 'hooks.json'),
    label: '.codex/hooks.json',
    createRoot: true,
    result,
  });
  installProviderHooks({
    provider: 'claude',
    rootDir: join(projectRoot, '.claude'),
    configPath: join(projectRoot, '.claude', 'settings.json'),
    label: '.claude/settings.json',
    createRoot: true,
    result,
  });

  if (opts.removeLegacyUserHooks !== false) {
    removeUserAgentHooks({ homeDir: opts.homeDir, result });
  }

  return result;
}

export function removeUserAgentHooks(
  opts: {
    homeDir?: string;
    result?: InstallUserAgentHooksResult;
  } = {},
): InstallUserAgentHooksResult {
  const result = opts.result ?? emptyHookInstallResult();
  const home = opts.homeDir ?? homedir();

  removeProviderHooks({
    configPath: join(home, '.codex', 'hooks.json'),
    label: 'Codex/hooks.json',
    result,
  });
  removeProviderHooks({
    configPath: join(home, '.claude', 'settings.json'),
    label: 'Claude/settings.json',
    result,
  });

  return result;
}

function emptyHookInstallResult(): InstallUserAgentHooksResult {
  return { installed: [], updated: [], unchanged: [], removed: [], skipped: [] };
}

export function shouldSkipUserHookInstall(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[SKIP_HOOK_INSTALL_ENV];
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}

export function resolveStopHookMode(env: Record<string, string | undefined> = process.env): StopHookMode {
  const value = env[STOP_HOOK_MODE_ENV]?.toLowerCase();
  if (value === 'block' || value === 'blocking' || value === '1' || value === 'true' || value === 'yes') {
    return 'block';
  }
  if (value === 'feedback' || value === 'continue') {
    return 'feedback';
  }
  return 'warn';
}

function installProviderHooks(opts: {
  provider: HookProvider;
  rootDir: string;
  configPath: string;
  label: string;
  createRoot?: boolean;
  result: InstallUserAgentHooksResult;
}): void {
  if (!opts.createRoot && !existsSync(opts.rootDir)) {
    return;
  }

  const current = readJsonConfig(opts.configPath, opts.label, opts.result);
  if (!current) return;

  const next = mergeScipHookConfig(current, opts.provider);
  if (JSON.stringify(next) === JSON.stringify(current)) {
    opts.result.unchanged.push(opts.label);
    return;
  }

  const existed = existsSync(opts.configPath);
  mkdirSync(dirname(opts.configPath), { recursive: true });
  writeFileSync(opts.configPath, `${JSON.stringify(next, null, 2)}\n`);
  opts.result[existed ? 'updated' : 'installed'].push(opts.label);
}

function removeProviderHooks(opts: { configPath: string; label: string; result: InstallUserAgentHooksResult }): void {
  if (!existsSync(opts.configPath)) return;

  const current = readJsonConfig(opts.configPath, opts.label, opts.result);
  if (!current) return;

  const hooks =
    current.hooks && typeof current.hooks === 'object' && !Array.isArray(current.hooks) ? current.hooks : {};
  const nextHooks: HookConfig['hooks'] = { ...hooks };
  let changed = false;

  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop'] as const) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const pruned = pruneScipHookGroups(groups);
    if (pruned.length !== groups.length || JSON.stringify(pruned) !== JSON.stringify(groups)) {
      changed = true;
      if (pruned.length > 0) {
        nextHooks[event] = pruned;
      } else {
        delete nextHooks[event];
      }
    }
  }

  if (!changed) return;

  const next: HookConfig = { ...current };
  if (Object.keys(nextHooks).length > 0) {
    next.hooks = nextHooks;
  } else {
    delete next.hooks;
  }
  writeFileSync(opts.configPath, `${JSON.stringify(next, null, 2)}\n`);
  opts.result.removed.push(opts.label);
}

function readJsonConfig(path: string, label: string, result: InstallUserAgentHooksResult): HookConfig | undefined {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      result.skipped.push({ target: label, reason: 'existing hook config is not a JSON object' });
      return undefined;
    }
    return parsed as HookConfig;
  } catch (error) {
    result.skipped.push({
      target: label,
      reason: `could not parse existing hook config: ${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  }
}

export function mergeScipHookConfig(config: HookConfig, provider: HookProvider): HookConfig {
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks) ? config.hooks : {};
  const next: HookConfig = { ...config, hooks: { ...hooks } };

  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop'] as const) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    next.hooks![event] = [...pruneScipHookGroups(groups), scipHookGroup(provider, event)];
  }

  return next;
}

function pruneScipHookGroups(groups: HookGroup[]): HookGroup[] {
  return groups
    .map((group) => ({
      ...group,
      hooks: Array.isArray(group.hooks) ? group.hooks.filter((hook) => !isScipHook(hook)) : [],
    }))
    .filter((group) => group.hooks.length > 0);
}

function isScipHook(hook: unknown): hook is CommandHook {
  if (!hook || typeof hook !== 'object') return false;
  const command = (hook as { command?: unknown }).command;
  return (
    typeof command === 'string' &&
    (command.startsWith(SCIP_HOOK_COMMAND_PREFIX) || command === LEGACY_STOP_HOOK_COMMAND)
  );
}

function scipHookGroup(_provider: HookProvider, event: HookEventName): HookGroup {
  if (event === 'SessionStart') {
    return {
      matcher: 'startup|resume|clear|compact',
      hooks: [
          {
            type: 'command',
            command: 'scip-query hook-context',
            timeout: 60,
            statusMessage: 'Refreshing scip-query context',
          },
      ],
    };
  }

  if (event === 'UserPromptSubmit') {
    return {
      hooks: [
          {
            type: 'command',
            command: 'scip-query hook-context',
            timeout: 60,
            statusMessage: 'Checking scip-query freshness',
          },
      ],
    };
  }

  return {
    hooks: [
      {
        type: 'command',
        command: 'scip-query hook-stop',
        timeout: 30,
        statusMessage: 'Running scip-query diff gate',
      },
    ],
  };
}

export async function handleAgentHookContext(): Promise<void> {
  const output = await renderAgentHookContext(readHookInput());
  if (output) {
    console.log(JSON.stringify(output));
  }
}

export function handleAgentHookStop(): void {
  const hookInput = readHookInput();
  if (isStopHookReentry(hookInput)) {
    return;
  }

  const payload = parseHookPayload(hookInput);
  const workspace = resolveHookWorkspace(payload);
  if (!workspace || !existsSync(workspace.paths.dbPath)) return;

  withWorkspaceDb(workspace, (db) => {
    const result = diffGate(db, {
      minTogether: 6,
      skip: [],
    });
    if (result.findings.length === 0) return;
    console.log(JSON.stringify(renderStopHookOutput(result, resolveStopHookMode())));
  });
}

export function renderStopHookOutput(result: DiffGateResult, mode: StopHookMode = 'warn'): ClaudeHookJsonOutput {
  const blockMessage = formatGateBlockReason(result);
  const advisoryMessage = formatGateAdvisoryReason(result);
  if (mode === 'block') {
    return {
      decision: 'block',
      reason: blockMessage,
    };
  }
  if (mode === 'feedback') {
    return {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: `${advisoryMessage}\n\nThis is non-error Stop hook feedback. Fix true findings, or explain why a finding is intentionally accepted before finishing.`,
      },
    };
  }
  return {
    systemMessage: `${advisoryMessage}\n\nStop hook allowed this turn to finish. Review these findings when relevant. Set ${STOP_HOOK_MODE_ENV}=feedback to ask the agent to continue without a hook error, or ${STOP_HOOK_MODE_ENV}=block to enforce the gate.`,
  };
}

function formatGateAdvisoryReason(result: DiffGateResult): string {
  return formatGateBlockReason(result).replace(
    ' — fix or knowingly accept them before finishing:',
    ' — review these findings when relevant:',
  );
}

export async function renderAgentHookContext(hookInput: string): Promise<unknown | undefined> {
  const payload = parseHookPayload(hookInput);
  const event = hookEventName(payload);
  if (event !== 'SessionStart' && event !== 'UserPromptSubmit') {
    return undefined;
  }

  const workspace = resolveHookWorkspace(payload);
  if (!workspace) return undefined;

  const refreshNote = await refreshIndexForHookIfNeeded(workspace);
  const context =
    event === 'SessionStart'
      ? renderSessionStartContext(workspace.projectRoot, workspace.config, workspace.paths)
      : renderUserPromptContext(String(payload.prompt ?? ''));
  const additionalContext = [refreshNote, context].filter((line): line is string => Boolean(line?.trim())).join('\n');
  if (!additionalContext.trim()) return undefined;

  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext,
    },
  };
}

async function refreshIndexForHookIfNeeded(workspace: {
  projectRoot: string;
  config: ProjectConfig;
  paths: ReturnType<typeof resolveIndexPaths>;
}): Promise<string | undefined> {
  const watch = resolveWatchConfig(workspace.config);
  if (watch.autoRefresh === false) return undefined;

  const freshness = getIndexFreshness(workspace.projectRoot, workspace.config, workspace.paths);
  if (freshness.state === 'fresh') return undefined;

  try {
    const result = await reindex({
      projectRoot: workspace.projectRoot,
      languages: workspace.config.languages,
      outputScip: workspace.paths.indexPath,
      outputDb: workspace.paths.dbPath,
      pnpmWorkspaces: workspace.config.indexer?.typescript?.pnpmWorkspaces,
      typescriptProjectMode: workspace.config.indexer?.typescript?.projectMode,
      typescriptProjects: workspace.config.indexer?.typescript?.projects,
      clojureConfigPath: workspace.config.indexer?.clojure?.configPath,
      skipIfUnchanged: true,
      allowPartial: true,
      indexerConcurrency: workspace.config.indexerConcurrency,
      trigger: { kind: 'manual-cli', detail: 'agent hook auto-refresh' },
      onStatus: () => {},
    });
    return `scip-query auto-refresh: ${result.reused ? 'reused' : 'indexed'} ${result.languages.join(', ')} because the index was ${freshness.state}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `scip-query auto-refresh skipped: index is ${freshness.state}, but refresh failed: ${message}`;
  }
}

function renderSessionStartContext(
  projectRoot: string,
  config: ProjectConfig,
  paths: ReturnType<typeof resolveIndexPaths>,
): string {
  const freshness = getIndexFreshness(projectRoot, config, paths);
  const readiness = getProjectReadiness(projectRoot, config);
  const capabilities = getProjectCapabilities(readiness);
  const unavailable = capabilities.capabilities
    .filter((capability) => capability.status !== 'available')
    .map((capability) => capability.label);
  const languages = readiness.languages.length > 0 ? readiness.languages.join(', ') : 'none detected';

  return [
    `scip-query is available in this repository. Index state: ${freshness.state} (${freshness.reason})`,
    freshness.lastRefresh
      ? `Last refresh: ${freshness.lastRefresh.result} by ${freshness.lastRefresh.trigger.kind} at ${freshness.lastRefresh.completedAt}.`
      : undefined,
    `Detected languages: ${languages}.`,
    unavailable.length > 0
      ? `Unavailable or partial capabilities: ${unavailable.join(', ')}.`
      : 'Core capabilities are available.',
    'Use the scip-query router skill when exploring, planning, verifying, debugging, diagramming, or cleaning up code.',
    'For non-trivial edits, plan with concrete-plan anchored by `scip-query plan-context <target>`, then verify with scip-verify.',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

export function renderUserPromptContext(prompt: string): string {
  const lower = prompt.toLowerCase();
  const reminders: string[] = [];

  if (matchesAny(lower, ['debug', 'bug', 'regression', 'failing', 'fails', 'error', 'wrong'])) {
    reminders.push('Debug or bug request: use scip-debug. For issue-quality triage, use scip-triage-issue.');
  }
  if (matchesAny(lower, ['explain', 'how does', 'walk me through', 'trace', 'understand'])) {
    reminders.push('Exploration request: use scip-explore before answering behavioral questions.');
  }
  if (matchesAny(lower, ['diagram', 'visualize', 'visualise', 'flow map', 'architecture map'])) {
    reminders.push('Diagram request: use scip-diagram and back every node and edge with scip-query evidence.');
  }
  if (matchesAny(lower, ['implement', 'build', 'change', 'refactor', 'fix', 'add ', 'update '])) {
    reminders.push(
      'Implementation request: plan first with concrete-plan and `scip-query plan-context <target>`, then verify with scip-verify.',
    );
  }
  if (matchesAny(lower, ['review', 'maintainability', 'architecture', 'boundary'])) {
    reminders.push(
      'Review request: use scip-maintainability, scip-api-impact, or scip-verify depending on whether this is architecture, API impact, or post-change verification.',
    );
  }
  if (matchesAny(lower, ['setup', 'adopt', 'install', 'bootstrap'])) {
    reminders.push('Setup request: use scip-adoption or scip-query-setup; keep CI setup out of the default path.');
  }
  if (
    matchesAny(lower, [
      'health',
      'score',
      'dossier',
      'cleanup',
      'dead code',
      'duplicate',
      'debloat',
      'perfect code',
      'as high as',
      'maximize',
      'maximise',
    ])
  ) {
    reminders.push(
      'Health or cleanup request: use scip-health-audit before editing; use scip-health-improve when the user wants the score raised as high as reasonably possible.',
    );
  }

  if (reminders.length === 0) {
    return '';
  }

  return [`scip-query routing reminder:`, ...reminders].join('\n');
}

function matchesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function parseHookPayload(hookInput: string): HookPayload {
  if (!hookInput.trim()) return {};
  try {
    const parsed = JSON.parse(hookInput) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as HookPayload) : {};
  } catch {
    return {};
  }
}

function hookEventName(payload: HookPayload): string | undefined {
  const event = payload.hook_event_name ?? payload.hookEventName;
  return typeof event === 'string' ? event : undefined;
}

function resolveHookWorkspace(payload: HookPayload):
  | {
      projectRoot: string;
      config: ProjectConfig;
      paths: ReturnType<typeof resolveIndexPaths>;
    }
  | undefined {
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const projectRoot = findGitRoot(cwd);
  if (!projectRoot) return undefined;

  try {
    const config = loadProjectConfig(projectRoot);
    const paths = resolveIndexPaths(projectRoot, config);
    return { projectRoot, config, paths };
  } catch {
    return undefined;
  }
}

function findGitRoot(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function withWorkspaceDb<T>(
  workspace: { projectRoot: string; config: ProjectConfig; paths: ReturnType<typeof resolveIndexPaths> },
  run: (db: ScipDatabase) => T,
): T {
  const dbConfig: ScipQueryConfig = {
    dbPath: workspace.paths.dbPath,
    indexPath: workspace.paths.indexPath,
    projectRoot: workspace.projectRoot,
    entryRoots: workspace.config.entryRoots,
    semantic: workspace.config.semantic,
    suppressions: workspace.config.suppressions,
    declaredCouplings: workspace.config.declaredCouplings,
    locality: workspace.config.locality,
  };
  const db = new ScipDatabase(dbConfig, createGitignoreFilter(workspace.projectRoot));
  try {
    return run(db);
  } finally {
    db.close();
  }
}
