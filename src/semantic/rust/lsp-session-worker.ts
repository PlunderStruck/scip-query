import process from 'node:process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parentPort } from 'node:worker_threads';
import { profileAsyncSpan, profileEnabled, writeProfileEvent } from '../../instrumentation/profile.js';
import type { SemanticCallee, SemanticReference } from '../types.js';
import { createRustAnalyzerTransport, RustAnalyzerLspClient } from './lsp-client.js';
import type { LspInitializeResult } from './lsp-types.js';
import type { RustImportDefinitionWorkerRequest, RustImportDefinitionWorkerResponse } from './lsp-session.js';
import {
  rustAnalyzerReadinessWorkerErrorEnvelope,
  waitForRustAnalyzerDiagnosticsWithinDeadline,
  waitForRustAnalyzerInitialPostOpenReadiness,
  waitForRustAnalyzerPostOpenReadiness,
  withRustAnalyzerReadinessInvalidation,
} from './lsp-session-readiness.js';
import {
  calleesForDefinition,
  cargoManifestsForDefinitions,
  referencesWithCompletion,
  runWithConcurrency,
  rustAnalyzerInitializationOptions,
  rustAnalyzerSessionRoot,
  signatureForDefinition,
  sleep,
  openDefinitionDocuments,
  waitForOpenedDocuments,
  rustRequestCalleeDefinitions,
  rustRequestReferenceDefinitions,
  rustRequestSessionDefinitions,
  rustRequestSignatureDefinitions,
  type RustReferenceWorkerRequest,
  type RustReferenceWorkerResponse,
} from './lsp-batch-worker.js';
import {
  dedupeSemanticReferences,
  definitionToReferenceParams,
  documentUriToRelativePath,
  filePathToDocumentUri,
  locationsToSemanticReferences,
} from './reference-mapping.js';

type RustSessionWorkerMessage =
  | {
      kind: 'semantic';
      request: RustReferenceWorkerRequest;
      responsePath: string;
      sharedBuffer: SharedArrayBuffer;
    }
  | {
      kind: 'import-definitions';
      request: RustImportDefinitionWorkerRequest;
      responsePath: string;
      sharedBuffer: SharedArrayBuffer;
    }
  | {
      kind: 'shutdown';
      responsePath: string;
      sharedBuffer: SharedArrayBuffer;
    };

interface RustAnalyzerSessionState {
  key: string;
  client: RustAnalyzerLspClient;
  capabilities: LspInitializeResult['capabilities'];
  openedPaths: Set<string>;
  initializationReadiness: { afterGeneration: number; deadlineMs: number } | null;
}

interface ReferenceTaskResult {
  symbolId: number;
  references: SemanticReference[];
  complete: boolean;
}

interface CalleeTaskResult {
  symbolId: number;
  callees: SemanticCallee[];
}

interface SignatureTaskResult {
  symbolId: number;
  signature: string | null;
}

interface RustReferenceFileProfile {
  definitions: number;
  definitionsWithReferences: number;
  references: number;
  durationMs: number;
  maxDurationMs: number;
  slowTasks: number;
}

interface RustCalleeFileProfile {
  definitions: number;
  definitionsWithCallees: number;
  callees: number;
  durationMs: number;
  maxDurationMs: number;
  slowTasks: number;
}

const REFERENCE_TASK_PROFILE_THRESHOLD_ENV = 'SCIP_RUST_SEMANTIC_REFERENCE_TASK_PROFILE_MS';
const CALLEE_TASK_PROFILE_THRESHOLD_ENV = 'SCIP_RUST_SEMANTIC_CALLEE_TASK_PROFILE_MS';

const sessions = new Map<string, RustAnalyzerSessionState>();
let queue = Promise.resolve();

parentPort?.on('message', (message: RustSessionWorkerMessage) => {
  queue = queue.then(() => handleMessage(message)).catch(() => undefined);
});

