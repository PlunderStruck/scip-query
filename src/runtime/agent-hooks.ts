import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProjectConfig, ScipQueryConfig } from '../domain/types.js';
import { isPathInsideProject } from '../domain/path-normalization.js';
import { resolveIndexStoragePaths } from '../platform/cache-layout.js';
import { watchServicePaths } from '../platform/watch-service-state.js';
import { DIFF_GATE_CHECKS, diffGate } from '../queries/impact/diff-gate.js';
import type { DiffGateResult } from '../queries/impact/diff-gate.js';
import { createGitignoreFilter } from '../source/primitives/gitignore-filter.js';
import { escapeRegex } from '../source/primitives/regex-utils.js';
import { ScipDatabase } from '../storage/db.js';
import {
  mutateTextFileRevisionAware,
  type RevisionedTextMutation,
  type RevisionedTextSnapshot,
} from './revisioned-file.js';
import { loadProjectConfig, resolveWatchConfig } from './config.js';
import { getIndexFreshness, type IndexFreshness } from './index-freshness.js';
import { getProjectCapabilities, getProjectReadiness } from './project-readiness.js';
import { formatGateBlockReason, readHookInput } from './agent-setup.js';
import { cliVersion } from './cli-support.js';
import { recordDiffGateOutcomes } from './diff-gate-outcomes.js';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import { prepareWorktreeIndex } from './cli-context.js';
import {
  ensureWatchServiceForCommand,
  requestWatchServiceRefresh,
  type WatchServiceAutoEnsureResult,
} from './watch-service.js';
import { findGitRoot } from '../platform/git-worktree.js';
import { resolveSharedEvidenceDbPath } from '../reindex/shared-generation-store.js';
import { inspectSqliteGeneration } from '../reindex/sqlite-generation-store.js';
import { formatRecordCompatibilityWarning } from '../domain/record-compatibility.js';
import { renderAutonomousRestorationProjection } from '../domain/autonomous-work-restoration.js';
import { resolveSpawnableExecutable, toPortableCommand } from '../platform/binary.js';
import { readAutonomousRestorationProjection } from '../storage/autonomous-work-restoration.js';
import { writeSerializedJson } from '../platform/terminal-output.js';
import {
  DEFAULT_DIFF_GATE_TIMEOUT_MS,
  diffGateDeadlineContract,
  runIsolatedDiffGate,
  type DiffGateExecutionResult,
} from './diff-gate-execution.js';
import { formatAnalysisBudgetDisclosure } from './cli-support.js';
import { formatUnresolvedStreakLine } from '../queries/health/finding-outcome-ledger.js';
import {
  agentRestorationDeliveryEpoch,
  claimAgentSessionRestoration,
  pendingOutputFromTranscript,
  readAgentTranscriptTail,
  renderAgentSessionRestoration,
  updateAgentSessionState,
  type AgentSessionStopReceipt,
} from './agent-session-state.js';
import { buildLeasedObservationReceipt } from './observation-receipt.js';
import {
  assertFixedCompletionContext,
  captureFixedCompletionContext,
  publishStopCompletionEvaluations,
} from './completion-evaluation-context.js';
import {
  activateConfiguredProtectedWorkAuthorization,
  PROTECTED_WORK_AUTHORIZATION_ID_ENV,
  PROTECTED_WORK_AUTHORIZATION_ROOT_ENV,
  readConfiguredProtectedWorkAuthorization,
  type ProtectedWorkAuthorizationEnvironment,
} from './protected-work-authorization-controller.js';
import { readConfiguredProtectedGoalEvidence } from './protected-goal-evidence-controller.js';
import {
  materializeAutomaticOperationAttempts,
  type MaterializeAutomaticOperationAttemptsResult,
} from './autonomous-operation-journal.js';
import {
  formatAutonomousNextActions,
  publishAutonomousNextAction,
  type PublishedAutonomousNextAction,
} from './autonomous-policy-loop.js';

const SKIP_HOOK_INSTALL_ENV = 'SCIP_QUERY_SKIP_HOOK_INSTALL';
const STOP_HOOK_MODE_ENV = 'SCIP_QUERY_STOP_HOOK_MODE';
const SCIP_HOOK_COMMAND_PREFIX = 'scip-query hook-';
const LEGACY_STOP_HOOK_COMMAND = 'scip-query diff-gate --hook';
const LOCAL_HOOK_EXCLUDE_BEGIN = '# scip-query:local-hooks:begin';
const LOCAL_HOOK_EXCLUDE_END = '# scip-query:local-hooks:end';
const PROJECT_LOCAL_HOOK_TARGETS = [
  { relativePath: '.codex/hooks.json', label: '.codex/hooks.json' },
  { relativePath: '.claude/settings.local.json', label: '.claude/settings.local.json' },
] as const;

export type StopHookMode = 'warn' | 'feedback' | 'block';

const STOP_HOOK_REFRESH_WAIT_MS = 5_000;
const STOP_HOOK_REFRESH_POLL_MS = 100;
const STOP_HOOK_GIT_OBSERVATION_TIMEOUT_MS = 10_000;
const STOP_HOOK_GIT_OBSERVATION_MAX_BUFFER = 50 * 1024 * 1024;
const STOP_HOOK_DEADLINE = diffGateDeadlineContract(DEFAULT_DIFF_GATE_TIMEOUT_MS, STOP_HOOK_REFRESH_WAIT_MS);

export interface ClaudeHookJsonOutput {
  decision?: 'block';
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: 'Stop';
    additionalContext: string;
  };
}

export interface ClaudePreToolHookJsonOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

interface HookWorkspace {
  projectRoot: string;
  config: ProjectConfig;
  paths: ReturnType<typeof resolveIndexStoragePaths>;
}

export interface StopHookIndexObservation {
  freshness: IndexFreshness;
  generationIdentity?: string;
  generationSource?: 'immutable' | 'legacy';
  worktreeIdentity?: string;
}

export interface StopHookEvidenceLease {
  generationIdentity: string;
  generationSource: 'immutable' | 'legacy';
  worktreeIdentity: string;
  observedAt: string;
}

// scip-query: ignore-stale -- Clock, refresh, observation, and wait port makes evidence leases deterministic.
export interface StopHookEvidenceDependencies {
  refresh(workspace: HookWorkspace): Promise<string | undefined>;
  observe(workspace: HookWorkspace): StopHookIndexObservation;
  now(): number;
  wait(milliseconds: number): Promise<void>;
}

export class StopHookEvidenceLeaseError extends Error {
  constructor(
    readonly state: IndexFreshness['state'] | 'changed-during-run' | 'unverifiable',
    message: string,
  ) {
    super(message);
    this.name = 'StopHookEvidenceLeaseError';
  }
}

// scip-query: ignore-stale — reviewed S1 owned contract; hook installation returns this named result.
export interface InstallUserAgentHooksResult {
  installed: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  gitExcluded: string[];
  warnings: string[];
  skipped: Array<{ target: string; reason: string }>;
}

export type SetupHooksModeSelection =
  | { ok: true; mode: 'install' | 'remove' | 'preview-remove' }
  | { ok: false; message: string };

