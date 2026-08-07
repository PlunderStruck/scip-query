import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import { tryAcquireProcessFileLock } from '../platform/process-file-lock.js';
import { writeJsonAtomic } from '../storage/atomic-json.js';

const NAVIGATION_SESSION_VERSION = 1;
const SESSION_ENV = 'SCIP_QUERY_SESSION';
const SESSION_ROOT_ENV = 'SCIP_QUERY_SESSION_DIR';
const MAX_SESSION_NAME_CHARACTERS = 128;
const MAX_RECOMMENDED_MAP_COMMANDS = 8;
const MAX_RECOMMENDED_MAP_COMMAND_CHARACTERS = 32_768;

const stagedMapCommands = new Map<string, readonly string[]>();

interface NavigationSessionState {
  version: typeof NAVIGATION_SESSION_VERSION;
  projectRoot: string;
  sessionIdentity: string;
  mapRequired: true;
  recommendedMapCommands?: readonly string[];
  pendingMapContinuation?: string;
  mapExecution?: {
    processId: number;
    startedAt: string;
  };
  updatedAt: string;
}

/**
 * Retain the exact map choices rendered by an anchors invocation until its
 * output reaches stdout. The delivery hook consumes this process-local stage,
 * so a failed render cannot create a cross-command navigation requirement.
 */
export function stageNavigationMapCommands(cwd: string, commands: readonly string[], sessionEnabled = true): void {
  if (!sessionEnabled) return;
  const sessionIdentity = explicitSessionIdentity();
  if (!sessionIdentity) return;
  const projectRoot = navigationProjectRoot(cwd);
  const usableCommands = commands
    .map((command) => command.trim())
    .filter(
      (command) =>
        command.startsWith('scip-query system-map ') && command.length <= MAX_RECOMMENDED_MAP_COMMAND_CHARACTERS,
    )
    .slice(0, MAX_RECOMMENDED_MAP_COMMANDS);
  const key = navigationSessionKey(projectRoot, sessionIdentity);
  if (usableCommands.length === 0) stagedMapCommands.delete(key);
  else stagedMapCommands.set(key, usableCommands);
}

/**
 * Persist the causal ordering of the agent navigation protocol only when an
 * explicit cross-command session is active. Anchor delivery starts the map
 * requirement; a system map clears it only after its complete transport has
 * reached stdout. This makes concurrent map/detail exploration impossible
 * without constraining direct expert invocations that did not use anchors.
 */