async function handleMessage(message: RustSessionWorkerMessage): Promise<void> {
  if (message.kind === 'shutdown') {
    await shutdownSessions();
    writeWorkerResponse(message.responsePath, { ok: true }, message.sharedBuffer);
    return;
  }

  if (message.kind === 'import-definitions') {
    try {
      const response = await runImportDefinitionRequest(message.request);
      writeWorkerResponse(message.responsePath, { ok: true, response }, message.sharedBuffer);
    } catch (error) {
      const readinessError = rustAnalyzerReadinessWorkerErrorEnvelope(error);
      if (readinessError) {
        writeWorkerResponse(message.responsePath, readinessError, message.sharedBuffer);
        return;
      }
      const response: RustImportDefinitionWorkerResponse = {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
        sourcePaths: message.request.positions.map((position) => [position.id, null]),
      };
      writeWorkerResponse(message.responsePath, { ok: true, response }, message.sharedBuffer);
    }
    return;
  }

  try {
    const response = await runSessionRequest(message.request);
    writeWorkerResponse(message.responsePath, { ok: true, response }, message.sharedBuffer);
  } catch (error) {
    const readinessError = rustAnalyzerReadinessWorkerErrorEnvelope(error);
    if (readinessError) {
      writeWorkerResponse(message.responsePath, readinessError, message.sharedBuffer);
      return;
    }
    const response = emptyResponse(message.request, error instanceof Error ? error.message : String(error));
    writeWorkerResponse(message.responsePath, { ok: true, response }, message.sharedBuffer);
  }
}

async function runImportDefinitionRequest(
  request: RustImportDefinitionWorkerRequest,
): Promise<RustImportDefinitionWorkerResponse> {
  const requestOptions = { timeoutMs: request.requestTimeoutMs, deadlineMs: request.readinessDeadlineMs };
  const session = await profileAsyncSpan(
    'rust.semantic.worker.session',
    () =>
      sessionForPaths(request.projectRoot, request.rustAnalyzerBinary, [request.file], {
        requestTimeoutMs: request.requestTimeoutMs,
        readinessDeadlineMs: request.readinessDeadlineMs,
      }),
    () => ({
      kind: 'import-definitions',
      files: 1,
      positions: request.positions.length,
    }),
  );
  if (!session.capabilities.definitionProvider) {
    return {
      available: false,
      reason: 'rust-analyzer initialized without textDocument/definition support.',
      sourcePaths: request.positions.map((position) => [position.id, null]),
    };
  }

  let openedDocuments = 0;
  await withRustAnalyzerReadinessInvalidation(
    () =>
      profileAsyncSpan(
        'rust.semantic.worker.open-source-documents',
        async () => {
          openedDocuments = await openNewSourceDocuments(session, request.projectRoot, [request.file], {
            diagnosticsTimeoutMs: request.diagnosticsTimeoutMs,
            settleDelayMs: request.settleDelayMs,
            readinessDeadlineMs: request.readinessDeadlineMs,
          });
        },
        () => ({
          files: 1,
          openedDocuments,
          positions: request.positions.length,
        }),
      ),
    () => discardRustAnalyzerSession(sessions, session, request.readinessDeadlineMs),
  );

  let resolvedPositions = 0;
  const sourcePaths = await profileAsyncSpan(
    'rust.semantic.worker.import-definitions',
    () =>
      runWithConcurrency(request.positions, request.concurrency ?? 8, async (position) => {
        const definitions = await session.client.definition(
          {
            textDocument: { uri: filePathToDocumentUri(request.projectRoot, position.file) },
            position: { line: position.line, character: position.column },
          },
          requestOptions,
        );
        const resolvedPath = firstProjectLocalDefinitionPath(request.projectRoot, definitions);
        if (resolvedPath) resolvedPositions += 1;
        return [position.id, resolvedPath] as [string, string | null];
      }),
    () => ({
      positions: request.positions.length,
      resolvedPositions,
      concurrency: request.concurrency ?? 8,
    }),
  );

  return {
    available: true,
    sourcePaths,
  };
}

