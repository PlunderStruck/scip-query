import process from 'node:process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parentPort } from 'node:worker_threads';
import type { SemanticCallee, SemanticReference } from '../types.js';
import { createRustAnalyzerTransport, RustAnalyzerLspClient } from './lsp-client.js';
import type { LspInitializeResult } from './lsp-types.js';
import type { RustImportDefinitionWorkerRequest, RustImportDefinitionWorkerResponse } from './lsp-session.js';
import {
  calleesForDefinition,
  cargoManifestsForDefinitions,
  referencesWithRetry,
  runWithConcurrency,
  rustAnalyzerInitializationOptions,
  rustAnalyzerSessionRoot,
  signatureForDefinition,
  sleep,
  openDefinitionDocuments,
  waitForOpenedDocuments,
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
  client: RustAnalyzerLspClient;
  capabilities: LspInitializeResult['capabilities'];
  openedPaths: Set<string>;
}

interface ReferenceTaskResult {
  symbolId: number;
  references: SemanticReference[];
}

interface CalleeTaskResult {
  symbolId: number;
  callees: SemanticCallee[];
}

interface SignatureTaskResult {
  symbolId: number;
  signature: string | null;
}

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
    const response: RustReferenceWorkerResponse = {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      references: message.request.definitions.map((definition) => [definition.symbolId, []]),
      ...(message.request.includeCallees
        ? { callees: message.request.definitions.map((definition) => [definition.symbolId, []]) }
        : {}),
      ...(message.request.includeSignatures
        ? { signatures: message.request.definitions.map((definition) => [definition.symbolId, null]) }
        : {}),
    };
    writeWorkerResponse(message.responsePath, { ok: true, response }, message.sharedBuffer);
  }
}

async function runImportDefinitionRequest(
  request: RustImportDefinitionWorkerRequest,
): Promise<RustImportDefinitionWorkerResponse> {
  const session = await sessionForPaths(request.projectRoot, request.rustAnalyzerBinary, [request.file], {
    requestTimeoutMs: request.requestTimeoutMs,
  });
  if (!session.capabilities.definitionProvider) {
    return {
      available: false,
      reason: 'rust-analyzer initialized without textDocument/definition support.',
      sourcePaths: request.positions.map((position) => [position.id, null]),
    };
  }

  await openNewSourceDocuments(session, request.projectRoot, [request.file], {
    diagnosticsTimeoutMs: request.diagnosticsTimeoutMs,
    settleDelayMs: request.settleDelayMs,
  });

  const sourcePaths = await runWithConcurrency(request.positions, request.concurrency ?? 8, async (position) => {
    const definitions = await session.client.definition({
      textDocument: { uri: filePathToDocumentUri(request.projectRoot, position.file) },
      position: { line: position.line, character: position.column },
    });
    return [position.id, firstProjectLocalDefinitionPath(request.projectRoot, definitions)] as [string, string | null];
  });

  return {
    available: true,
    sourcePaths,
  };
}

async function runSessionRequest(request: RustReferenceWorkerRequest): Promise<RustReferenceWorkerResponse> {
  const includeReferences = request.includeReferences !== false;
  const includeCallees = request.includeCallees === true;
  const includeSignatures = request.includeSignatures === true;
  const session = await sessionFor(request);

  const unavailableReason = unavailableCapabilityReason(session.capabilities, {
    references: includeReferences,
    callees: includeCallees,
    signatures: includeSignatures,
  });
  if (unavailableReason) return emptyResponse(request, unavailableReason);

  await openNewDefinitionDocuments(session, request);

  const references = includeReferences
    ? await runWithConcurrency(
        request.definitions,
        request.concurrency ?? 8,
        async (definition): Promise<ReferenceTaskResult> => {
          const locations = await referencesWithRetry(
            session.client,
            definitionToReferenceParams(request.projectRoot, definition, false),
          );
          return {
            symbolId: definition.symbolId,
            references: dedupeSemanticReferences(locationsToSemanticReferences(request.projectRoot, locations)),
          };
        },
      )
    : request.definitions.map((definition) => ({ symbolId: definition.symbolId, references: [] }));

  const callees = includeCallees
    ? await runWithConcurrency(
        request.definitions,
        request.concurrency ?? 8,
        async (definition): Promise<CalleeTaskResult> => ({
          symbolId: definition.symbolId,
          callees: await calleesForDefinition(session.client, request.projectRoot, definition),
        }),
      )
    : [];

  const signatures = includeSignatures
    ? await runWithConcurrency(
        request.definitions,
        request.concurrency ?? 8,
        async (definition): Promise<SignatureTaskResult> => ({
          symbolId: definition.symbolId,
          signature: await signatureForDefinition(session.client, request.projectRoot, definition),
        }),
      )
    : [];

  return {
    available: true,
    references: references.map((result) => [result.symbolId, result.references]),
    ...(includeCallees ? { callees: callees.map((result) => [result.symbolId, result.callees]) } : {}),
    ...(includeSignatures ? { signatures: signatures.map((result) => [result.symbolId, result.signature]) } : {}),
  };
}

