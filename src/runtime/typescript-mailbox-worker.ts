import { parentPort, workerData } from 'node:worker_threads';
import { applyProfileEnvironment, captureProfileEnvironment } from '../instrumentation/profile.js';
import {
  publishedTypeScriptIndexGeneration,
  type TypeScriptIndexEnvelope,
} from '../reindex/typescript-index-protocol.js';
import { TypeScriptIndexServiceHost } from '../reindex/typescript-index-service.js';
import type {
  TypeScriptIndexDocumentResponse,
  TypeScriptIndexServiceStatus,
} from '../reindex/typescript-index-protocol.js';
import { openProjectDb } from './cli-context.js';
import type { WorkerLaneResponse } from './worker-request-lane.js';
import type {
  TypeScriptSemanticMailboxEnvelope,
  TypeScriptSemanticServiceStatus,
} from '../semantic/typescript/session-protocol.js';
import { TypeScriptSemanticServiceHost } from '../semantic/typescript/session-service.js';

type TypeScriptMailboxWorkerData =
  | {
      kind: 'index';
      projectRoot: string;
      dbPath: string;
      maxActiveSessions?: number;
      softMemoryLimitMb?: number;
    }
  | { kind: 'semantic'; projectRoot: string };

type TypeScriptMailboxWorkerRequest =
  | { kind: 'request'; requestId: string; deadlineAtMs: number; payload: TypeScriptIndexEnvelope }
  | { kind: 'request'; requestId: string; deadlineAtMs: number; payload: TypeScriptSemanticMailboxEnvelope };

const data = parseWorkerData(workerData);
if (!parentPort) throw new Error('TypeScript mailbox worker requires a parent port.');

if (data.kind === 'index') {
  const host = new TypeScriptIndexServiceHost({
    projectRoot: data.projectRoot,
    currentGeneration: () => publishedTypeScriptIndexGeneration(data.dbPath),
    ...(data.maxActiveSessions === undefined ? {} : { maxActiveSessions: data.maxActiveSessions }),
    ...(data.softMemoryLimitMb === undefined ? {} : { softMemoryLimitMb: data.softMemoryLimitMb }),
  });
  parentPort.on('message', (value: unknown) => {
    const message = parseWorkerRequest<TypeScriptIndexEnvelope>(value);
    runAndRespond<TypeScriptIndexDocumentResponse, TypeScriptIndexServiceStatus>(
      message,
      () => host.handle(message.payload.baseGeneration, message.payload.request),
      () => host.status(),
    );
  });
} else {
  const host = new TypeScriptSemanticServiceHost({ openDb: () => openProjectDb(data.projectRoot) });
  parentPort.on('message', (value: unknown) => {
    const message = parseWorkerRequest<TypeScriptSemanticMailboxEnvelope>(value);
    const previousProfileEnvironment = captureProfileEnvironment();
    applyProfileEnvironment(message.payload.profileEnvironment ?? {});
    try {
      runAndRespond<unknown, TypeScriptSemanticServiceStatus>(
        message,
        () => host.handle(message.payload.generation, message.payload.request),
        () => host.status(),
      );
    } finally {
      applyProfileEnvironment(previousProfileEnvironment);
    }
  });
}

function runAndRespond<Result, Status>(
  message: { requestId: string; deadlineAtMs: number },
  action: () => Result,
  status: () => Status,
): void {
  let response: WorkerLaneResponse<Result, Status>;
  try {
    if (Date.now() > message.deadlineAtMs) throw new Error('TypeScript mailbox request expired before processing.');
    const result = action();
    if (Date.now() > message.deadlineAtMs) {
      throw new Error('TypeScript mailbox request expired while the worker was processing it.');
    }
    response = { kind: 'response', requestId: message.requestId, ok: true, result, status: status() };
  } catch (error) {
    response = {
      kind: 'response',
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      status: status(),
    };
  }
  parentPort!.postMessage(response);
}

function parseWorkerData(value: unknown): TypeScriptMailboxWorkerData {
  if (!value || typeof value !== 'object') throw new Error('TypeScript mailbox worker data is missing.');
  const data = value as Partial<TypeScriptMailboxWorkerData>;
  if (
    data.kind === 'index' &&
    typeof data.projectRoot === 'string' &&
    typeof data.dbPath === 'string' &&
    optionalPositiveInteger(data.maxActiveSessions) &&
    optionalPositiveInteger(data.softMemoryLimitMb)
  ) {
    return {
      kind: 'index',
      projectRoot: data.projectRoot,
      dbPath: data.dbPath,
      ...(data.maxActiveSessions === undefined ? {} : { maxActiveSessions: data.maxActiveSessions }),
      ...(data.softMemoryLimitMb === undefined ? {} : { softMemoryLimitMb: data.softMemoryLimitMb }),
    };
  }
  if (data.kind === 'semantic' && typeof data.projectRoot === 'string') {
    return { kind: 'semantic', projectRoot: data.projectRoot };
  }
  throw new Error('TypeScript mailbox worker data is invalid.');
}

function optionalPositiveInteger(value: unknown): value is number | undefined {
  return value === undefined || (Number.isInteger(value) && (value as number) > 0);
}

function parseWorkerRequest<Payload>(value: unknown): {
  kind: 'request';
  requestId: string;
  deadlineAtMs: number;
  payload: Payload;
} {
  if (!value || typeof value !== 'object') throw new Error('TypeScript mailbox worker request is missing.');
  const request = value as Partial<TypeScriptMailboxWorkerRequest>;
  if (
    request.kind !== 'request' ||
    typeof request.requestId !== 'string' ||
    !Number.isSafeInteger(request.deadlineAtMs) ||
    typeof request.payload !== 'object' ||
    request.payload === null
  ) {
    throw new Error('TypeScript mailbox worker request is invalid.');
  }
  return request as {
    kind: 'request';
    requestId: string;
    deadlineAtMs: number;
    payload: Payload;
  };
}