async function runSessionRequest(request: RustReferenceWorkerRequest): Promise<RustReferenceWorkerResponse> {
  const requestOptions = { timeoutMs: request.requestTimeoutMs, deadlineMs: request.readinessDeadlineMs };
  const includeReferences = request.includeReferences !== false;
  const includeCallees = request.includeCallees === true;
  const includeSignatures = request.includeSignatures === true;
  const referenceDefinitions = rustRequestReferenceDefinitions(request);
  const calleeDefinitions = rustRequestCalleeDefinitions(request);
  const signatureDefinitions = rustRequestSignatureDefinitions(request);
  const sessionDefinitions = rustRequestSessionDefinitions(request);
  const session = await profileAsyncSpan(
    'rust.semantic.worker.session',
    () => sessionFor(request),
    () => ({
      kind: 'semantic',
      definitions: sessionDefinitions.length,
      referenceDefinitions: referenceDefinitions.length,
      calleeDefinitions: calleeDefinitions.length,
      signatureDefinitions: signatureDefinitions.length,
      references: includeReferences,
      callees: includeCallees,
      signatures: includeSignatures,
    }),
  );

  const unavailableReason = unavailableCapabilityReason(session.capabilities, {
    references: includeReferences,
    callees: includeCallees,
    signatures: includeSignatures,
  });
  if (unavailableReason) return emptyResponse(request, unavailableReason);

  let openedDocuments = 0;
  await withRustAnalyzerReadinessInvalidation(
    () =>
      profileAsyncSpan(
        'rust.semantic.worker.open-definition-documents',
        async () => {
          openedDocuments = await openNewDefinitionDocuments(session, request);
        },
        () => ({
          definitions: sessionDefinitions.length,
          openedDocuments,
        }),
      ),
    () => discardRustAnalyzerSession(sessions, session, request.readinessDeadlineMs),
  );

  let referenceCount = 0;
  let definitionsWithReferences = 0;
  const referenceProfilingEnabled = profileEnabled();
  const referenceFileProfile = referenceProfilingEnabled ? new Map<string, RustReferenceFileProfile>() : null;
  const slowReferenceTaskThresholdMs = referenceProfilingEnabled
    ? optionalNonNegativeInteger(process.env[REFERENCE_TASK_PROFILE_THRESHOLD_ENV])
    : null;
  const computeReferences = (): Promise<ReferenceTaskResult[]> =>
    includeReferences
      ? profileAsyncSpan(
          'rust.semantic.worker.references',
          () =>
            runWithConcurrency(
              referenceDefinitions,
              request.concurrency ?? 8,
              async (definition): Promise<ReferenceTaskResult> => {
                const taskStarted = referenceProfilingEnabled ? performance.now() : 0;
                const lookup = await referencesWithCompletion(
                  session.client,
                  definitionToReferenceParams(request.projectRoot, definition, false),
                  {
                    requestTimeoutMs: request.requestTimeoutMs,
                    retryTimeoutMs: request.referenceRetryTimeoutMs,
                    deadlineMs: request.readinessDeadlineMs,
                  },
                );
                const semanticReferences = dedupeSemanticReferences(
                  locationsToSemanticReferences(request.projectRoot, lookup.locations),
                );
                const taskDurationMs = referenceProfilingEnabled ? Math.round(performance.now() - taskStarted) : 0;
                recordRustReferenceFileProfile(referenceFileProfile, definition.relativePath, {
                  durationMs: taskDurationMs,
                  references: semanticReferences.length,
                  hasReferences: semanticReferences.length > 0,
                  slow: slowReferenceTaskThresholdMs !== null && taskDurationMs >= slowReferenceTaskThresholdMs,
                });
                if (slowReferenceTaskThresholdMs !== null && taskDurationMs >= slowReferenceTaskThresholdMs) {
                  writeProfileEvent({
                    type: 'span',
                    name: 'rust.semantic.worker.reference-task',
                    durationMs: taskDurationMs,
                    ok: true,
                    symbolId: definition.symbolId,
                    relativePath: definition.relativePath,
                    leaf: definition.leaf,
                    kind: definition.kind,
                    startLine: definition.startLine,
                    endLine: definition.endLine,
                    references: semanticReferences.length,
                    complete: lookup.complete,
                  });
                }
                if (semanticReferences.length > 0) definitionsWithReferences += 1;
                referenceCount += semanticReferences.length;
                return {
                  symbolId: definition.symbolId,
                  references: semanticReferences,
                  complete: lookup.complete,
                };
              },
            ),
          () => ({
            definitions: referenceDefinitions.length,
            concurrency: request.concurrency ?? 8,
            definitionsWithReferences,
            references: referenceCount,
          }),
        )
      : Promise.resolve(
          referenceDefinitions.map((definition) => ({ symbolId: definition.symbolId, references: [], complete: true })),
        );

  let calleeCount = 0;
  let definitionsWithCallees = 0;
  const calleeProfilingEnabled = profileEnabled();
  const calleeFileProfile = calleeProfilingEnabled ? new Map<string, RustCalleeFileProfile>() : null;
  const slowCalleeTaskThresholdMs = calleeProfilingEnabled
    ? optionalNonNegativeInteger(process.env[CALLEE_TASK_PROFILE_THRESHOLD_ENV])
    : null;
  const computeCallees = (): Promise<CalleeTaskResult[]> =>
    includeCallees
      ? profileAsyncSpan(
          'rust.semantic.worker.callees',
          () =>
            runWithConcurrency(
              calleeDefinitions,
              request.concurrency ?? 8,
              async (definition): Promise<CalleeTaskResult> => {
                const taskStarted = calleeProfilingEnabled ? performance.now() : 0;
                const semanticCallees = await calleesForDefinition(
                  session.client,
                  request.projectRoot,
                  definition,
                  requestOptions,
                );
                const taskDurationMs = calleeProfilingEnabled ? Math.round(performance.now() - taskStarted) : 0;
                recordRustCalleeFileProfile(calleeFileProfile, definition.relativePath, {
                  durationMs: taskDurationMs,
                  callees: semanticCallees.length,
                  hasCallees: semanticCallees.length > 0,
                  slow: slowCalleeTaskThresholdMs !== null && taskDurationMs >= slowCalleeTaskThresholdMs,
                });
                if (slowCalleeTaskThresholdMs !== null && taskDurationMs >= slowCalleeTaskThresholdMs) {
                  writeProfileEvent({
                    type: 'span',
                    name: 'rust.semantic.worker.callee-task',
                    durationMs: taskDurationMs,
                    ok: true,
                    symbolId: definition.symbolId,
                    relativePath: definition.relativePath,
                    leaf: definition.leaf,
                    kind: definition.kind,
                    startLine: definition.startLine,
                    endLine: definition.endLine,
                    callees: semanticCallees.length,
                  });
                }
                if (semanticCallees.length > 0) definitionsWithCallees += 1;
                calleeCount += semanticCallees.length;
                return {
                  symbolId: definition.symbolId,
                  callees: semanticCallees,
                };
              },
            ),
          () => ({
            definitions: calleeDefinitions.length,
            concurrency: request.concurrency ?? 8,
            definitionsWithCallees,
            callees: calleeCount,
          }),
        )
      : Promise.resolve([]);

  let references: ReferenceTaskResult[];
  let callees: CalleeTaskResult[];
  if (
    includeReferences &&
    includeCallees &&
    referenceDefinitions.length > 0 &&
    calleeDefinitions.length > 0 &&
    parallelRustSemanticOperationsEnabled()
  ) {
    [references, callees] = await Promise.all([computeReferences(), computeCallees()]);
  } else {
    references = await computeReferences();
    callees = await computeCallees();
  }
  writeRustReferenceFileProfileEvents(referenceFileProfile);
  writeRustCalleeFileProfileEvents(calleeFileProfile);

  let signaturesFound = 0;
  const signatures = includeSignatures
    ? await profileAsyncSpan(
        'rust.semantic.worker.signatures',
        () =>
          runWithConcurrency(
            signatureDefinitions,
            request.concurrency ?? 8,
            async (definition): Promise<SignatureTaskResult> => {
              const signature = await signatureForDefinition(
                session.client,
                request.projectRoot,
                definition,
                requestOptions,
              );
              if (signature) signaturesFound += 1;
              return {
                symbolId: definition.symbolId,
                signature,
              };
            },
          ),
        () => ({
          definitions: signatureDefinitions.length,
          concurrency: request.concurrency ?? 8,
          signaturesFound,
        }),
      )
    : [];

  return {
    available: true,
    references: references.filter((result) => result.complete).map((result) => [result.symbolId, result.references]),
    incompleteReferenceSymbolIds: references.filter((result) => !result.complete).map((result) => result.symbolId),
    ...(includeCallees ? { callees: callees.map((result) => [result.symbolId, result.callees]) } : {}),
    ...(includeSignatures ? { signatures: signatures.map((result) => [result.symbolId, result.signature]) } : {}),
  };
}

