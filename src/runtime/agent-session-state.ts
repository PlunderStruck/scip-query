import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isPathInsideProject } from '../domain/path-normalization.js';
import { stableJson } from '../domain/stable-json.js';
import {
  isObservationReceipt,
  observationReceiptGenerationIdentity,
  observationReceiptStabilityLabel,
  observationReceiptWorkspaceIdentity,
  type ObservationReceipt,
} from '../domain/observation-receipt.js';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import { inspectPendingCliOutputCursor, type PendingCliOutputSnapshot } from './output-pagination.js';
import { mutateTextFileRevisionAware } from './revisioned-file.js';

export const AGENT_SESSION_STATE_SCHEMA_VERSION = 2 as const;
export const AGENT_SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1_000;
export const AGENT_SESSION_TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
export const MAX_AGENT_SESSION_PENDING_OUTPUTS = 8;
const MAX_CONTINUATION_COMMAND_CHARACTERS = 16_384;

export type AgentSessionStopOutcome = 'pass' | 'pass-with-suppressions' | 'findings' | 'unresolved';

// scip-query: ignore-stale -- Persisted stop receipt is part of the agent-session state schema.
export interface AgentSessionStopReceipt {
  attemptedAtMs: number;
  outcome: AgentSessionStopOutcome;
  findingCount: number;
  automaticSuppressionCount: number;
  policyEscalationCount: number;
  observation?: ObservationReceipt;
  warning?: string;
}

// scip-query: ignore-stale -- Persisted pagination obligation is part of the agent-session state schema.
export interface AgentSessionPendingOutput {
  snapshotId: string;
  pageIndex: number;
  command: string;
  continuationCommand: string;
  remainingCharacters: number;
  totalCharacters: number;
  outputHash: string;
  createdAtMs: number;
}

/**
 * One delivery receipt identifies the exact restoration meaning injected for
 * one stable hook event. It suppresses duplicate hook invocations without
 * treating the reconstructable session cache as repository truth.
 */
export interface AgentSessionRestorationDelivery {
  projectionCursor: string;
  contextCursor: string;
  deliveryEpoch: string;
}

export interface AgentSessionState {
  schemaVersion: typeof AGENT_SESSION_STATE_SCHEMA_VERSION;
  sessionIdentity: string;
  projectIdentity: string;
  updatedAtMs: number;
  expiresAtMs: number;
  latestStop?: AgentSessionStopReceipt;
  unfinishedOutput: AgentSessionPendingOutput[];
  lastRestorationDelivery?: AgentSessionRestorationDelivery;
}

export interface UpdateAgentSessionStateInput {
  cacheDir: string;
  sessionId: string;
  projectRoot: string;
  nowMs?: number;
  latestStop?: AgentSessionStopReceipt;
  unfinishedOutput?: readonly AgentSessionPendingOutput[];
}

export interface ClaimAgentSessionRestorationInput {
  cacheDir: string;
  sessionId: string;
  projectRoot: string;
  projectionCursor: string;
  deliveryEpoch?: string;
  nowMs?: number;
  unfinishedOutput?: readonly AgentSessionPendingOutput[];
}

export interface ClaimAgentSessionRestorationResult {
  state: AgentSessionState;
  claimed: boolean;
}

export function agentSessionStatePath(cacheDir: string, sessionId: string): string {
  return join(cacheDir, 'agent-hooks', `session-${sessionIdentity(sessionId).slice(0, 32)}.json`);
}