export function selectSetupHooksMode(opts: {
  remove?: boolean;
  force?: boolean;
  dryRun?: boolean;
}): SetupHooksModeSelection {
  if (opts.remove && opts.force) {
    return { ok: false, message: '--remove cannot be combined with --force; force only reinstalls hooks.' };
  }
  if (opts.dryRun && !opts.remove) {
    return {
      ok: false,
      message: '--dry-run requires --remove; installation is already non-destructive to user-owned hooks.',
    };
  }
  if (opts.remove) return { ok: true, mode: opts.dryRun ? 'preview-remove' : 'remove' };
  return { ok: true, mode: 'install' };
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

type HookEventName = 'SessionStart' | 'UserPromptSubmit' | 'PostCompact' | 'PreToolUse' | 'Stop';

type HookConfig = Record<string, unknown> & {
  hooks?: Partial<Record<HookEventName, HookGroup[]>>;
};

export interface HookPayload {
  hook_event_name?: unknown;
  hookEventName?: unknown;
  cwd?: unknown;
  prompt?: unknown;
  source?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
}

interface ProjectHookOptions {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  removeLegacyUserHooks?: boolean;
  shared?: boolean;
  remove?: boolean;
  force?: boolean;
  dryRun?: boolean;
  commandPrefix?: string;
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
  opts: ProjectHookOptions = {},
): InstallUserAgentHooksResult {
  const result = emptyHookInstallResult();
  const env = opts.env ?? process.env;

  if (shouldSkipUserHookInstall(env)) {
    result.skipped.push({ target: 'project agent hooks', reason: `${SKIP_HOOK_INSTALL_ENV}=1` });
    return result;
  }

  if (opts.shared) {
    result.warnings.push('--shared is deprecated; project hooks are always checkout-local and will not be committed.');
  }
  ensureProjectHookGitExcludes(projectRoot, result, opts.dryRun);

  if (opts.remove) {
    removeProjectHookTarget(projectRoot, PROJECT_LOCAL_HOOK_TARGETS[0], result, {
      dryRun: opts.dryRun,
    });
    removeProjectHookTarget(projectRoot, PROJECT_LOCAL_HOOK_TARGETS[1], result, {
      writeDeclinedTombstone: true,
      dryRun: opts.dryRun,
    });
    return result;
  }

  const commandPrefix = opts.commandPrefix ?? projectHookCommandPrefix(projectRoot);
  installProjectHookTarget(projectRoot, PROJECT_LOCAL_HOOK_TARGETS[0], result, {
    provider: 'codex',
    commandPrefix,
    force: opts.force,
  });
  installProjectHookTarget(projectRoot, PROJECT_LOCAL_HOOK_TARGETS[1], result, {
    provider: 'claude',
    commandPrefix,
    force: opts.force,
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
  return { installed: [], updated: [], unchanged: [], removed: [], gitExcluded: [], warnings: [], skipped: [] };
}

function installProjectHookTarget(
  projectRoot: string,
  target: (typeof PROJECT_LOCAL_HOOK_TARGETS)[number],
  result: InstallUserAgentHooksResult,
  opts: { provider: HookProvider; commandPrefix: string; force?: boolean },
): void {
  if (isGitTracked(projectRoot, target.relativePath)) {
    result.skipped.push({
      target: target.label,
      reason: 'tracked repository config; checkout-local hook setup will not modify it',
    });
    return;
  }
  const configPath = join(projectRoot, target.relativePath);
  installProviderHooks({
    provider: opts.provider,
    rootDir: dirname(configPath),
    configPath,
    label: target.label,
    createRoot: true,
    commandPrefix: opts.commandPrefix,
    force: opts.force,
    result,
  });
}

function removeProjectHookTarget(
  projectRoot: string,
  target: (typeof PROJECT_LOCAL_HOOK_TARGETS)[number],
  result: InstallUserAgentHooksResult,
  opts: { writeDeclinedTombstone?: boolean; dryRun?: boolean },
): void {
  if (isGitTracked(projectRoot, target.relativePath)) {
    result.skipped.push({
      target: target.label,
      reason: 'tracked repository config; checkout-local hook removal will not modify it',
    });
    return;
  }
  removeProjectProviderHooks({
    configPath: join(projectRoot, target.relativePath),
    label: target.label,
    result,
    writeDeclinedTombstone: opts.writeDeclinedTombstone,
    dryRun: opts.dryRun,
  });
}

// scip-query: ignore-extract — reviewed E2 cohesive algorithm; the callee cluster is local mechanics, not an independent responsibility.
function ensureProjectHookGitExcludes(projectRoot: string, result: InstallUserAgentHooksResult, dryRun = false): void {
  const excludePath = gitInfoExcludePath(projectRoot);
  if (!excludePath) {
    result.warnings.push('Could not locate .git/info/exclude; local hook files may appear as untracked.');
    return;
  }
  const targets = PROJECT_LOCAL_HOOK_TARGETS.filter((target) => !isGitTracked(projectRoot, target.relativePath));
  if (targets.length === 0) return;
  const block = [
    LOCAL_HOOK_EXCLUDE_BEGIN,
    ...targets.map((target) => `/${target.relativePath}`),
    LOCAL_HOOK_EXCLUDE_END,
  ].join('\n');
  const pattern = new RegExp(
    `${escapeRegex(LOCAL_HOOK_EXCLUDE_BEGIN)}[\\s\\S]*?${escapeRegex(LOCAL_HOOK_EXCLUDE_END)}\\n?`,
    'g',
  );
  if (!dryRun) {
    try {
      mutateTextFileRevisionAware(excludePath, (snapshot) => {
        const withoutOwnedBlock = snapshot.text.replace(pattern, '').replace(/\n*$/, '');
        const next = `${withoutOwnedBlock}${withoutOwnedBlock ? '\n\n' : ''}${block}\n`;
        return next === snapshot.text
          ? { kind: 'unchanged' }
          : {
              kind: 'write',
              text: next,
              ...(!snapshot.revision.exists ? { mode: 0o644 } : {}),
            };
      });
    } catch (error) {
      result.warnings.push(error instanceof Error ? error.message : String(error));
      return;
    }
  }
  result.gitExcluded.push(...targets.map((target) => target.label));
}

function gitInfoExcludePath(projectRoot: string): string | null {
  try {
    const value = execFileSync('git', ['-C', projectRoot, 'rev-parse', '--git-path', 'info/exclude'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
      killSignal: 'SIGKILL',
    }).trim();
    if (!value) return null;
    return isAbsolute(value) ? value : resolve(projectRoot, value);
  } catch {
    return null;
  }
}

function isGitTracked(projectRoot: string, relativePath: string): boolean {
  try {
    execFileSync('git', ['-C', projectRoot, 'ls-files', '--error-unmatch', '--', relativePath], {
      stdio: 'ignore',
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    return true;
  } catch {
    return false;
  }
}

export function shouldSkipUserHookInstall(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[SKIP_HOOK_INSTALL_ENV];
  return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}

export function resolveStopHookMode(env: Record<string, string | undefined> = process.env): StopHookMode {
  const value = env[STOP_HOOK_MODE_ENV]?.toLowerCase();
  if (value === 'block' || value === 'blocking') {
    return 'block';
  }
  if (value === 'warn') {
    return 'warn';
  }
  if (value === 'feedback' || value === 'continue' || value === '1' || value === 'true' || value === 'yes') {
    return 'feedback';
  }
  if (env[PROTECTED_WORK_AUTHORIZATION_ROOT_ENV] || env[PROTECTED_WORK_AUTHORIZATION_ID_ENV]) {
    return 'block';
  }
  return 'feedback';
}

function installProviderHooks(opts: {
  provider: HookProvider;
  rootDir: string;
  configPath: string;
  label: string;
  createRoot?: boolean;
  commandPrefix?: string;
  force?: boolean;
  result: InstallUserAgentHooksResult;
}): void {
  if (!opts.createRoot && !existsSync(opts.rootDir)) {
    return;
  }

  let declined = false;
  const mutation = mutateHookConfigFile(opts.configPath, opts.label, opts.result, (current) => {
    if (current['scipQueryHooks'] === 'declined' && !opts.force) {
      declined = true;
      return { kind: 'unchanged' };
    }
    const next = mergeScipHookConfig(current, opts.provider, opts.commandPrefix);
    return JSON.stringify(next) === JSON.stringify(current)
      ? { kind: 'unchanged' }
      : { kind: 'write', text: serializeHookConfig(next) };
  });
  if (!mutation) return;
  if (declined) {
    opts.result.skipped.push({
      target: opts.label,
      reason: 'scip-query hooks were previously removed; rerun with --force',
    });
    return;
  }
  if (!mutation.changed) {
    opts.result.unchanged.push(opts.label);
    return;
  }
  opts.result[mutation.previous.revision.exists ? 'updated' : 'installed'].push(opts.label);
}

function removeProviderHooks(opts: {
  configPath: string;
  label: string;
  result: InstallUserAgentHooksResult;
  dryRun?: boolean;
  writeDeclinedTombstone?: boolean;
}): void {
  if (!existsSync(opts.configPath) && !opts.writeDeclinedTombstone) return;
  const transform = (current: HookConfig): RevisionedTextMutation => {
    const next = removeScipHookConfig(current, opts.writeDeclinedTombstone);
    if (JSON.stringify(next) === JSON.stringify(current)) return { kind: 'unchanged' };
    return Object.keys(next).length === 0 ? { kind: 'delete' } : { kind: 'write', text: serializeHookConfig(next) };
  };
  if (opts.dryRun) {
    const current = readJsonConfig(opts.configPath, opts.label, opts.result);
    if (!current) return;
    if (transform(current).kind !== 'unchanged') opts.result.removed.push(opts.label);
    return;
  }
  const mutation = mutateHookConfigFile(opts.configPath, opts.label, opts.result, transform);
  if (mutation?.changed) opts.result.removed.push(opts.label);
}

function removeProjectProviderHooks(opts: {
  configPath: string;
  label: string;
  result: InstallUserAgentHooksResult;
  writeDeclinedTombstone?: boolean;
  dryRun?: boolean;
}): void {
  const before = opts.result.removed.length;
  removeProviderHooks(opts);
  if (opts.writeDeclinedTombstone && opts.result.removed.length === before) {
    const snapshot = readJsonConfig(opts.configPath, opts.label, opts.result);
    if (snapshot?.scipQueryHooks === 'declined') opts.result.removed.push(`${opts.label} (declined)`);
  }
}

function removeScipHookConfig(current: HookConfig, writeDeclinedTombstone = false): HookConfig {
  const hooks =
    current.hooks && typeof current.hooks === 'object' && !Array.isArray(current.hooks) ? current.hooks : {};
  const nextHooks: HookConfig['hooks'] = { ...hooks };
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostCompact', 'PreToolUse', 'Stop'] as const) {
    if (!Array.isArray(hooks[event])) continue;
    const groups = hooks[event];
    const pruned = pruneScipHookGroups(groups);
    if (pruned.length > 0) nextHooks[event] = pruned;
    else delete nextHooks[event];
  }
  const next: HookConfig = { ...current };
  if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
  else delete next.hooks;
  if (writeDeclinedTombstone) next.scipQueryHooks = 'declined';
  return next;
}

function mutateHookConfigFile(
  path: string,
  label: string,
  result: InstallUserAgentHooksResult,
  transform: (current: HookConfig, snapshot: RevisionedTextSnapshot) => RevisionedTextMutation,
): ReturnType<typeof mutateTextFileRevisionAware> | undefined {
  try {
    return mutateTextFileRevisionAware(path, (snapshot) => {
      const current = parseHookConfigSnapshot(snapshot);
      return transform(current, snapshot);
    });
  } catch (error) {
    result.skipped.push({
      target: label,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function parseHookConfigSnapshot(snapshot: RevisionedTextSnapshot): HookConfig {
  if (!snapshot.revision.exists) return {};
  try {
    const parsed = JSON.parse(snapshot.text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top-level value is not an object');
    }
    return parsed as HookConfig;
  } catch (error) {
    throw new Error(
      `Cannot update ${snapshot.path}: the latest hook config is invalid JSON (${error instanceof Error ? error.message : String(error)}).`,
      { cause: error },
    );
  }
}

function serializeHookConfig(config: HookConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function readJsonConfig(path: string, label: string, result: InstallUserAgentHooksResult): HookConfig | undefined {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readSmallArtifactText(path, 'agent hook settings')) as unknown;
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

export function mergeScipHookConfig(
  config: HookConfig,
  provider: HookProvider,
  commandPrefix = 'scip-query',
): HookConfig {
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks) ? config.hooks : {};
  const next: HookConfig = { ...config, hooks: { ...hooks } };
  if (next['scipQueryHooks'] === 'declined') {
    delete next['scipQueryHooks'];
  }

  const events: HookEventName[] =
    provider === 'claude'
      ? ['SessionStart', 'UserPromptSubmit', 'PostCompact', 'PreToolUse', 'Stop']
      : ['SessionStart', 'UserPromptSubmit', 'Stop'];
  for (const event of events) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    next.hooks![event] = [...pruneScipHookGroups(groups), scipHookGroup(provider, event, commandPrefix)];
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
    (command.startsWith(SCIP_HOOK_COMMAND_PREFIX) ||
      command === LEGACY_STOP_HOOK_COMMAND ||
      /(?:^|\s)hook-(?:context|pretool|stop)$/.test(command))
  );
}

function scipHookGroup(_provider: HookProvider, event: HookEventName, commandPrefix: string): HookGroup {
  if (event === 'SessionStart') {
    return {
      hooks: [
        {
          type: 'command',
          command: `${commandPrefix} hook-context`,
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
          command: `${commandPrefix} hook-context`,
          timeout: 60,
          statusMessage: 'Checking scip-query freshness',
        },
      ],
    };
  }

  if (event === 'PostCompact') {
    return {
      hooks: [
        {
          type: 'command',
          command: `${commandPrefix} hook-context`,
          timeout: 10,
          statusMessage: 'Resetting scip-query context reminder',
        },
      ],
    };
  }

  if (event === 'PreToolUse') {
    return {
      matcher: 'Bash|Grep|Glob',
      hooks: [
        {
          type: 'command',
          command: `${commandPrefix} hook-pretool`,
          timeout: 10,
          statusMessage: 'Checking scip-query evidence integrity',
        },
      ],
    };
  }

  return {
    hooks: [
      {
        type: 'command',
        command: `${commandPrefix} hook-stop`,
        timeout: STOP_HOOK_DEADLINE.hostTimeoutSeconds,
        statusMessage: 'Running scip-query diff gate',
      },
    ],
  };
}

function projectHookCommandPrefix(projectRoot: string): string {
  const canonicalProjectRoot = realpathSync(projectRoot);
  const candidates = [resolveSpawnableExecutable('scip-query'), process.argv[1]].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  for (const entry of candidates) {
    if (!existsSync(entry)) continue;
    const canonicalEntry = realpathSync(entry);
    if (isPathInsideProject(canonicalProjectRoot, canonicalEntry)) continue;
    const portable = toPortableCommand(canonicalEntry, []);
    return [portable.binary, ...portable.args].map(quoteHookCommandArgument).join(' ');
  }
  throw new Error(
    'Cannot install persistent hooks without a scip-query CLI identity outside the target checkout. ' +
      'Install scip-query globally and rerun setup-hooks.',
  );
}

function quoteHookCommandArgument(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replaceAll('%', '%%').replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function handleAgentHookContext(): Promise<void> {
  const output = await renderAgentHookContext(readHookInput());
  if (output) {
    writeSerializedJson(JSON.stringify(output));
  }
}

export function handleAgentHookPreToolUse(): void {
  const payload = parseHookPayload(readHookInput());
  const workspace = resolveHookWorkspace(payload);
  if (!workspace || !existsSync(workspace.paths.dbPath)) return;
  const markerPath = preToolReminderMarker(workspace.paths.cacheDir, payload);
  const decision = evaluatePreToolUse(payload, markerPath ? existsSync(markerPath) : true);
  if (decision.kind === 'allow') return;
  if (decision.kind === 'reconsider' && markerPath) {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, 'shown\n');
  }
  const output: ClaudePreToolHookJsonOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  };
  writeSerializedJson(JSON.stringify(output));
}

type PreToolDecision = { kind: 'allow' } | { kind: 'deny' | 'reconsider'; reason: string };

export function evaluatePreToolUse(payload: HookPayload, alreadyReminded: boolean): PreToolDecision {
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const input =
    payload.tool_input && typeof payload.tool_input === 'object' ? (payload.tool_input as Record<string, unknown>) : {};
  const shellCommand = tool === 'Bash' && typeof input['command'] === 'string' ? input['command'] : '';

  if (shellCommand && blindlyTruncatesScipQuery(shellCommand)) {
    return {
      kind: 'deny',
      reason:
        'Do not pipe scip-query output through head, tail, or a line-range sed selector: that discards evidence without a resumable position. Re-run the exact emitted paging command and follow each --output-cursor continuation until complete; command-level coverage such as refs --cursor remains a separate step.',
    };
  }

  const nativeSearch =
    tool === 'Grep' || tool === 'Glob' || (tool === 'Bash' && /(?:^|[;&|]\s*)(?:rg|grep)(?:\s|$)/.test(shellCommand));
  if (!nativeSearch || alreadyReminded) return { kind: 'allow' };
  return {
    kind: 'reconsider',
    reason:
      'Pause once before native search in this indexed repository. If you need compiler-resolved identity or a complete set of definitions, references, callers, consumers, dependencies, or affected units, use scip-query. If you only need literal text, filenames, or local source, retry the same search unchanged; it will be allowed for the rest of this context window.',
  };
}

function blindlyTruncatesScipQuery(command: string): boolean {
  if (!containsScipQueryInvocation(command)) return false;
  return (
    /\|\s*(?:head|tail)(?:\s|$)/.test(command) ||
    /\|\s*sed\s+(?:-[A-Za-z]+\s+)*(?:['"])?\d+\s*,\s*\d+\s*p/.test(command)
  );
}

function containsScipQueryInvocation(command: string): boolean {
  const boundary = String.raw`(?:^|[;&(]\s*|\|\|?\s*|&&\s*|\s)`;
  const commandName = String.raw`(?:\S*[\\/])?scip-query(?:\.(?:cmd|exe))?`;
  const direct = new RegExp(`${boundary}${commandName}\\s+[A-Za-z][A-Za-z0-9-]*(?:\\s|$)`, 'u');
  const packageRunner = new RegExp(
    `${boundary}(?:(?:npx|bunx|yarn(?:\\s+dlx)?)\\s+|pnpm\\s+(?:exec|dlx)\\s+|npm\\s+exec(?:\\s+--)?\\s+)${commandName}\\s+[A-Za-z][A-Za-z0-9-]*(?:\\s|$)`,
    'u',
  );
  const cliScript = String.raw`(?:"[^"]*(?:dist[\\/]cli\.js|src[\\/]runtime[\\/]cli\.ts)"|'[^']*(?:dist[\\/]cli\.js|src[\\/]runtime[\\/]cli\.ts)'|\S*(?:dist[\\/]cli\.js|src[\\/]runtime[\\/]cli\.ts))`;
  const nodeEntrypoint = new RegExp(
    `${boundary}(?:\\S*[\\\\/])?(?:node|bun)(?:\\.exe)?\\s+${cliScript}\\s+[A-Za-z][A-Za-z0-9-]*(?:\\s|$)`,
    'u',
  );
  return direct.test(command) || packageRunner.test(command) || nodeEntrypoint.test(command);
}

function preToolReminderMarker(cacheDir: string, payload: HookPayload): string | null {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  if (!sessionId) return null;
  const identity = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return join(cacheDir, 'agent-hooks', `native-search-${identity}`);
}

function resetPreToolReminder(
  workspace: { paths: ReturnType<typeof resolveIndexStoragePaths> },
  payload: HookPayload,
): void {
  const marker = preToolReminderMarker(workspace.paths.cacheDir, payload);
  if (marker) rmSync(marker, { force: true });
}

/**
 * Runs diff-gate for the Stop hook and returns its result, or `undefined`
 * when the hook has nothing to do (re-entrant stop, no workspace, no
 * index). Split out from `handleAgentHookStop` so tests can drive the exact
 * config-load path the live hook uses (`resolveHookWorkspace` +
 * `withWorkspaceDb`) with a synthetic hook payload instead of stdin —
 * this is the path that regressed docs.snapshotPaths (18.2/21.2d): unlike
 * `openDb()` in cli-context.ts, `withWorkspaceDb` built its `ScipQueryConfig`
 * without `docs`, so `isSnapshotDoc` saw an empty `snapshotPaths` list and
 * every snapshot-doc citation surfaced as a live doc-reference finding.
 */
// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export async function runStopHookDiffGate(
  hookInput: string,
  evidenceDependencies: StopHookEvidenceDependencies = DEFAULT_STOP_HOOK_EVIDENCE_DEPENDENCIES,
): Promise<DiffGateResult | undefined> {
  const payload = parseHookPayload(hookInput);
  const workspace = resolveHookWorkspace(payload);
  if (!workspace) return undefined;
  const lease = await prepareStopHookEvidenceLease(workspace, evidenceDependencies);

  const result = withWorkspaceDb(workspace, (db) => {
    const gateOptions = {
      minTogether: 6,
      skip: [],
    } as const;
    const result = diffGate(db, gateOptions);
    const outcomes = recordDiffGateOutcomes(db, result, {
      replayGate: (baseCommit, checks) => {
        const required = new Set(checks);
        return diffGate(db, {
          ...gateOptions,
          base: baseCommit,
          includeBaseline: required.has('baseline'),
          skip: DIFF_GATE_CHECKS.filter((check) => !required.has(check)),
        });
      },
    });
    if (outcomes.warning) console.error(`note: ${outcomes.warning}`);
    return result;
  });
  assertStopHookEvidenceLease(workspace, lease, evidenceDependencies);
  return result;
}

export async function handleAgentHookStop(): Promise<void> {
  const hookInput = readHookInput();
  const payload = parseHookPayload(hookInput);
  const workspace = resolveHookWorkspace(payload);
  let execution: StopHookExecution | undefined;
  try {
    execution = await runIsolatedStopHookDiffGate(hookInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    persistStopSessionState(workspace, payload, {
      attemptedAtMs: Date.now(),
      outcome: 'unresolved',
      findingCount: 0,
      automaticSuppressionCount: 0,
      policyEscalationCount: 0,
      warning: message,
    });
    writeStopHookJson(renderStopHookExecutionFailure(message, resolveStopHookMode()));
    return;
  }
  const result = execution?.result;
  if (execution && result) {
    persistStopSessionState(workspace, payload, {
      attemptedAtMs: Date.now(),
      outcome: result.outcome ?? (result.findings.length > 0 ? 'findings' : 'pass'),
      findingCount: result.findings.length,
      automaticSuppressionCount: result.suppressionSummary?.automaticSuppressionCount ?? result.suppressed.length,
      policyEscalationCount: result.suppressionSummary?.policyEscalationCount ?? 0,
      observation: buildLeasedObservationReceipt({
        projectRoot: workspace?.projectRoot ?? process.cwd(),
        generationIdentity: execution.evidenceLease.generationIdentity,
        generationSource: execution.evidenceLease.generationSource,
        worktreeIdentity: execution.evidenceLease.worktreeIdentity,
        observedAt: execution.evidenceLease.observedAt,
      }),
      ...(execution.outcomes.warning ? { warning: execution.outcomes.warning } : {}),
    });
  }
  if (
    !execution ||
    !result ||
    (result.findings.length === 0 &&
      result.suppressed.length === 0 &&
      !suppressionCoverageWarning(result) &&
      !execution?.outcomes.warning &&
      !stopCoverageWarning(result) &&
      !execution?.completion.some(({ evaluation }) => evaluation.evaluation.record.decision.state !== 'complete'))
  ) {
    return;
  }
  writeStopHookJson(renderStopHookExecutionOutput(result, resolveStopHookMode(), execution));
}

function writeStopHookJson(output: ClaudeHookJsonOutput): void {
  writeSerializedJson(JSON.stringify(output));
}

interface StopHookExecution extends DiffGateExecutionResult {
  evidenceLease: StopHookEvidenceLease;
  completion: ReturnType<typeof publishStopCompletionEvaluations>;
  automaticAttempts: MaterializeAutomaticOperationAttemptsResult;
  nextActions: PublishedAutonomousNextAction[];
}

async function runIsolatedStopHookDiffGate(hookInput: string): Promise<StopHookExecution | undefined> {
  const payload = parseHookPayload(hookInput);
  const workspace = resolveHookWorkspace(payload);
  if (!workspace) return undefined;
  const automaticAttempts = materializeAutomaticOperationAttempts(
    workspace.projectRoot,
    workspace.paths.cacheDir,
    cliVersion,
  );
  const lease = await prepareStopHookEvidenceLease(workspace);
  const stopMode = resolveStopHookMode();
  const protectedWorkAuthorization = workspace.config.collaborationDomainId
    ? readConfiguredProtectedWorkAuthorization(
        workspace.projectRoot,
        workspace.config.collaborationDomainId,
        process.env,
      )
    : undefined;
  const protectedGoalEvidence = workspace.config.collaborationDomainId
    ? readConfiguredProtectedGoalEvidence(
        workspace.projectRoot,
        workspace.config.collaborationDomainId,
        protectedWorkAuthorization,
        process.env,
      )
    : undefined;
  const completionContext = captureFixedCompletionContext(workspace.projectRoot, workspace.config, stopMode, {
    ...(protectedWorkAuthorization ? { protectedWorkAuthorization } : {}),
    ...(protectedGoalEvidence ? { protectedGoalEvidence } : {}),
  });
  const execution = runIsolatedDiffGate(
    {
      minTogether: 6,
      includeBaseline: false,
      includeOutcomeLedger: true,
      full: false,
      skip: [],
    },
    {
      projectRoot: workspace.projectRoot,
      cacheDir: workspace.paths.cacheDir,
      timeoutMs: STOP_HOOK_DEADLINE.childTimeoutMs,
    },
  );
  assertStopHookEvidenceLease(workspace, lease);
  assertFixedCompletionContext(completionContext, workspace.config);
  const completion = publishStopCompletionEvaluations(completionContext, execution.result, {
    toolVersion: cliVersion,
  });
  const nextActions = completion.map(({ evaluation }) =>
    publishAutonomousNextAction({
      projectRoot: workspace.projectRoot,
      collaborationDomainId: completionContext.collaborationDomainId,
      evaluation: evaluation.evaluation.record,
      result: execution.result,
      ...(protectedGoalEvidence?.record.goalId === evaluation.evaluation.record.goalId &&
      protectedGoalEvidence.record.changeId === evaluation.evaluation.record.changeId
        ? {
            protectedGoalEvidence: {
              evidenceId: protectedGoalEvidence.record.evidenceId,
              goalId: protectedGoalEvidence.record.goalId,
              changeId: protectedGoalEvidence.record.changeId,
              result: protectedGoalEvidence.record.result,
            },
          }
        : {}),
      options: { toolVersion: cliVersion },
    }),
  );
  return { ...execution, evidenceLease: lease, completion, automaticAttempts, nextActions };
}

function persistStopSessionState(
  workspace: ReturnType<typeof resolveHookWorkspace>,
  payload: HookPayload,
  receipt: AgentSessionStopReceipt,
): void {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
  if (!workspace || !sessionId) return;
  try {
    updateAgentSessionState({
      cacheDir: workspace.paths.cacheDir,
      sessionId,
      projectRoot: workspace.projectRoot,
      latestStop: receipt,
    });
  } catch {
    // Session restoration is best-effort and must not change the gate result.
  }
}

const DEFAULT_STOP_HOOK_EVIDENCE_DEPENDENCIES: StopHookEvidenceDependencies = {
  refresh(workspace) {
    return refreshIndexForHookIfNeeded(workspace, 'Stop');
  },
  observe: observeStopHookIndex,
  now: Date.now,
  wait(milliseconds) {
    return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
  },
};

export async function prepareStopHookEvidenceLease(
  workspace: HookWorkspace,
  dependencies: StopHookEvidenceDependencies = DEFAULT_STOP_HOOK_EVIDENCE_DEPENDENCIES,
  options: { waitMs?: number; pollMs?: number } = {},
): Promise<StopHookEvidenceLease> {
  let observation = dependencies.observe(workspace);
  const immediate = stopHookEvidenceLease(observation);
  if (immediate) return immediate;

  let refreshNote: string | undefined;
  if (resolveWatchConfig(workspace.config).autoRefresh !== false) {
    refreshNote = await dependencies.refresh(workspace);
    const waitMs = options.waitMs ?? STOP_HOOK_REFRESH_WAIT_MS;
    const pollMs = options.pollMs ?? STOP_HOOK_REFRESH_POLL_MS;
    const deadline = dependencies.now() + waitMs;
    while (dependencies.now() < deadline) {
      await dependencies.wait(Math.min(pollMs, Math.max(1, deadline - dependencies.now())));
      observation = dependencies.observe(workspace);
      const refreshed = stopHookEvidenceLease(observation);
      if (refreshed) return refreshed;
    }
  }

  throw unresolvedStopHookEvidence(observation, refreshNote);
}

export function assertStopHookEvidenceLease(
  workspace: HookWorkspace,
  lease: StopHookEvidenceLease,
  dependencies: StopHookEvidenceDependencies = DEFAULT_STOP_HOOK_EVIDENCE_DEPENDENCIES,
): void {
  const observation = dependencies.observe(workspace);
  const current = stopHookEvidenceLease(observation);
  if (!current) throw unresolvedStopHookEvidence(observation);
  if (current.generationIdentity !== lease.generationIdentity || current.worktreeIdentity !== lease.worktreeIdentity) {
    throw new StopHookEvidenceLeaseError(
      'changed-during-run',
      'The scip-query index generation or Git worktree changed while diff-gate was running. The result was discarded; wait for the watcher to become idle and retry Stop.',
    );
  }
}

function stopHookEvidenceLease(observation: StopHookIndexObservation): StopHookEvidenceLease | undefined {
  if (observation.freshness.state !== 'fresh' || !observation.generationIdentity || !observation.worktreeIdentity) {
    return undefined;
  }
  return {
    generationIdentity: observation.generationIdentity,
    generationSource: observation.generationSource ?? 'legacy',
    worktreeIdentity: observation.worktreeIdentity,
    observedAt: observation.freshness.checkedAt,
  };
}

function unresolvedStopHookEvidence(
  observation: StopHookIndexObservation,
  refreshNote?: string,
): StopHookEvidenceLeaseError {
  const state =
    observation.freshness.state === 'fresh' && (!observation.generationIdentity || !observation.worktreeIdentity)
      ? 'unverifiable'
      : observation.freshness.state;
  const missingIdentity =
    state === 'unverifiable'
      ? ' A stable index-generation and Git-worktree identity could not both be established.'
      : '';
  const refresh = refreshNote ? ` ${refreshNote}` : '';
  return new StopHookEvidenceLeaseError(
    state,
    `scip-query index evidence is ${state}: ${observation.freshness.reason}.${missingIdentity}${refresh} Diff-gate was not allowed to report a clean Stop result.`,
  );
}

function observeStopHookIndex(workspace: HookWorkspace): StopHookIndexObservation {
  const freshness = getIndexFreshness(workspace.projectRoot, workspace.config, workspace.paths);
  return {
    freshness,
    ...stopHookGenerationObservation(workspace, freshness),
    worktreeIdentity: stopHookWorktreeIdentity(workspace.projectRoot),
  };
}

// scip-query: ignore-incomplete-migration — the Stop lease needs an immutable
// generation identity/fallback; generic freshness intentionally reports only freshness.
function stopHookGenerationObservation(
  workspace: HookWorkspace,
  freshness: IndexFreshness,
): Pick<StopHookIndexObservation, 'generationIdentity' | 'generationSource'> {
  const generation = inspectSqliteGeneration(workspace.paths.dbPath, workspace.paths.metaPath);
  if (generation.state === 'current' || generation.state === 'drifted') {
    return { generationIdentity: generation.generation.currentGeneration, generationSource: 'immutable' };
  }
  if (!existsSync(workspace.paths.metaPath)) return {};
  try {
    return {
      generationIdentity: createHash('sha256')
        .update(readSmallArtifactText(workspace.paths.metaPath, 'reindex metadata'))
        .digest('hex'),
      generationSource: 'legacy',
    };
  } catch {
    return freshness.updatedAt ? { generationIdentity: freshness.updatedAt, generationSource: 'legacy' } : {};
  }
}

function stopHookWorktreeIdentity(projectRoot: string): string | undefined {
  try {
    const diff = execFileSync('git', ['-C', projectRoot, 'diff', '--no-ext-diff', '--binary', 'HEAD', '--'], {
      encoding: 'utf8' as const,
      timeout: STOP_HOOK_GIT_OBSERVATION_TIMEOUT_MS,
      maxBuffer: STOP_HOOK_GIT_OBSERVATION_MAX_BUFFER,
    });
    return createHash('sha256').update(diff).digest('hex');
  } catch {
    return undefined;
  }
}

export function renderStopHookExecutionFailure(message: string, mode: StopHookMode = 'feedback'): ClaudeHookJsonOutput {
  const reason = `Diff gate could not complete and therefore cannot certify this turn: ${message}`;
  if (mode === 'block') return { decision: 'block', reason };
  if (mode === 'feedback') {
    return {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: `${reason}\n\nWait for an existing gate or investigate the timeout before declaring the work complete.`,
      },
    };
  }
  return {
    systemMessage: `${reason}\n\nStop-hook warn mode allowed the turn to finish, but the diff was not certified.`,
  };
}

export function renderStopHookOutput(
  result: DiffGateResult,
  mode: StopHookMode = 'feedback',
  execution?: Pick<DiffGateExecutionResult, 'outcomes' | 'analysisBudget'> & {
    completion?: ReturnType<typeof publishStopCompletionEvaluations>;
    nextActions?: readonly PublishedAutonomousNextAction[];
  },
): ClaudeHookJsonOutput {
  const coverageWarning = suppressionCoverageWarning(result);
  const findingMessage = result.findings.length > 0 ? formatGateBlockReason(result) : undefined;
  const executionEvidence = formatStopExecutionEvidence(result, execution);
  const blockMessage = [coverageWarning, ...executionEvidence, findingMessage]
    .filter((value): value is string => Boolean(value))
    .join('\n\n');
  const advisoryMessage = formatGateAdvisoryReason(result, executionEvidence);
  const completionBlocked = execution?.completion?.some(
    ({ evaluation }) => evaluation.evaluation.record.decision.state !== 'complete',
  );
  if (mode === 'block' && (result.findings.length > 0 || completionBlocked)) {
    return {
      decision: 'block',
      reason: blockMessage,
    };
  }
  if (mode === 'feedback') {
    const instruction = completionBlocked
      ? 'Continue with the named unsatisfied completion predicates; do not declare the intended change complete yet.'
      : result.findings.length > 0
        ? 'Fix true findings, or provide policy-admissible counterevidence before finishing.'
        : 'Automatic adjudication completed without a human approval prompt; no finding action is required for this Stop.';
    return {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: `${advisoryMessage}\n\nThis is non-error Stop hook feedback. ${instruction}`,
      },
    };
  }
  return {
    systemMessage: `${advisoryMessage}\n\nStop hook allowed this turn to finish. Review these findings when relevant. Set ${STOP_HOOK_MODE_ENV}=feedback to ask the agent to continue without a hook error, or ${STOP_HOOK_MODE_ENV}=block to enforce the gate.`,
  };
}

function renderStopHookExecutionOutput(
  result: DiffGateResult,
  mode: StopHookMode,
  execution: StopHookExecution,
): ClaudeHookJsonOutput {
  return renderStopHookOutput(result, mode, execution);
}

function formatGateAdvisoryReason(result: DiffGateResult, executionEvidence: readonly string[]): string {
  const findingMessage =
    result.findings.length > 0
      ? formatGateBlockReason(result).replace(
          ' — fix or knowingly accept them before finishing:',
          ' — review these findings when relevant:',
        )
      : undefined;
  const automaticSuppressionMessage =
    (result.suppressionSummary?.automaticSuppressionCount ?? result.suppressed.length) > 0
      ? `Diff gate outcome: pass-with-suppressions. ${result.suppressionSummary?.automaticSuppressionCount ?? result.suppressed.length} exact finding(s) passed automated adjudication; ${result.suppressionSummary?.policyEscalationCount ?? 0} policy escalation(s) remain.`
      : undefined;
  return [suppressionCoverageWarning(result), ...executionEvidence, findingMessage, automaticSuppressionMessage]
    .filter((value): value is string => Boolean(value))
    .join('\n\n');
}

function formatStopExecutionEvidence(
  result: DiffGateResult,
  execution:
    | (Pick<DiffGateExecutionResult, 'outcomes' | 'analysisBudget'> & {
        completion?: ReturnType<typeof publishStopCompletionEvaluations>;
        nextActions?: readonly PublishedAutonomousNextAction[];
      })
    | undefined,
): string[] {
  const lines: string[] = [];
  if (execution?.outcomes.ledger) {
    const streak = formatUnresolvedStreakLine(
      execution.outcomes.ledger,
      execution.outcomes.observed,
      execution.outcomes.now,
    );
    if (streak) lines.push(streak);
  }
  if (execution?.outcomes.warning) {
    lines.push(`Outcome history warning: ${execution.outcomes.warning}`);
  }
  const coverage = stopCoverageWarning(result);
  if (coverage) lines.push(coverage);
  const budget = formatAnalysisBudgetDisclosure(execution?.analysisBudget);
  if (budget) lines.push(budget);
  const renderedActionIds = new Set<string>();
  for (const { evaluation } of execution?.completion ?? []) {
    const decision = evaluation.evaluation.record.decision;
    const changeId = evaluation.evaluation.record.changeId;
    const nextAction = execution?.nextActions?.find((published) => published.action.changeId === changeId);
    if (nextAction) renderedActionIds.add(nextAction.decision.record.decisionId);
    const action = nextAction ? formatCompactAutonomousNextAction(nextAction) : undefined;
    if (decision.state === 'complete') {
      lines.push(`Completion ${changeId}: complete.` + (action ? ` ${action}` : ''));
    } else if (decision.state === 'blocked') {
      lines.push(
        `Completion ${changeId}: blocked; ` +
          `blocked=${decision.blockedPredicates.join(',')}; unknown=${decision.unknownPredicates.join(',') || 'none'}.` +
          (action ? ` ${action}` : '') +
          (decision.unknownPredicates.length > 0 ? ` Inspect: scip-query completion status ${changeId}.` : ''),
      );
    } else {
      lines.push(
        `Completion ${changeId}: superseded; ` +
          `successor=${decision.successorGoalId}; rule=${decision.transitionRuleId}.` +
          (action ? ` ${action}` : ''),
      );
    }
  }
  const unmatchedActions = (execution?.nextActions ?? []).filter(
    ({ decision }) => !renderedActionIds.has(decision.record.decisionId),
  );
  const unmatchedActionOutput = formatAutonomousNextActions(unmatchedActions);
  if (unmatchedActionOutput) lines.push(unmatchedActionOutput);
  return lines;
}

function formatCompactAutonomousNextAction({ action, decision }: PublishedAutonomousNextAction): string {
  const instruction = decision.record.nextAction ?? action.instruction;
  const boundedRetry = action.kind === 'retry' || action.kind === 'replan';
  const terminal = /[.!?]$/u.test(instruction) ? '' : '.';
  return (
    `Next ${action.kind}/${action.blocker}: ${instruction}` +
    (boundedRetry
      ? ` [retry limit ${action.limits.maxEquivalentAttempts}; deadline ${action.limits.strategyDeadlineMs / 60_000}m].`
      : terminal)
  );
}

function stopCoverageWarning(result: DiffGateResult): string | undefined {
  const failedTiers = (result.evidenceTiers ?? []).filter((tier) => tier.state === 'failed');
  if (result.skipped.length === 0 && failedTiers.length === 0) return undefined;
  const skipped =
    result.skipped.length > 0
      ? `${result.skipped.length} skipped check(s): ${result.skipped.map(({ check }) => check).join(', ')}`
      : undefined;
  const failed =
    failedTiers.length > 0
      ? `${failedTiers.length} failed evidence tier(s): ${failedTiers.map(({ tier }) => tier).join(', ')}`
      : undefined;
  return `Evidence coverage is incomplete — ${[skipped, failed].filter(Boolean).join('; ')}.`;
}

function suppressionCoverageWarning(result: DiffGateResult): string | undefined {
  return result.recordCompatibility
    ? formatRecordCompatibilityWarning('Committed suppression', result.recordCompatibility.suppressions)
    : undefined;
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
export async function renderAgentHookContext(
  hookInput: string,
  options: { environment?: ProtectedWorkAuthorizationEnvironment } = {},
): Promise<unknown | undefined> {
  const payload = parseHookPayload(hookInput);
  const event = hookEventName(payload);
  if (event !== 'SessionStart' && event !== 'UserPromptSubmit' && event !== 'PostCompact') {
    return undefined;
  }

  const workspace = resolveHookWorkspace(payload);
  if (!workspace) return undefined;
  const environment = options.environment ?? process.env;
  if (event === 'SessionStart' || event === 'PostCompact') resetPreToolReminder(workspace, payload);
  if (event === 'PostCompact') {
    const restored = restoreAgentWorkContext(workspace, payload, event);
    return restored
      ? {
          hookSpecificOutput: {
            hookEventName: event,
            additionalContext: restored,
          },
        }
      : undefined;
  }

  const prompt = String(payload.prompt ?? '');
  const activation =
    event === 'UserPromptSubmit' && workspace.config.collaborationDomainId
      ? activateConfiguredProtectedWorkAuthorization({
          projectRoot: workspace.projectRoot,
          collaborationDomainId: workspace.config.collaborationDomainId,
          prompt,
          environment,
        })
      : undefined;

  const refreshNote = await refreshIndexForHookIfNeeded(workspace, event);
  const context =
    event === 'SessionStart'
      ? [
          renderSessionStartContext(workspace.projectRoot, workspace.config, workspace.paths),
          restoreAgentWorkContext(workspace, payload, event),
        ]
          .filter((line): line is string => Boolean(line?.trim()))
          .join('\n\n')
      : [
          activation?.publication === 'activated'
            ? `Activated protected work authorization ${activation.lease.record.authorizationId}: exact goal ${activation.lease.record.goal.goalId} and change ${activation.lease.record.change.changeId} are now the durable work state. Continue directly from that intent.${resolveStopHookMode(environment) === 'block' ? ' Final Stop enforcement is blocking and owns the diff gate; do not duplicate it manually before closeout.' : ''}`
            : undefined,
          renderUserPromptContext(prompt, workspace.config),
          restoreAgentWorkContext(workspace, payload, event),
        ]
          .filter((line): line is string => Boolean(line?.trim()))
          .join('\n\n');
  const additionalContext = [refreshNote, context].filter((line): line is string => Boolean(line?.trim())).join('\n');
  if (!additionalContext.trim()) return undefined;

  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext,
    },
  };
}

function restoreAgentWorkContext(
  workspace: NonNullable<ReturnType<typeof resolveHookWorkspace>>,
  payload: HookPayload,
  event: 'SessionStart' | 'UserPromptSubmit' | 'PostCompact',
): string | undefined {
  let projectionContext: string | undefined;
  let projectionCursor: string;
  try {
    const projection = readAutonomousRestorationProjection(workspace.projectRoot);
    projectionCursor = projection.cursor;
    projectionContext = renderAutonomousRestorationProjection(projection);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    projectionCursor = createHash('sha256').update(`restoration-error:${message}`).digest('hex');
    projectionContext = [
      `Autonomous work restoration is UNVERIFIED because committed records could not be projected: ${message}`,
      'Do not claim completion or repeat an uncertain effect until the ledger is readable.',
      'Inspect exactly with: scip-query goal status ; scip-query change status ; scip-query attempt status ; scip-query decision status ; scip-query obligation status',
    ].join('\n');
  }
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
  if (!sessionId) return event === 'UserPromptSubmit' ? undefined : projectionContext;
  const transcriptPath =
    event === 'PostCompact' && typeof payload.transcript_path === 'string' ? payload.transcript_path : undefined;
  const transcript = transcriptPath ? readAgentTranscriptTail(transcriptPath) : undefined;
  const deliveryEpoch =
    event === 'SessionStart' || event === 'UserPromptSubmit'
      ? agentRestorationDeliveryEpoch('changed-state')
      : transcript === undefined
        ? undefined
        : agentRestorationDeliveryEpoch(transcript);
  let claim: ReturnType<typeof claimAgentSessionRestoration>;
  try {
    claim = claimAgentSessionRestoration({
      cacheDir: workspace.paths.cacheDir,
      sessionId,
      projectRoot: workspace.projectRoot,
      projectionCursor,
      ...(deliveryEpoch ? { deliveryEpoch } : {}),
      ...(transcript !== undefined
        ? { unfinishedOutput: pendingOutputFromTranscript(transcript, workspace.projectRoot) }
        : {}),
    });
  } catch {
    // The cache is reconstructable session state. Failure to update it must
    // not hide a successfully derived committed-work projection.
    return projectionContext;
  }
  if (!claim.claimed) return undefined;
  return (
    [projectionContext, renderAgentSessionRestoration(claim.state)]
      .filter((line): line is string => Boolean(line?.trim()))
      .join('\n\n') || undefined
  );
}

interface HookRefreshDependencies {
  prepare?: typeof prepareWorktreeIndex;
  ensureService: typeof ensureWatchServiceForCommand;
  freshness: typeof getIndexFreshness;
  requestRefresh: typeof requestWatchServiceRefresh;
  startOneShot(projectRoot: string): void;
}

const DEFAULT_HOOK_REFRESH_DEPENDENCIES: HookRefreshDependencies = {
  prepare: prepareWorktreeIndex,
  ensureService: ensureWatchServiceForCommand,
  freshness: getIndexFreshness,
  requestRefresh: requestWatchServiceRefresh,
  startOneShot(projectRoot) {
    // scip-query: process-lifetime-reviewed -- intentionally detached refresh;
    // the durable watch/reindex lock owns completion after this hook exits.
    const child = spawn('scip-query', ['reindex', '--allow-partial'], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SCIP_QUERY_SKIP_AUTO_INSTALL: '1' },
    });
    child.unref();
  },
};

export async function refreshIndexForHookIfNeeded(
  workspace: {
    projectRoot: string;
    config: ProjectConfig;
    paths: ReturnType<typeof resolveIndexStoragePaths>;
  },
  event: string,
  dependencies: HookRefreshDependencies = DEFAULT_HOOK_REFRESH_DEPENDENCIES,
): Promise<string | undefined> {
  const watch = resolveWatchConfig(workspace.config);
  if (watch.autoRefresh === false) return undefined;

  dependencies.prepare?.(workspace.projectRoot, workspace.config, workspace.paths);
  const freshness = dependencies.freshness(workspace.projectRoot, workspace.config, workspace.paths);
  if (watch.enabled) {
    const service = dependencies.ensureService({
      commandName: `agent-${event}`,
      projectRoot: workspace.projectRoot,
      cacheDir: workspace.paths.cacheDir,
      cliVersion,
      config: workspace.config,
    });
    if (service.kind === 'failed') {
      return `scip-query watch service did not start: ${service.message}. Run 'scip-query watch --daemon' to repair it.`;
    }
    if (service.kind === 'skipped') {
      return freshness.state === 'fresh'
        ? undefined
        : `scip-query index is ${freshness.state}; automatic watch service wake was skipped (${service.reason}).`;
    }
    requestIdleServiceRefreshIfStale(service, freshness.state, workspace.paths.cacheDir, dependencies);
    if (freshness.state !== 'fresh') {
      return `scip-query index is ${freshness.state}; ${service.kind === 'started' ? 'started' : 'woke'} the watch service and requested refresh.`;
    }
    return service.kind === 'started' ? 'scip-query watch service started for this project.' : undefined;
  }

  if (freshness.state === 'fresh') return undefined;
  if (event === 'UserPromptSubmit') {
    return `scip-query index is ${freshness.state}; evidence commands will note staleness. Run 'scip-query reindex' to refresh.`;
  }
  try {
    dependencies.startOneShot(workspace.projectRoot);
    return `scip-query index is ${freshness.state}; started background refresh with auto-install disabled.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `scip-query auto-refresh skipped: index is ${freshness.state}, but background refresh failed to start: ${message}`;
  }
}

function requestIdleServiceRefreshIfStale(
  service: Extract<WatchServiceAutoEnsureResult, { kind: 'started' | 'reused' }>,
  freshness: IndexFreshness['state'],
  cacheDir: string,
  dependencies: HookRefreshDependencies,
): void {
  if (freshness === 'fresh' || service.kind === 'started' || service.state.watcher.state !== 'idle') return;
  dependencies.requestRefresh(
    watchServicePaths(cacheDir).activityPath,
    `agent hook observed ${freshness} index while service was idle`,
  );
}

function renderSessionStartContext(
  projectRoot: string,
  config: ProjectConfig,
  paths: ReturnType<typeof resolveIndexStoragePaths>,
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
    'Before a non-trivial edit, establish the current entry-to-effect flow, affected consumers, and reuse options with scip-plan; then verify the finished diff with scip-verify.',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

export function renderUserPromptContext(
  prompt: string,
  config: ProjectConfig = {},
  env: Record<string, string | undefined> = process.env,
): string {
  if (routerMode(config, env) === 'off') return '';
  const route = routesForPrompt(prompt);
  return route ? `scip-query routing reminder:\n${route.message}` : '';
}

type PromptRouteId = 'setup' | 'debug' | 'review' | 'implementation' | 'exploration' | 'diagram' | 'health';

interface PromptRoute {
  id: PromptRouteId;
  skillNames: string[];
  keywords: string[];
  message: string;
}

const PROMPT_ROUTES: PromptRoute[] = [
  {
    id: 'setup',
    skillNames: ['scip-setup'],
    keywords: ['setup', 'adopt', 'install', 'bootstrap'],
    message: 'Setup request: use scip-setup; keep CI setup out of the default path.',
  },
  {
    id: 'debug',
    skillNames: ['scip-diagnose'],
    keywords: [
      'debug',
      'bug',
      'regression',
      'failing',
      'fails',
      'error',
      'wrong',
      'broken',
      "doesn't work",
      'not working',
      'crash',
    ],
    message: 'Debug, root-cause, or issue-triage request: use scip-diagnose.',
  },
  {
    id: 'review',
    skillNames: ['scip-audit', 'scip-plan', 'scip-verify'],
    keywords: ['review', 'maintainability', 'architecture', 'boundary'],
    message:
      'Review request: use scip-audit for current structure, scip-plan for prospective API impact, or scip-verify for a finished change.',
  },
  {
    id: 'implementation',
    skillNames: ['scip-plan', 'scip-verify'],
    keywords: ['implement', 'build', 'change', 'refactor', 'fix', 'add', 'update'],
    message:
      'Before editing: use scip-plan and `scip-query plan-context <target>` to establish the current flow, affected consumers, and reuse options. After editing: use scip-verify.',
  },
  {
    id: 'exploration',
    skillNames: ['scip-explore'],
    keywords: ['explain', 'how does', 'walk me through', 'trace', 'understand'],
    message: 'Exploration request: use scip-explore before answering behavioral questions.',
  },
  {
    id: 'diagram',
    skillNames: ['scip-explore'],
    keywords: ['diagram', 'visualize', 'visualise', 'flow map', 'architecture map'],
    message: 'Diagram request: use scip-explore and back every node and edge with scip-query evidence.',
  },
  {
    id: 'health',
    skillNames: ['scip-audit', 'scip-improve'],
    keywords: [
      'health',
      'score',
      'dossier',
      'cleanup',
      'dead code',
      'duplicate',
      'debloat',
      'as high as',
      'maximize',
      'maximise',
    ],
    message:
      'Health or cleanup request: use scip-audit before editing; use scip-improve when the user wants confirmed issues fixed autonomously.',
  },
];

export function routesForPrompt(prompt: string): PromptRoute | null {
  const explicit = PROMPT_ROUTES.find((route) => route.skillNames.some((skill) => wordBoundaryMatch(prompt, skill)));
  if (explicit) return explicit;

  let hitCount = 0;
  const matches: PromptRoute[] = [];
  for (const route of PROMPT_ROUTES) {
    const routeHits = route.keywords.filter((keyword) => wordBoundaryMatch(prompt, keyword)).length;
    hitCount += routeHits;
    if (routeHits > 0) matches.push(route);
  }
  if (hitCount < 2 || matches.length === 0) return null;
  return matches[0]!;
}

function routerMode(config: ProjectConfig, env: Record<string, string | undefined>): 'off' | 'single' {
  return env['SCIP_QUERY_ROUTER'] === 'off' ? 'off' : (config.hooks?.router ?? 'single');
}

function wordBoundaryMatch(value: string, needle: string): boolean {
  const pattern = needle
    .trim()
    .split(/\s+/)
    .map((part) => escapeRegex(part))
    .join('\\s+');
  return new RegExp(`(?<![A-Za-z0-9_-])${pattern}(?![A-Za-z0-9_-])`, 'i').test(value);
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
      paths: ReturnType<typeof resolveIndexStoragePaths>;
    }
  | undefined {
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();
  const projectRoot = findGitRoot(cwd);
  if (!projectRoot) return undefined;

  try {
    const config = loadProjectConfig(projectRoot);
    const paths = resolveIndexStoragePaths(projectRoot, config);
    return { projectRoot, config, paths };
  } catch {
    return undefined;
  }
}

function withWorkspaceDb<T>(
  workspace: { projectRoot: string; config: ProjectConfig; paths: ReturnType<typeof resolveIndexStoragePaths> },
  run: (db: ScipDatabase) => T,
): T {
  const dbConfig: ScipQueryConfig = {
    dbPath: workspace.paths.dbPath,
    indexPath: workspace.paths.indexPath,
    projectRoot: workspace.projectRoot,
    collaborationDomainId: workspace.config.collaborationDomainId,
    sharedEvidenceDbPath: resolveSharedEvidenceDbPath(workspace.projectRoot, workspace.config),
    entryRoots: workspace.config.entryRoots,
    semantic: workspace.config.semantic,
    suppressions: workspace.config.suppressions,
    declaredCouplings: workspace.config.declaredCouplings,
    locality: workspace.config.locality,
    architecture: workspace.config.architecture,
    coverageContracts: workspace.config.coverageContracts,
    docs: workspace.config.docs,
  };
  const db = new ScipDatabase(dbConfig, createGitignoreFilter(workspace.projectRoot));
  try {
    return run(db);
  } finally {
    db.close();
  }
}