async function sessionFor(request: RustReferenceWorkerRequest): Promise<RustAnalyzerSessionState> {
  return sessionForPaths(
    request.projectRoot,
    request.rustAnalyzerBinary,
    rustRequestSessionDefinitions(request).map((definition) => definition.relativePath),
    {
      requestTimeoutMs: request.requestTimeoutMs,
      readinessDeadlineMs: request.readinessDeadlineMs,
    },
  );
}

async function sessionForPaths(
  projectRoot: string,
  rustAnalyzerBinary: string,
  relativePaths: readonly string[],
  opts: { requestTimeoutMs?: number; readinessDeadlineMs?: number },
): Promise<RustAnalyzerSessionState> {
  const linkedProjects = cargoManifestsForDefinitions(
    projectRoot,
    relativePaths.map((relativePath) => ({ relativePath })),
  );
  const sessionRoot = rustAnalyzerSessionRoot(projectRoot, linkedProjects);
  const key = sessionKey(rustAnalyzerBinary, sessionRoot, linkedProjects);
  const existing = sessions.get(key);
  if (existing) return existing;

  const initializationOptions = rustAnalyzerInitializationOptions(linkedProjects);
  const client = new RustAnalyzerLspClient(createRustAnalyzerTransport(rustAnalyzerBinary, sessionRoot), {
    requestTimeoutMs: opts.requestTimeoutMs,
    configuration: initializationOptions,
  });
  const initializationReadiness =
    opts.readinessDeadlineMs === undefined
      ? null
      : {
          afterGeneration: client.serverStatusGeneration(),
          deadlineMs: opts.readinessDeadlineMs,
        };
  const initialized = await withRustAnalyzerReadinessInvalidation(
    () =>
      profileAsyncSpan(
        'rust.semantic.worker.initialize',
        () =>
          client.initialize(
            {
              processId: process.pid,
              rootUri: filePathToDocumentUri(sessionRoot, '.'),
              capabilities: {
                textDocument: {
                  references: {
                    dynamicRegistration: false,
                  },
                  definition: {
                    dynamicRegistration: false,
                  },
                  callHierarchy: {
                    dynamicRegistration: false,
                  },
                  hover: {
                    dynamicRegistration: false,
                  },
                },
              },
              initializationOptions,
            },
            { timeoutMs: opts.requestTimeoutMs, deadlineMs: opts.readinessDeadlineMs },
          ),
        () => ({
          linkedProjects: linkedProjects.length,
          relativePaths: relativePaths.length,
        }),
      ),
    () => client.shutdown({ deadlineMs: opts.readinessDeadlineMs }).catch(() => undefined),
  );
  const session: RustAnalyzerSessionState = {
    key,
    client,
    capabilities: initialized.capabilities,
    openedPaths: new Set(),
    initializationReadiness,
  };
  sessions.set(key, session);
  return session;
}