export function recordNavigationOutputDelivery(
  command: string,
  cwd: string,
  transportComplete: boolean,
  sessionEnabled = true,
  continuationCommand?: string,
): void {
  if (!sessionEnabled) return;
  if (command !== 'anchors' && command !== 'system-map') return;
  const sessionIdentity = explicitSessionIdentity();
  if (!sessionIdentity) return;
  const projectRoot = navigationProjectRoot(cwd);
  const path = navigationStatePath(projectRoot, sessionIdentity);

  if (command === 'system-map') {
    if (transportComplete) {
      rmSync(path, { force: true });
    } else if (existsSync(path) && continuationCommand) {
      withNavigationStateLock(path, () => {
        const state = readNavigationState(path, projectRoot, sessionIdentity);
        if (!state) return;
        writeJsonAtomic(
          path,
          {
            ...state,
            pendingMapContinuation: continuationCommand,
            mapExecution: undefined,
            updatedAt: new Date().toISOString(),
          },
          { spacing: 2, trailingNewline: true },
        );
      });
    }
    return;
  }

  withNavigationStateLock(path, () => {
    const recommendedMapCommands = consumeStagedMapCommands(projectRoot, sessionIdentity);
    const state: NavigationSessionState = {
      version: NAVIGATION_SESSION_VERSION,
      projectRoot,
      sessionIdentity,
      mapRequired: true,
      ...(recommendedMapCommands.length > 0 ? { recommendedMapCommands } : {}),
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(path, state, { spacing: 2, trailingNewline: true });
  });
}

/**
 * Claim the selected map before repository work begins. This closes the race
 * in which an agent launches the same map twice in parallel before either
 * process has produced the first transport page.
 */
export function assertNavigationMapCanStart(cwd: string, sessionEnabled = true): void {
  if (!sessionEnabled) return;
  const sessionIdentity = explicitSessionIdentity();
  if (!sessionIdentity) return;
  const projectRoot = navigationProjectRoot(cwd);
  const path = navigationStatePath(projectRoot, sessionIdentity);
  if (!existsSync(path)) return;
  withNavigationStateLock(path, () => {
    const state = readNavigationState(path, projectRoot, sessionIdentity);
    if (!state) return;
    if (state.pendingMapContinuation) {
      throw new Error(
        [
          'MAP TRANSPORT INCOMPLETE',
          'The selected system map has already been computed. Restarting it would repeat the same repository work.',
          `Continue exactly: ${state.pendingMapContinuation}`,
        ].join('\n'),
      );
    }
    if (state.mapExecution && processIsRunning(state.mapExecution.processId)) {
      throw new Error(
        [
          'NAVIGATION MAP ALREADY RUNNING',
          'A selected system map is already computing in this SCIP_QUERY_SESSION.',
          'Poll the existing terminal execution. Do not launch a duplicate map or inspect in parallel.',
        ].join('\n'),
      );
    }
    writeJsonAtomic(
      path,
      {
        ...state,
        mapExecution: { processId: process.pid, startedAt: new Date().toISOString() },
        updatedAt: new Date().toISOString(),
      },
      { spacing: 2, trailingNewline: true },
    );
  });
}

/** Reject detail materialization after anchors until a selected map finishes. */
export function assertNavigationDetailAllowed(projectRoot: string, detailCommand: string, sessionEnabled = true): void {
  if (!sessionEnabled) return;
  const sessionIdentity = explicitSessionIdentity();
  if (!sessionIdentity) return;
  const path = navigationStatePath(resolve(projectRoot), sessionIdentity);
  if (!existsSync(path)) return;
  const state = readNavigationState(path, resolve(projectRoot), sessionIdentity);
  if (!state?.mapRequired) return;
  const recoveryRows = state.recommendedMapCommands?.length
    ? [
        'This refusal is a recoverable protocol step, not evidence that the requested code cannot be explored.',
        'Run exactly one of the ranked map commands below, then finish every emitted continuation:',
        ...state.recommendedMapCommands.map((command, index) => `  [${index + 1}] ${command}`),
      ]
    : [
        `Do not retry ${detailCommand}. Run one printed next-abstraction system-map command and finish every emitted continuation first.`,
      ];
  throw new Error(
    [
      'NAVIGATION MAP REQUIRED',
      `An anchors locator completed in this SCIP_QUERY_SESSION, but its selected system map has not reached transport completion.`,
      `Do not retry ${detailCommand}.`,
      ...recoveryRows,
      'The map must complete before the agent can choose source detail; map and detail exploration cannot run concurrently.',
    ].join('\n'),
  );
}

function readNavigationState(
  path: string,
  projectRoot: string,
  sessionIdentity: string,
): NavigationSessionState | null {
  try {
    const value = JSON.parse(
      readSmallArtifactText(path, 'navigation session state'),
    ) as Partial<NavigationSessionState>;
    return value.version === NAVIGATION_SESSION_VERSION &&
      value.projectRoot === projectRoot &&
      value.sessionIdentity === sessionIdentity &&
      value.mapRequired === true &&
      (value.recommendedMapCommands === undefined ||
        (Array.isArray(value.recommendedMapCommands) &&
          value.recommendedMapCommands.length <= MAX_RECOMMENDED_MAP_COMMANDS &&
          value.recommendedMapCommands.every(
            (command) =>
              typeof command === 'string' &&
              command.startsWith('scip-query system-map ') &&
              command.length <= MAX_RECOMMENDED_MAP_COMMAND_CHARACTERS,
          ))) &&
      (value.pendingMapContinuation === undefined || typeof value.pendingMapContinuation === 'string') &&
      (value.mapExecution === undefined ||
        (typeof value.mapExecution === 'object' &&
          value.mapExecution !== null &&
          Number.isSafeInteger(value.mapExecution.processId) &&
          typeof value.mapExecution.startedAt === 'string'))
      ? (value as NavigationSessionState)
      : null;
  } catch {
    // A corrupt optional state file must not permanently block repository
    // access. The next anchors invocation replaces it atomically.
    return null;
  }
}

function consumeStagedMapCommands(projectRoot: string, sessionIdentity: string): readonly string[] {
  const key = navigationSessionKey(projectRoot, sessionIdentity);
  const commands = stagedMapCommands.get(key) ?? [];
  stagedMapCommands.delete(key);
  return commands;
}

function navigationSessionKey(projectRoot: string, sessionIdentity: string): string {
  return `${projectRoot}\0${sessionIdentity}`;
}

function processIsRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function navigationStatePath(projectRoot: string, sessionIdentity: string): string {
  const root = navigationSessionRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = createHash('sha256').update(projectRoot).update('\0').update(sessionIdentity).digest('hex');
  return join(root, `navigation-${id}.json`);
}

function navigationSessionRoot(): string {
  const configured = process.env[SESSION_ROOT_ENV];
  if (!configured) return join(tmpdir(), `scip-query-source-sessions-${process.getuid?.() ?? 'user'}`);
  if (!isAbsolute(configured)) throw new Error(`${SESSION_ROOT_ENV} must be an absolute path.`);
  return resolve(configured);
}

function navigationProjectRoot(cwd: string): string {
  const configured = process.env['SCIP_QUERY_PROJECT_ROOT']?.trim();
  return resolve(configured || cwd);
}

function explicitSessionIdentity(): string | undefined {
  const explicit = process.env[SESSION_ENV]?.trim();
  if (!explicit) return undefined;
  if (explicit.length > MAX_SESSION_NAME_CHARACTERS || !/^[A-Za-z0-9._:-]+$/u.test(explicit)) return undefined;
  return `explicit:${explicit}`;
}

function withNavigationStateLock(path: string, action: () => void): void {
  const result = tryAcquireProcessFileLock(`${path}.lock`, {
    kind: 'navigation-session',
    detail: { state: path.slice(-17, -5) },
  });
  if (result.kind !== 'acquired') throw new Error('Navigation session state is busy. Retry the completed command.');
  try {
    action();
  } finally {
    result.lock.release();
  }
}