async function sessionFor(request: RustReferenceWorkerRequest): Promise<RustAnalyzerSessionState> {
  return sessionForPaths(
    request.projectRoot,
    request.rustAnalyzerBinary,
    request.definitions.map((definition) => definition.relativePath),
    { requestTimeoutMs: request.requestTimeoutMs },
  );
}

async function sessionForPaths(
  projectRoot: string,
  rustAnalyzerBinary: string,
  relativePaths: readonly string[],
  opts: { requestTimeoutMs?: number },
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
  const initialized = await client.initialize({
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
  });
  const session: RustAnalyzerSessionState = {
    client,
    capabilities: initialized.capabilities,
    openedPaths: new Set(),
  };
  sessions.set(key, session);
  return session;
}

async function openNewDefinitionDocuments(
  session: RustAnalyzerSessionState,
  request: RustReferenceWorkerRequest,
): Promise<void> {
  const definitionsToOpen = request.definitions.filter((definition) => {
    if (session.openedPaths.has(definition.relativePath)) return false;
    return existsSync(resolve(request.projectRoot, definition.relativePath));
  });
  if (definitionsToOpen.length === 0) return;

  const openedUris = openDefinitionDocuments(session.client, request.projectRoot, definitionsToOpen);
  for (const definition of definitionsToOpen) {
    session.openedPaths.add(definition.relativePath);
  }
  await waitForOpenedDocuments(session.client, openedUris, request.diagnosticsTimeoutMs ?? 10_000);
  await sleep(request.settleDelayMs ?? 5_000);
}

async function openNewSourceDocuments(
  session: RustAnalyzerSessionState,
  projectRoot: string,
  files: readonly string[],
  opts: { diagnosticsTimeoutMs?: number; settleDelayMs?: number },
): Promise<void> {
  const filesToOpen = files.filter((file) => {
    if (session.openedPaths.has(file)) return false;
    return existsSync(resolve(projectRoot, file));
  });
  if (filesToOpen.length === 0) return;

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
  await waitForOpenedDocuments(session.client, uris, opts.diagnosticsTimeoutMs ?? 10_000);
  await sleep(opts.settleDelayMs ?? 5_000);
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
  return {
    available: false,
    reason,
    references: request.definitions.map((definition) => [definition.symbolId, []]),
    ...(request.includeCallees ? { callees: request.definitions.map((definition) => [definition.symbolId, []]) } : {}),
    ...(request.includeSignatures
      ? { signatures: request.definitions.map((definition) => [definition.symbolId, null]) }
      : {}),
  };
}

async function shutdownSessions(): Promise<void> {
  const current = [...sessions.values()];
  sessions.clear();
  await Promise.all(current.map((session) => session.client.shutdown().catch(() => undefined)));
}

function sessionKey(binary: string, sessionRoot: string, linkedProjects: readonly string[]): string {
  return JSON.stringify({ binary, sessionRoot, linkedProjects });
}

function writeWorkerResponse(responsePath: string, payload: unknown, sharedBuffer: SharedArrayBuffer): void {
  writeFileSync(responsePath, JSON.stringify(payload));
  const signal = new Int32Array(sharedBuffer);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}