// scip-query: ignore-similar — definition and source readiness have different inputs and state transitions.
async function openNewDefinitionDocuments(
  session: RustAnalyzerSessionState,
  request: RustReferenceWorkerRequest,
): Promise<number> {
  const definitionsToOpen = rustRequestSessionDefinitions(request).filter((definition) => {
    if (session.openedPaths.has(definition.relativePath)) return false;
    return existsSync(resolve(request.projectRoot, definition.relativePath));
  });
  if (definitionsToOpen.length === 0) {
    await waitForRustAnalyzerInitialReadinessWithoutDocuments(session);
    return 0;
  }

  const initializationReadiness = session.initializationReadiness;
  const readiness =
    request.readinessDeadlineMs === undefined
      ? null
      : {
          statusSnapshot: initializationReadiness ? null : session.client.serverStatusSnapshot(),
          initializationGeneration: initializationReadiness?.afterGeneration,
          deadlineMs: request.readinessDeadlineMs,
        };
  const openedUris = openDefinitionDocuments(session.client, request.projectRoot, definitionsToOpen);
  for (const definition of definitionsToOpen) {
    session.openedPaths.add(definition.relativePath);
  }
  const diagnosticsTimeoutMs = request.diagnosticsTimeoutMs ?? 10_000;
  let effectiveDiagnosticsTimeoutMs = diagnosticsTimeoutMs;
  await profileAsyncSpan(
    'rust.semantic.worker.diagnostics',
    () =>
      readiness
        ? waitForRustAnalyzerDiagnosticsWithinDeadline(
            (timeoutMs) => {
              effectiveDiagnosticsTimeoutMs = timeoutMs;
              return waitForOpenedDocuments(session.client, openedUris, timeoutMs);
            },
            diagnosticsTimeoutMs,
            readiness.deadlineMs,
          )
        : waitForOpenedDocuments(session.client, openedUris, diagnosticsTimeoutMs),
    () => ({
      openedDocuments: openedUris.length,
      timeoutMs: effectiveDiagnosticsTimeoutMs,
    }),
  );
  const settleDelayMs = request.settleDelayMs ?? 5_000;
  if (!readiness) {
    await profileAsyncSpan(
      'rust.semantic.worker.settle',
      () => sleep(settleDelayMs),
      () => ({
        openedDocuments: openedUris.length,
        settleDelayMs,
      }),
    );
  } else {
    let readinessHealth: string | undefined;
    await profileAsyncSpan(
      'rust.semantic.worker.readiness',
      async () => {
        const settle = (delayMs: number): Promise<void> =>
          profileAsyncSpan(
            'rust.semantic.worker.settle',
            () => sleep(delayMs),
            () => ({ openedDocuments: openedUris.length, settleDelayMs: delayMs }),
          );
        const status =
          readiness.initializationGeneration === undefined
            ? await waitForRustAnalyzerPostOpenReadiness(
                session.client,
                readiness.statusSnapshot,
                openedUris.length,
                readiness.deadlineMs,
                settleDelayMs,
                Date.now,
                settle,
              )
            : await waitForRustAnalyzerInitialPostOpenReadiness(
                session.client,
                readiness.initializationGeneration,
                openedUris.length,
                readiness.deadlineMs,
                settleDelayMs,
                Date.now,
                settle,
              );
        if (readiness.initializationGeneration !== undefined) session.initializationReadiness = null;
        readinessHealth = status?.health;
      },
      () => ({
        phase: readiness.initializationGeneration === undefined ? 'didOpen' : 'initialize+didOpen',
        openedDocuments: openedUris.length,
        health: readinessHealth,
      }),
    );
  }
  return openedUris.length;
}

