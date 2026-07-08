import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IndexedDefinition } from '../../domain/types.js';
import type { SemanticCallee, SemanticReference } from '../types.js';
import { createRustAnalyzerTransport, RustAnalyzerLspClient } from './lsp-client.js';
import type { LspCallHierarchyItem, LspCallHierarchyOutgoingCall, LspHover, LspMarkedString } from './lsp-types.js';
import {
  dedupeSemanticReferences,
  definitionToReferenceParams,
  documentUriToRelativePath,
  filePathToDocumentUri,
  locationsToSemanticReferences,
} from './reference-mapping.js';

// scip-query: ignore-stale — subprocess handoff payload from the synchronous
// provider bridge to the async rust-analyzer LSP batch worker.
export interface RustReferenceWorkerRequest {
  projectRoot: string;
  rustAnalyzerBinary: string;
  definitions: IndexedDefinition[];
  requestTimeoutMs?: number;
  diagnosticsTimeoutMs?: number;
  settleDelayMs?: number;
  concurrency?: number;
  includeReferences?: boolean;
  includeCallees?: boolean;
  includeSignatures?: boolean;
}

// scip-query: ignore-stale — subprocess response payload consumed by the
// synchronous Rust semantic provider bridge.
export interface RustReferenceWorkerResponse {
  available: boolean;
  reason?: string;
  references: Array<[number, SemanticReference[]]>;
  callees?: Array<[number, SemanticCallee[]]>;
  signatures?: Array<[number, string | null]>;
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

export async function runRustAnalyzerReferenceBatch(
  request: RustReferenceWorkerRequest,
): Promise<RustReferenceWorkerResponse> {
  const includeReferences = request.includeReferences !== false;
  const includeCallees = request.includeCallees === true;
  const includeSignatures = request.includeSignatures === true;
  const linkedProjects = cargoManifestsForDefinitions(request.projectRoot, request.definitions);
  const sessionRoot = rustAnalyzerSessionRoot(request.projectRoot, linkedProjects);
  const initializationOptions = rustAnalyzerInitializationOptions(linkedProjects);
  const client = new RustAnalyzerLspClient(createRustAnalyzerTransport(request.rustAnalyzerBinary, sessionRoot), {
    requestTimeoutMs: request.requestTimeoutMs,
    configuration: initializationOptions,
  });
  try {
    const initialized = await client.initialize({
      processId: process.pid,
      rootUri: filePathToDocumentUri(sessionRoot, '.'),
      capabilities: {
        textDocument: {
          references: {
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
    if (includeReferences && !initialized.capabilities.referencesProvider) {
      return {
        available: false,
        reason: 'rust-analyzer initialized without textDocument/references support.',
        references: request.definitions.map((definition) => [definition.symbolId, []]),
        ...(includeCallees ? { callees: request.definitions.map((definition) => [definition.symbolId, []]) } : {}),
      };
    }
    if (includeCallees && !initialized.capabilities.callHierarchyProvider) {
      return {
        available: false,
        reason: 'rust-analyzer initialized without call hierarchy support.',
        references: request.definitions.map((definition) => [definition.symbolId, []]),
        callees: request.definitions.map((definition) => [definition.symbolId, []]),
        ...(includeSignatures
          ? { signatures: request.definitions.map((definition) => [definition.symbolId, null]) }
          : {}),
      };
    }
    if (includeSignatures && !initialized.capabilities.hoverProvider) {
      return {
        available: false,
        reason: 'rust-analyzer initialized without hover support.',
        references: request.definitions.map((definition) => [definition.symbolId, []]),
        ...(includeCallees ? { callees: request.definitions.map((definition) => [definition.symbolId, []]) } : {}),
        signatures: request.definitions.map((definition) => [definition.symbolId, null]),
      };
    }

    const openedUris = openDefinitionDocuments(client, request.projectRoot, request.definitions);
    await waitForOpenedDocuments(client, openedUris, request.diagnosticsTimeoutMs ?? 10_000);
    await sleep(request.settleDelayMs ?? 5_000);

    const references = includeReferences
      ? await runWithConcurrency(
          request.definitions,
          request.concurrency ?? 8,
          async (definition): Promise<ReferenceTaskResult> => {
            const locations = await referencesWithRetry(
              client,
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
            callees: await calleesForDefinition(client, request.projectRoot, definition),
          }),
        )
      : [];
    const signatures = includeSignatures
      ? await runWithConcurrency(
          request.definitions,
          request.concurrency ?? 8,
          async (definition): Promise<SignatureTaskResult> => ({
            symbolId: definition.symbolId,
            signature: await signatureForDefinition(client, request.projectRoot, definition),
          }),
        )
      : [];

    return {
      available: true,
      references: references.map((result) => [result.symbolId, result.references]),
      ...(includeCallees ? { callees: callees.map((result) => [result.symbolId, result.callees]) } : {}),
      ...(includeSignatures ? { signatures: signatures.map((result) => [result.symbolId, result.signature]) } : {}),
    };
  } finally {
    await client.shutdown().catch(() => undefined);
  }
}

export async function signatureForDefinition(
  client: RustAnalyzerLspClient,
  projectRoot: string,
  definition: IndexedDefinition,
): Promise<string | null> {
  const referenceParams = definitionToReferenceParams(projectRoot, definition, false);
  const hover = await hoverWithRetry(client, {
    textDocument: referenceParams.textDocument,
    position: referenceParams.position,
  });
  return hoverToRustSignature(hover);
}

export async function hoverWithRetry(
  client: RustAnalyzerLspClient,
  params: Parameters<RustAnalyzerLspClient['hover']>[0],
): Promise<LspHover | null> {
  try {
    return await client.hover(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('content modified')) return null;
    await sleep(1_000);
    try {
      return await client.hover(params);
    } catch {
      return null;
    }
  }
}

export function hoverToRustSignature(hover: LspHover | null): string | null {
  if (!hover) return null;
  const text = hoverContentsToText(hover.contents);
  const fenced = /```(?:rust)?\s*([\s\S]*?)```/i.exec(text);
  const candidateText = fenced ? fenced[1]! : text;
  for (const rawLine of candidateText.split(/\r?\n/)) {
    const line = rawLine.replace(/^`+|`+$/g, '').trim();
    if (!line) continue;
    if (isRustSignatureLine(line)) return line;
  }
  return null;
}

function hoverContentsToText(contents: LspHover['contents']): string {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map(markedStringToText).join('\n');
  if ('value' in contents) return contents.value;
  return '';
}

function markedStringToText(value: LspMarkedString): string {
  return typeof value === 'string' ? value : value.value;
}

function isRustSignatureLine(line: string): boolean {
  return /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]+"\s+)?)?(?:fn|struct|enum|trait|type|const|static|mod)\b/.test(
    line,
  );
}

export function rustAnalyzerInitializationOptions(linkedProjects: readonly string[]): Record<string, unknown> {
  return {
    ...(linkedProjects.length > 0 ? { linkedProjects } : {}),
    references: {
      excludeImports: false,
      excludeTests: false,
    },
  };
}

export function rustAnalyzerSessionRoot(projectRoot: string, linkedProjects: readonly string[]): string {
  return linkedProjects.length === 1 ? dirname(linkedProjects[0]!) : resolve(projectRoot);
}

export function cargoManifestsForDefinitions(
  projectRoot: string,
  definitions: readonly Pick<IndexedDefinition, 'relativePath'>[],
): string[] {
  const root = resolve(projectRoot);
  const manifests: string[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    let current = dirname(resolve(root, definition.relativePath));
    while (isInsideOrEqual(root, current)) {
      const manifest = join(current, 'Cargo.toml');
      if (existsSync(manifest)) {
        if (!seen.has(manifest)) {
          seen.add(manifest);
          manifests.push(manifest);
        }
        break;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return manifests;
}

export function openDefinitionDocuments(
  client: RustAnalyzerLspClient,
  projectRoot: string,
  definitions: readonly IndexedDefinition[],
): string[] {
  const opened = new Set<string>();
  const uris: string[] = [];
  for (const definition of definitions) {
    if (opened.has(definition.relativePath)) continue;
    opened.add(definition.relativePath);
    const path = resolve(projectRoot, definition.relativePath);
    if (!existsSync(path)) continue;
    const uri = filePathToDocumentUri(projectRoot, definition.relativePath);
    client.didOpenTextDocument({
      uri,
      languageId: 'rust',
      version: 1,
      text: readFileSync(path, 'utf8'),
    });
    uris.push(uri);
  }
  return uris;
}

export async function waitForOpenedDocuments(
  client: RustAnalyzerLspClient,
  uris: readonly string[],
  timeoutMs: number,
): Promise<void> {
  await Promise.all(uris.map((uri) => client.waitForDiagnostics(uri, timeoutMs).catch(() => false)));
}

export async function referencesWithRetry(
  client: RustAnalyzerLspClient,
  params: Parameters<RustAnalyzerLspClient['references']>[0],
): Promise<Awaited<ReturnType<RustAnalyzerLspClient['references']>>> {
  try {
    return await client.references(params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('content modified')) return [];
    await sleep(1_000);
    try {
      return await client.references(params);
    } catch {
      return [];
    }
  }
}

export async function calleesForDefinition(
  client: RustAnalyzerLspClient,
  projectRoot: string,
  definition: IndexedDefinition,
): Promise<SemanticCallee[]> {
  const referenceParams = definitionToReferenceParams(projectRoot, definition, false);
  const items = await prepareCallHierarchyWithRetry(client, {
    textDocument: referenceParams.textDocument,
    position: referenceParams.position,
  });
  const calls = (await Promise.all(items.map((item) => outgoingCallsWithRetry(client, item).catch(() => [])))).flat();
  return dedupeSemanticCallees(outgoingCallsToSemanticCallees(projectRoot, calls));
}

async function prepareCallHierarchyWithRetry(
  client: RustAnalyzerLspClient,
  params: Parameters<RustAnalyzerLspClient['prepareCallHierarchy']>[0],
): Promise<LspCallHierarchyItem[]> {
  try {
    return await client.prepareCallHierarchy(params);
  } catch {
    return [];
  }
}

async function outgoingCallsWithRetry(
  client: RustAnalyzerLspClient,
  item: LspCallHierarchyItem,
): Promise<LspCallHierarchyOutgoingCall[]> {
  try {
    return await client.outgoingCalls(item);
  } catch {
    return [];
  }
}

function outgoingCallsToSemanticCallees(
  projectRoot: string,
  calls: readonly LspCallHierarchyOutgoingCall[],
): SemanticCallee[] {
  return calls.map((call) => ({
    symbol: call.to.name,
    file: documentUriToRelativePath(projectRoot, call.to.uri),
    line: call.to.selectionRange.start.line,
  }));
}

function dedupeSemanticCallees(callees: readonly SemanticCallee[]): SemanticCallee[] {
  const seen = new Set<string>();
  const out: SemanticCallee[] = [];
  for (const callee of callees) {
    const key = `${callee.symbol}\0${callee.file}\0${callee.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(callee);
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.symbol.localeCompare(b.symbol));
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(items.length, Math.floor(concurrency)));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function main(): Promise<void> {
  try {
    const request = JSON.parse(await readStdin()) as RustReferenceWorkerRequest;
    const response = await runRustAnalyzerReferenceBatch(request);
    process.stdout.write(JSON.stringify(response));
  } catch (error) {
    const response: RustReferenceWorkerResponse = {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      references: [],
    };
    process.stdout.write(JSON.stringify(response));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