export function readAgentSessionState(
  cacheDir: string,
  sessionId: string,
  projectRoot: string,
  nowMs = Date.now(),
): AgentSessionState | undefined {
  const path = agentSessionStatePath(cacheDir, sessionId);
  try {
    const parsed = JSON.parse(readSmallArtifactText(path, 'agent session state')) as unknown;
    if (!isAgentSessionState(parsed)) return undefined;
    if (
      parsed.sessionIdentity !== sessionIdentity(sessionId) ||
      parsed.projectIdentity !== projectIdentity(projectRoot) ||
      parsed.expiresAtMs <= nowMs
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Merge one bounded session receipt under a revision-aware lock. Stop and
 * PostCompact hooks can race without erasing each other's independently owned
 * fields.
 */
export function updateAgentSessionState(input: UpdateAgentSessionStateInput): AgentSessionState {
  const nowMs = input.nowMs ?? Date.now();
  const path = agentSessionStatePath(input.cacheDir, input.sessionId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const expectedSession = sessionIdentity(input.sessionId);
  const expectedProject = projectIdentity(input.projectRoot);
  const mutation = mutateTextFileRevisionAware(
    path,
    (snapshot) => {
      const existing = parseCurrentState(snapshot.text, expectedSession, expectedProject, nowMs);
      const next: AgentSessionState = {
        schemaVersion: AGENT_SESSION_STATE_SCHEMA_VERSION,
        sessionIdentity: expectedSession,
        projectIdentity: expectedProject,
        updatedAtMs: nowMs,
        expiresAtMs: nowMs + AGENT_SESSION_STATE_TTL_MS,
        ...((input.latestStop ?? existing?.latestStop)
          ? { latestStop: input.latestStop ?? existing!.latestStop! }
          : {}),
        unfinishedOutput: normalizePendingOutputs(input.unfinishedOutput ?? existing?.unfinishedOutput ?? []),
        ...(existing?.lastRestorationDelivery ? { lastRestorationDelivery: existing.lastRestorationDelivery } : {}),
      };
      return { kind: 'write', text: `${JSON.stringify(next, null, 2)}\n`, mode: 0o600 };
    },
    { maxRetries: 3 },
  );
  const parsed = JSON.parse(mutation.current.text) as unknown;
  if (!isAgentSessionState(parsed)) throw new Error('Agent session state failed validation after publication.');
  return parsed;
}

/**
 * Atomically claim one restoration delivery. Equal repository meaning and an
 * equal hook-event epoch are delivered once; a changed projection, changed
 * session evidence, or changed epoch is new resumable context.
 */
export function claimAgentSessionRestoration(
  input: ClaimAgentSessionRestorationInput,
): ClaimAgentSessionRestorationResult {
  if (!isSha256(input.projectionCursor)) throw new Error('projectionCursor must be a SHA-256 digest');
  if (input.deliveryEpoch !== undefined && !isSha256(input.deliveryEpoch)) {
    throw new Error('deliveryEpoch must be a SHA-256 digest when present');
  }
  const nowMs = input.nowMs ?? Date.now();
  const path = agentSessionStatePath(input.cacheDir, input.sessionId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const expectedSession = sessionIdentity(input.sessionId);
  const expectedProject = projectIdentity(input.projectRoot);
  let claimed = true;
  const mutation = mutateTextFileRevisionAware(
    path,
    (snapshot) => {
      const existing = parseCurrentState(snapshot.text, expectedSession, expectedProject, nowMs);
      const unfinishedOutput = normalizePendingOutputs(input.unfinishedOutput ?? existing?.unfinishedOutput ?? []);
      const contextCursor = restorationContextCursor(input.projectionCursor, existing?.latestStop, unfinishedOutput);
      const duplicate =
        input.deliveryEpoch !== undefined &&
        existing?.lastRestorationDelivery?.projectionCursor === input.projectionCursor &&
        existing.lastRestorationDelivery.contextCursor === contextCursor &&
        existing.lastRestorationDelivery.deliveryEpoch === input.deliveryEpoch;
      claimed = !duplicate;
      if (duplicate) return { kind: 'unchanged' };
      const next: AgentSessionState = {
        schemaVersion: AGENT_SESSION_STATE_SCHEMA_VERSION,
        sessionIdentity: expectedSession,
        projectIdentity: expectedProject,
        updatedAtMs: nowMs,
        expiresAtMs: nowMs + AGENT_SESSION_STATE_TTL_MS,
        ...(existing?.latestStop ? { latestStop: existing.latestStop } : {}),
        unfinishedOutput,
        ...(input.deliveryEpoch
          ? {
              lastRestorationDelivery: {
                projectionCursor: input.projectionCursor,
                contextCursor,
                deliveryEpoch: input.deliveryEpoch,
              },
            }
          : existing?.lastRestorationDelivery
            ? { lastRestorationDelivery: existing.lastRestorationDelivery }
            : {}),
      };
      return { kind: 'write', text: `${JSON.stringify(next, null, 2)}\n`, mode: 0o600 };
    },
    { maxRetries: 3 },
  );
  const parsed = JSON.parse(mutation.current.text) as unknown;
  if (!isAgentSessionState(parsed)) throw new Error('Agent session state failed validation after delivery claim.');
  return { state: parsed, claimed };
}

export function agentRestorationDeliveryEpoch(referent: string): string {
  return createHash('sha256').update(referent).digest('hex');
}

export function pendingOutputFromTranscript(
  transcriptTail: string,
  projectRoot: string,
  inspect: (cursor: string) => PendingCliOutputSnapshot | undefined = inspectPendingCliOutputCursor,
): AgentSessionPendingOutput[] {
  const latestBySnapshot = new Map<string, AgentSessionPendingOutput>();
  const cursorPattern = /--output-cursor(?:=|\s+)['"]?([A-Za-z0-9_-]{20,4096})/gu;
  for (const match of transcriptTail.matchAll(cursorPattern)) {
    const cursor = match[1];
    if (!cursor) continue;
    const pending = inspect(cursor);
    if (!pending || !pathBelongsToProject(projectRoot, pending.cwd)) continue;
    if (pending.continuationCommand.length > MAX_CONTINUATION_COMMAND_CHARACTERS) continue;
    const receipt: AgentSessionPendingOutput = {
      snapshotId: pending.snapshotId,
      pageIndex: pending.pageIndex,
      command: pending.command,
      continuationCommand: pending.continuationCommand,
      remainingCharacters: pending.remainingCharacters,
      totalCharacters: pending.totalCharacters,
      outputHash: pending.outputHash,
      createdAtMs: pending.createdAtMs,
    };
    const previous = latestBySnapshot.get(receipt.snapshotId);
    if (!previous || receipt.pageIndex > previous.pageIndex) latestBySnapshot.set(receipt.snapshotId, receipt);
  }
  return normalizePendingOutputs([...latestBySnapshot.values()]);
}

export function readAgentTranscriptTail(
  transcriptPath: string,
  maxBytes = AGENT_SESSION_TRANSCRIPT_TAIL_BYTES,
): string | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return undefined;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(transcriptPath, 'r');
    const before = fstatSync(descriptor);
    if (!before.isFile()) return undefined;
    const length = Math.min(before.size, maxBytes);
    const offset = before.size - length;
    const bytes = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const count = readSync(descriptor, bytes, bytesRead, length - bytesRead, offset + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    const after = fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || bytesRead !== length) {
      return undefined;
    }
    let text = bytes.toString('utf8');
    if (offset > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline < 0 ? '' : text.slice(firstNewline + 1);
    }
    return text;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function renderAgentSessionRestoration(state: AgentSessionState): string | undefined {
  const lines: string[] = [];
  if (state.unfinishedOutput.length > 0) {
    lines.push(
      `${state.unfinishedOutput.length} unfinished scip-query output snapshot(s) from this session remain. ` +
        'Incomplete pages are not evidence.',
    );
    for (const pending of state.unfinishedOutput) {
      lines.push(
        `- ${pending.command}: ${pending.remainingCharacters}/${pending.totalCharacters} characters remain. Continue exactly: ${pending.continuationCommand}`,
      );
    }
  }
  if (state.latestStop) {
    const stop = state.latestStop;
    lines.push(
      `Latest scip-query Stop attempt: ${stop.outcome}; ${stop.findingCount} finding(s), ` +
        `${stop.automaticSuppressionCount} automatic suppression(s), ${stop.policyEscalationCount} policy escalation(s).`,
    );
    if (stop.observation) {
      lines.push(
        `Observed state: generation=${observationReceiptGenerationIdentity(stop.observation) ?? 'unknown'}, ` +
          `workspace=${observationReceiptWorkspaceIdentity(stop.observation) ?? 'unknown'} ` +
          `(${observationReceiptStabilityLabel(stop.observation)}).`,
      );
    }
    if (stop.warning) lines.push(`Stop evidence warning: ${stop.warning}`);
  }
  return lines.length > 0 ? `Restored scip-query evidence state after compaction:\n${lines.join('\n')}` : undefined;
}

function parseCurrentState(
  text: string,
  expectedSession: string,
  expectedProject: string,
  nowMs: number,
): AgentSessionState | undefined {
  if (!text.trim()) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isAgentSessionState(parsed) &&
      parsed.sessionIdentity === expectedSession &&
      parsed.projectIdentity === expectedProject &&
      parsed.expiresAtMs > nowMs
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizePendingOutputs(values: readonly AgentSessionPendingOutput[]): AgentSessionPendingOutput[] {
  return [...values]
    .filter(isAgentSessionPendingOutput)
    .sort((left, right) => right.createdAtMs - left.createdAtMs || right.pageIndex - left.pageIndex)
    .slice(0, MAX_AGENT_SESSION_PENDING_OUTPUTS);
}

function pathBelongsToProject(projectRoot: string, cwd: string): boolean {
  return isPathInsideProject(resolve(projectRoot), resolve(cwd));
}

function sessionIdentity(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

function projectIdentity(projectRoot: string): string {
  return createHash('sha256').update(resolve(projectRoot)).digest('hex');
}

function isAgentSessionState(value: unknown): value is AgentSessionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<AgentSessionState>;
  return (
    state.schemaVersion === AGENT_SESSION_STATE_SCHEMA_VERSION &&
    isSha256(state.sessionIdentity) &&
    isSha256(state.projectIdentity) &&
    Number.isSafeInteger(state.updatedAtMs) &&
    (state.updatedAtMs ?? -1) >= 0 &&
    Number.isSafeInteger(state.expiresAtMs) &&
    (state.expiresAtMs ?? -1) >= 0 &&
    (state.latestStop === undefined || isAgentSessionStopReceipt(state.latestStop)) &&
    Array.isArray(state.unfinishedOutput) &&
    state.unfinishedOutput.length <= MAX_AGENT_SESSION_PENDING_OUTPUTS &&
    state.unfinishedOutput.every(isAgentSessionPendingOutput) &&
    (state.lastRestorationDelivery === undefined || isAgentSessionRestorationDelivery(state.lastRestorationDelivery))
  );
}

function restorationContextCursor(
  projectionCursor: string,
  latestStop: AgentSessionStopReceipt | undefined,
  unfinishedOutput: readonly AgentSessionPendingOutput[],
): string {
  return createHash('sha256')
    .update(stableJson({ projectionCursor, latestStop: latestStop ?? null, unfinishedOutput }))
    .digest('hex');
}

function isAgentSessionRestorationDelivery(value: unknown): value is AgentSessionRestorationDelivery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const delivery = value as Partial<AgentSessionRestorationDelivery>;
  return isSha256(delivery.projectionCursor) && isSha256(delivery.contextCursor) && isSha256(delivery.deliveryEpoch);
}

function isAgentSessionStopReceipt(value: unknown): value is AgentSessionStopReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stop = value as Partial<AgentSessionStopReceipt>;
  return (
    Number.isSafeInteger(stop.attemptedAtMs) &&
    (stop.attemptedAtMs ?? -1) >= 0 &&
    (stop.outcome === 'pass' ||
      stop.outcome === 'pass-with-suppressions' ||
      stop.outcome === 'findings' ||
      stop.outcome === 'unresolved') &&
    isBoundedCount(stop.findingCount) &&
    isBoundedCount(stop.automaticSuppressionCount) &&
    isBoundedCount(stop.policyEscalationCount) &&
    (stop.observation === undefined || isObservationReceipt(stop.observation)) &&
    (stop.warning === undefined || isBoundedString(stop.warning, 4_096))
  );
}

function isAgentSessionPendingOutput(value: unknown): value is AgentSessionPendingOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pending = value as Partial<AgentSessionPendingOutput>;
  return (
    isBoundedString(pending.snapshotId, 64) &&
    Number.isSafeInteger(pending.pageIndex) &&
    (pending.pageIndex ?? -1) >= 1 &&
    isBoundedString(pending.command, 256) &&
    isBoundedString(pending.continuationCommand, MAX_CONTINUATION_COMMAND_CHARACTERS) &&
    isBoundedCount(pending.remainingCharacters) &&
    isBoundedCount(pending.totalCharacters) &&
    (pending.remainingCharacters ?? 1) > 0 &&
    (pending.remainingCharacters ?? 0) <= (pending.totalCharacters ?? -1) &&
    isSha256(pending.outputHash) &&
    Number.isSafeInteger(pending.createdAtMs) &&
    (pending.createdAtMs ?? -1) >= 0
  );
}

function isBoundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