async function openNewSourceDocuments(
  session: RustAnalyzerSessionState,
  projectRoot: string,
  files: readonly string[],
  opts: { diagnosticsTimeoutMs?: number; settleDelayMs?: number; readinessDeadlineMs?: number },
): Promise<number> {
  const filesToOpen = files.filter((file) => {
    if (session.openedPaths.has(file)) return false;
    return existsSync(resolve(projectRoot, file));
  });
  if (filesToOpen.length === 0) {
    await waitForRustAnalyzerInitialReadinessWithoutDocuments(session);
    return 0;
  }

  const initializationReadiness = session.initializationReadiness;
  const readiness =
    opts.readinessDeadlineMs === undefined
      ? null
      : {
          statusSnapshot: initializationReadiness ? null : session.client.serverStatusSnapshot(),
          initializationGeneration: initializationReadiness?.afterGeneration,
          deadlineMs: opts.readinessDeadlineMs,
        };
  const uris: string[] = [];
  for (const file of filesToOpen) {
    const uri = filePathToDocumentUri(projectRoot, file);
    session.client.didOpenTextDocument({
      uri,
      languageId: 'rust',
      version: 1,
      text: readFileSync(resolve(projectRoot, file), 'utf8'),
    });
    session.openedPaths.add(file);
    uris.push(uri);
  }
  const diagnosticsTimeoutMs = opts.diagnosticsTimeoutMs ?? 10_000;
  let effectiveDiagnosticsTimeoutMs = diagnosticsTimeoutMs;
  await profileAsyncSpan(
    'rust.semantic.worker.diagnostics',
    () =>
      readiness
        ? waitForRustAnalyzerDiagnosticsWithinDeadline(
            (timeoutMs) => {
              effectiveDiagnosticsTimeoutMs = timeoutMs;
              return waitForOpenedDocuments(session.client, uris, timeoutMs);
            },
            diagnosticsTimeoutMs,
            readiness.deadlineMs,
          )
        : waitForOpenedDocuments(session.client, uris, diagnosticsTimeoutMs),
    () => ({
      openedDocuments: uris.length,
      timeoutMs: effectiveDiagnosticsTimeoutMs,
    }),
  );
  const settleDelayMs = opts.settleDelayMs ?? 5_000;
  if (!readiness) {
    await profileAsyncSpan(
      'rust.semantic.worker.settle',
      () => sleep(settleDelayMs),
      () => ({
        openedDocuments: uris.length,
        settleDelayMs,
      }),
    );
  } else {
    let readinessHealth: string | undefined;
    await profileAsyncSpan(
      'rust.semantic.worker.readiness',
      async () => {
        const settle = (delayMs: number): Promise<void> =>
          profileAsyncSpan(
            'rust.semantic.worker.settle',
            () => sleep(delayMs),
            () => ({ openedDocuments: uris.length, settleDelayMs: delayMs }),
          );
        const status =
          readiness.initializationGeneration === undefined
            ? await waitForRustAnalyzerPostOpenReadiness(
                session.client,
                readiness.statusSnapshot,
                uris.length,
                readiness.deadlineMs,
                settleDelayMs,
                Date.now,
                settle,
              )
            : await waitForRustAnalyzerInitialPostOpenReadiness(
                session.client,
                readiness.initializationGeneration,
                uris.length,
                readiness.deadlineMs,
                settleDelayMs,
                Date.now,
                settle,
              );
        if (readiness.initializationGeneration !== undefined) session.initializationReadiness = null;
        readinessHealth = status?.health;
      },
      () => ({
        phase: readiness.initializationGeneration === undefined ? 'didOpen' : 'initialize+didOpen',
        openedDocuments: uris.length,
        health: readinessHealth,
      }),
    );
  }
  return uris.length;
}

async function waitForRustAnalyzerInitialReadinessWithoutDocuments(session: RustAnalyzerSessionState): Promise<void> {
  const readiness = session.initializationReadiness;
  if (!readiness) return;
  let readinessHealth: string | undefined;
  await profileAsyncSpan(
    'rust.semantic.worker.readiness',
    async () => {
      const status = await waitForRustAnalyzerInitialPostOpenReadiness(
        session.client,
        readiness.afterGeneration,
        0,
        readiness.deadlineMs,
        0,
      );
      readinessHealth = status.health;
      session.initializationReadiness = null;
    },
    () => ({ phase: 'initialize', openedDocuments: 0, health: readinessHealth }),
  );
}

function firstProjectLocalDefinitionPath(
  projectRoot: string,
  definitions: Awaited<ReturnType<RustAnalyzerLspClient['definition']>>,
): string | null {
  for (const definition of definitions) {
    const relativePath = documentUriToRelativePath(projectRoot, definition.uri);
    if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) continue;
    return relativePath;
  }
  return null;
}

function unavailableCapabilityReason(
  capabilities: LspInitializeResult['capabilities'],
  required: { references: boolean; callees: boolean; signatures: boolean },
): string | null {
  if (required.references && !capabilities.referencesProvider) {
    return 'rust-analyzer initialized without textDocument/references support.';
  }
  if (required.callees && !capabilities.callHierarchyProvider) {
    return 'rust-analyzer initialized without call hierarchy support.';
  }
  if (required.signatures && !capabilities.hoverProvider) {
    return 'rust-analyzer initialized without hover support.';
  }
  return null;
}

function emptyResponse(request: RustReferenceWorkerRequest, reason: string): RustReferenceWorkerResponse {
  const referenceDefinitions = rustRequestReferenceDefinitions(request);
  const calleeDefinitions = rustRequestCalleeDefinitions(request);
  const signatureDefinitions = rustRequestSignatureDefinitions(request);
  return {
    available: false,
    reason,
    references: referenceDefinitions.map((definition) => [definition.symbolId, []]),
    ...(request.includeCallees ? { callees: calleeDefinitions.map((definition) => [definition.symbolId, []]) } : {}),
    ...(request.includeSignatures
      ? { signatures: signatureDefinitions.map((definition) => [definition.symbolId, null]) }
      : {}),
  };
}

async function shutdownSessions(): Promise<void> {
  const current = [...sessions.values()];
  sessions.clear();
  await Promise.all(current.map((session) => session.client.shutdown().catch(() => undefined)));
}

export async function discardRustAnalyzerSession(
  registry: Map<string, RustAnalyzerSessionState>,
  session: RustAnalyzerSessionState,
  readinessDeadlineMs: number | undefined,
): Promise<void> {
  if (registry.get(session.key) === session) registry.delete(session.key);
  await session.client.shutdown({ deadlineMs: readinessDeadlineMs }).catch(() => undefined);
}

function sessionKey(binary: string, sessionRoot: string, linkedProjects: readonly string[]): string {
  return JSON.stringify({ binary, sessionRoot, linkedProjects });
}

function recordRustReferenceFileProfile(
  profiles: Map<string, RustReferenceFileProfile> | null,
  relativePath: string,
  result: { durationMs: number; references: number; hasReferences: boolean; slow: boolean },
): void {
  if (!profiles) return;
  const profile = rustReferenceFileProfile(profiles, relativePath);
  profile.definitions += 1;
  if (result.hasReferences) profile.definitionsWithReferences += 1;
  profile.references += result.references;
  profile.durationMs += result.durationMs;
  profile.maxDurationMs = Math.max(profile.maxDurationMs, result.durationMs);
  if (result.slow) profile.slowTasks += 1;
}

function writeRustReferenceFileProfileEvents(profiles: Map<string, RustReferenceFileProfile> | null): void {
  if (!profiles) return;
  const entries = [...profiles.entries()].sort(
    ([leftPath, left], [rightPath, right]) => right.durationMs - left.durationMs || leftPath.localeCompare(rightPath),
  );
  for (const [relativePath, profile] of entries) {
    writeProfileEvent({
      type: 'span',
      name: 'rust.semantic.worker.references.by-file',
      durationMs: profile.durationMs,
      ok: true,
      relativePath,
      definitions: profile.definitions,
      definitionsWithReferences: profile.definitionsWithReferences,
      references: profile.references,
      maxDurationMs: profile.maxDurationMs,
      slowTasks: profile.slowTasks,
      aggregate: 'sum-task-duration',
    });
  }
}

function rustReferenceFileProfile(
  profiles: Map<string, RustReferenceFileProfile>,
  relativePath: string,
): RustReferenceFileProfile {
  const existing = profiles.get(relativePath);
  if (existing) return existing;
  const created: RustReferenceFileProfile = {
    definitions: 0,
    definitionsWithReferences: 0,
    references: 0,
    durationMs: 0,
    maxDurationMs: 0,
    slowTasks: 0,
  };
  profiles.set(relativePath, created);
  return created;
}

function recordRustCalleeFileProfile(
  profiles: Map<string, RustCalleeFileProfile> | null,
  relativePath: string,
  result: { durationMs: number; callees: number; hasCallees: boolean; slow: boolean },
): void {
  if (!profiles) return;
  const profile = rustCalleeFileProfile(profiles, relativePath);
  profile.definitions += 1;
  if (result.hasCallees) profile.definitionsWithCallees += 1;
  profile.callees += result.callees;
  profile.durationMs += result.durationMs;
  profile.maxDurationMs = Math.max(profile.maxDurationMs, result.durationMs);
  if (result.slow) profile.slowTasks += 1;
}

function writeRustCalleeFileProfileEvents(profiles: Map<string, RustCalleeFileProfile> | null): void {
  if (!profiles) return;
  const entries = [...profiles.entries()].sort(
    ([leftPath, left], [rightPath, right]) => right.durationMs - left.durationMs || leftPath.localeCompare(rightPath),
  );
  for (const [relativePath, profile] of entries) {
    writeProfileEvent({
      type: 'span',
      name: 'rust.semantic.worker.callees.by-file',
      durationMs: profile.durationMs,
      ok: true,
      relativePath,
      definitions: profile.definitions,
      definitionsWithCallees: profile.definitionsWithCallees,
      callees: profile.callees,
      maxDurationMs: profile.maxDurationMs,
      slowTasks: profile.slowTasks,
      aggregate: 'sum-task-duration',
    });
  }
}

function rustCalleeFileProfile(
  profiles: Map<string, RustCalleeFileProfile>,
  relativePath: string,
): RustCalleeFileProfile {
  const existing = profiles.get(relativePath);
  if (existing) return existing;
  const created: RustCalleeFileProfile = {
    definitions: 0,
    definitionsWithCallees: 0,
    callees: 0,
    durationMs: 0,
    maxDurationMs: 0,
    slowTasks: 0,
  };
  profiles.set(relativePath, created);
  return created;
}

function optionalNonNegativeInteger(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parallelRustSemanticOperationsEnabled(): boolean {
  const configured = process.env['SCIP_RUST_SEMANTIC_PARALLEL_OPERATIONS'];
  return configured !== '0' && configured !== 'false';
}

function writeWorkerResponse(responsePath: string, payload: unknown, sharedBuffer: SharedArrayBuffer): void {
  writeFileSync(responsePath, JSON.stringify(payload));
  const signal = new Int32Array(sharedBuffer);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}
