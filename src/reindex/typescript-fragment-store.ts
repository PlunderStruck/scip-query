import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../storage/atomic-json.js';
import type { TypeScriptDocumentFragment, TypeScriptDocumentRuntime } from './typescript-document-emitter.js';

export const TYPESCRIPT_FRAGMENT_STORE_VERSION = 1;
const FRAGMENT_STORE_DIRECTORY = 'typescript-scip-fragments';

export interface TypeScriptFragmentRecord {
  relativePath: string;
  blobHash: string;
  byteLength: number;
  documentIdentity: string;
}

export interface TypeScriptFragmentGenerationManifest {
  version: typeof TYPESCRIPT_FRAGMENT_STORE_VERSION;
  producerIdentity: string;
  projectIdentity: string;
  generationIdentity: string;
  createdAt: string;
  documents: TypeScriptFragmentRecord[];
}

export interface TypeScriptFragmentStorePaths {
  rootDir: string;
  blobDir: string;
  generationDir: string;
}

export interface SeedTypeScriptFragmentGenerationInput {
  cacheDir: string;
  runtime: TypeScriptDocumentRuntime;
  indexBytes: Uint8Array;
  producerIdentity: string;
  projectIdentity: string;
  generationIdentity: string;
  documentIdentities: ReadonlyMap<string, string>;
  now?: () => Date;
}

export interface CommitTypeScriptFragmentGenerationInput {
  cacheDir: string;
  previousGenerationIdentity: string;
  producerIdentity: string;
  projectIdentity: string;
  generationIdentity: string;
  fragments: readonly TypeScriptDocumentFragment[];
  documentIdentities: ReadonlyMap<string, string>;
  now?: () => Date;
}

export interface ReadTypeScriptFragmentGenerationInput {
  cacheDir: string;
  generationIdentity: string;
  producerIdentity?: string;
  projectIdentity?: string;
}

export interface LoadedTypeScriptFragmentGeneration {
  manifest: TypeScriptFragmentGenerationManifest;
  fragments: Map<string, Uint8Array>;
}

export interface AssembleTypeScriptIndexInput {
  runtime: TypeScriptDocumentRuntime;
  baseIndexBytes: Uint8Array;
  fragments: readonly TypeScriptDocumentFragment[];
}

export function typeScriptFragmentStorePaths(cacheDir: string): TypeScriptFragmentStorePaths {
  const rootDir = join(cacheDir, FRAGMENT_STORE_DIRECTORY);
  return {
    rootDir,
    blobDir: join(rootDir, 'blobs'),
    generationDir: join(rootDir, 'generations'),
  };
}

export function seedTypeScriptFragmentGeneration(
  input: SeedTypeScriptFragmentGenerationInput,
): TypeScriptFragmentGenerationManifest {
  const index = input.runtime.Index.deserializeBinary(input.indexBytes);
  assertProducerMetadata(index.metadata, input.runtime.packageVersion);
  assertNoExternalSymbols(index.external_symbols);
  const seen = new Set<string>();
  const documents: TypeScriptFragmentRecord[] = [];
  for (const document of index.documents) {
    const relativePath = validateRelativePath(document.relative_path);
    if (seen.has(relativePath)) throw new Error(`duplicate TypeScript SCIP document path: ${relativePath}`);
    seen.add(relativePath);
    const documentIdentity = input.documentIdentities.get(relativePath);
    if (!documentIdentity) throw new Error(`missing TypeScript document identity: ${relativePath}`);
    documents.push(
      persistFragment(
        input.cacheDir,
        {
          relativePath,
          bytes: document.serializeBinary(),
          occurrences: document.occurrences.length,
          symbols: document.symbols.length,
        },
        documentIdentity,
      ),
    );
  }
  const manifest = createManifest(input, documents);
  persistManifest(input.cacheDir, manifest);
  return manifest;
}

export function commitTypeScriptFragmentGeneration(
  input: CommitTypeScriptFragmentGenerationInput,
): TypeScriptFragmentGenerationManifest {
  const previous = readTypeScriptFragmentGeneration({
    cacheDir: input.cacheDir,
    generationIdentity: input.previousGenerationIdentity,
    producerIdentity: input.producerIdentity,
    projectIdentity: input.projectIdentity,
  }).manifest;
  const records = new Map(previous.documents.map((document) => [document.relativePath, document]));
  const replacements = new Set<string>();
  for (const fragment of input.fragments) {
    const relativePath = validateRelativePath(fragment.relativePath);
    if (replacements.has(relativePath)) throw new Error(`duplicate TypeScript fragment replacement: ${relativePath}`);
    replacements.add(relativePath);
    if (!records.has(relativePath))
      throw new Error(`TypeScript fragment replacement has no prior document: ${relativePath}`);
    const documentIdentity = input.documentIdentities.get(relativePath);
    if (!documentIdentity) throw new Error(`missing TypeScript document identity: ${relativePath}`);
    if (fragment.bytes === null) records.delete(relativePath);
    else records.set(relativePath, persistFragment(input.cacheDir, fragment, documentIdentity));
  }
  if (replacements.size === 0) throw new Error('TypeScript fragment generation requires at least one replacement');
  const manifest = createManifest(input, [...records.values()]);
  persistManifest(input.cacheDir, manifest);
  return manifest;
}

export function readTypeScriptFragmentGeneration(
  input: ReadTypeScriptFragmentGenerationInput,
): LoadedTypeScriptFragmentGeneration {
  const paths = typeScriptFragmentStorePaths(input.cacheDir);
  const manifestPath = generationManifestPath(paths, input.generationIdentity);
  let manifest: TypeScriptFragmentGenerationManifest;
  try {
    manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `TypeScript fragment generation is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (manifest.generationIdentity !== input.generationIdentity) {
    throw new Error('TypeScript fragment generation identity does not match its manifest path');
  }
  if (input.producerIdentity && manifest.producerIdentity !== input.producerIdentity) {
    throw new Error('TypeScript fragment producer identity changed');
  }
  if (input.projectIdentity && manifest.projectIdentity !== input.projectIdentity) {
    throw new Error('TypeScript fragment project identity changed');
  }

  const fragments = new Map<string, Uint8Array>();
  for (const record of manifest.documents) {
    const blobPath = join(paths.blobDir, `${record.blobHash}.scipdoc`);
    const bytes = readFileSync(blobPath);
    if (bytes.byteLength !== record.byteLength || sha256(bytes) !== record.blobHash) {
      throw new Error(`TypeScript fragment blob is corrupt: ${record.relativePath}`);
    }
    fragments.set(record.relativePath, bytes);
  }
  return { manifest, fragments };
}

export function assembleTypeScriptIndex(input: AssembleTypeScriptIndexInput): Uint8Array {
  const index = input.runtime.Index.deserializeBinary(input.baseIndexBytes);
  assertProducerMetadata(index.metadata, input.runtime.packageVersion);
  assertNoExternalSymbols(index.external_symbols);
  const replacements = new Map<string, TypeScriptDocumentFragment>();
  for (const fragment of input.fragments) {
    const relativePath = validateRelativePath(fragment.relativePath);
    if (replacements.has(relativePath)) throw new Error(`duplicate TypeScript fragment replacement: ${relativePath}`);
    replacements.set(relativePath, fragment);
  }
  if (replacements.size === 0) throw new Error('TypeScript index assembly requires at least one replacement');

  const seen = new Set<string>();
  const documents: typeof index.documents = [];
  for (const document of index.documents) {
    const relativePath = validateRelativePath(document.relative_path);
    if (seen.has(relativePath)) throw new Error(`duplicate TypeScript SCIP document path: ${relativePath}`);
    seen.add(relativePath);
    const replacement = replacements.get(relativePath);
    if (!replacement) {
      documents.push(document);
      continue;
    }
    replacements.delete(relativePath);
    if (replacement.bytes === null) continue;
    const nextDocument = input.runtime.Document.deserializeBinary(replacement.bytes);
    if (nextDocument.relative_path !== relativePath) {
      throw new Error(`TypeScript fragment path mismatch: expected ${relativePath}, got ${nextDocument.relative_path}`);
    }
    documents.push(nextDocument);
  }
  if (replacements.size > 0) {
    throw new Error(`TypeScript fragment replacement has no prior document: ${[...replacements.keys()].sort()[0]}`);
  }
  const assembled = new input.runtime.Index({
    metadata: index.metadata,
    documents,
    external_symbols: index.external_symbols,
  });
  const bytes = assembled.serializeBinary();
  const verified = input.runtime.Index.deserializeBinary(bytes);
  if (verified.documents.length !== documents.length || verified.external_symbols.length !== 0) {
    throw new Error('assembled TypeScript SCIP index failed structural verification');
  }
  return bytes;
}

export function pruneTypeScriptFragmentGenerations(
  cacheDir: string,
  keepGenerationIdentities: readonly string[],
): void {
  const paths = typeScriptFragmentStorePaths(cacheDir);
  if (!existsSync(paths.generationDir)) return;
  const keepFiles = new Set(keepGenerationIdentities.map((identity) => generationManifestFile(identity)));
  const generationFiles = readdirSync(paths.generationDir).filter((entry) => entry.endsWith('.json'));
  const referencedBlobs = new Set<string>();
  for (const file of generationFiles.filter((entry) => keepFiles.has(entry))) {
    const manifest = parseManifest(readFileSync(join(paths.generationDir, file), 'utf8'));
    for (const document of manifest.documents) referencedBlobs.add(`${document.blobHash}.scipdoc`);
  }
  for (const file of generationFiles) {
    if (!keepFiles.has(file)) rmSync(join(paths.generationDir, file), { force: true });
  }
  if (!existsSync(paths.blobDir)) return;
  for (const file of readdirSync(paths.blobDir)) {
    if (!referencedBlobs.has(file)) rmSync(join(paths.blobDir, file), { force: true });
  }
}

function persistFragment(
  cacheDir: string,
  fragment: TypeScriptDocumentFragment,
  documentIdentity: string,
): TypeScriptFragmentRecord {
  if (fragment.bytes === null) throw new Error(`cannot persist an empty TypeScript fragment: ${fragment.relativePath}`);
  const relativePath = validateRelativePath(fragment.relativePath);
  const bytes = Buffer.from(fragment.bytes);
  const blobHash = sha256(bytes);
  const paths = typeScriptFragmentStorePaths(cacheDir);
  mkdirSync(paths.blobDir, { recursive: true });
  const blobPath = join(paths.blobDir, `${blobHash}.scipdoc`);
  if (existsSync(blobPath)) {
    const existing = readFileSync(blobPath);
    if (existing.byteLength !== bytes.byteLength || sha256(existing) !== blobHash) {
      throw new Error(`existing TypeScript fragment blob is corrupt: ${relativePath}`);
    }
  } else {
    const temporaryPath = `${blobPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, bytes);
    renameSync(temporaryPath, blobPath);
  }
  return { relativePath, blobHash, byteLength: bytes.byteLength, documentIdentity };
}

function createManifest(
  input: {
    producerIdentity: string;
    projectIdentity: string;
    generationIdentity: string;
    now?: () => Date;
  },
  documents: readonly TypeScriptFragmentRecord[],
): TypeScriptFragmentGenerationManifest {
  if (!input.producerIdentity || !input.projectIdentity || !input.generationIdentity) {
    throw new Error('TypeScript fragment generation identities must be non-empty');
  }
  const sortedDocuments = [...documents].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (new Set(sortedDocuments.map((document) => document.relativePath)).size !== sortedDocuments.length) {
    throw new Error('TypeScript fragment generation contains duplicate document paths');
  }
  return {
    version: TYPESCRIPT_FRAGMENT_STORE_VERSION,
    producerIdentity: input.producerIdentity,
    projectIdentity: input.projectIdentity,
    generationIdentity: input.generationIdentity,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
    documents: sortedDocuments,
  };
}

function persistManifest(cacheDir: string, manifest: TypeScriptFragmentGenerationManifest): void {
  const paths = typeScriptFragmentStorePaths(cacheDir);
  const manifestPath = generationManifestPath(paths, manifest.generationIdentity);
  if (existsSync(manifestPath)) {
    const existing = parseManifest(readFileSync(manifestPath, 'utf8'));
    if (manifestContentIdentity(existing) !== manifestContentIdentity(manifest)) {
      throw new Error(`TypeScript fragment generation is immutable: ${manifest.generationIdentity}`);
    }
    return;
  }
  writeJsonAtomic(manifestPath, manifest, {
    spacing: 2,
    trailingNewline: true,
  });
}

function manifestContentIdentity(manifest: TypeScriptFragmentGenerationManifest): string {
  return sha256(
    JSON.stringify({
      version: manifest.version,
      producerIdentity: manifest.producerIdentity,
      projectIdentity: manifest.projectIdentity,
      generationIdentity: manifest.generationIdentity,
      documents: manifest.documents,
    }),
  );
}

function parseManifest(raw: string): TypeScriptFragmentGenerationManifest {
  const parsed = JSON.parse(raw) as Partial<TypeScriptFragmentGenerationManifest>;
  if (
    parsed.version !== TYPESCRIPT_FRAGMENT_STORE_VERSION ||
    typeof parsed.producerIdentity !== 'string' ||
    typeof parsed.projectIdentity !== 'string' ||
    typeof parsed.generationIdentity !== 'string' ||
    typeof parsed.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.createdAt)) ||
    !Array.isArray(parsed.documents)
  ) {
    throw new Error('invalid TypeScript fragment generation manifest');
  }
  const seen = new Set<string>();
  for (const document of parsed.documents) {
    if (
      !document ||
      typeof document.relativePath !== 'string' ||
      typeof document.blobHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(document.blobHash) ||
      typeof document.byteLength !== 'number' ||
      !Number.isInteger(document.byteLength) ||
      document.byteLength < 0 ||
      typeof document.documentIdentity !== 'string' ||
      !document.documentIdentity
    ) {
      throw new Error('invalid TypeScript fragment record');
    }
    validateRelativePath(document.relativePath);
    if (seen.has(document.relativePath)) throw new Error('duplicate TypeScript fragment record');
    seen.add(document.relativePath);
  }
  return parsed as TypeScriptFragmentGenerationManifest;
}

function generationManifestPath(paths: TypeScriptFragmentStorePaths, generationIdentity: string): string {
  return join(paths.generationDir, generationManifestFile(generationIdentity));
}

function generationManifestFile(generationIdentity: string): string {
  if (!generationIdentity) throw new Error('TypeScript fragment generation identity must be non-empty');
  return `${sha256(generationIdentity)}.json`;
}

function assertNoExternalSymbols(externalSymbols: readonly unknown[]): void {
  if (externalSymbols.length > 0) {
    throw new Error('scip-typescript emitted external symbols; incremental document assembly is unsupported');
  }
}

function assertProducerMetadata(metadata: unknown, packageVersion: string): void {
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('TypeScript SCIP shard has no producer metadata');
  }
  const tool = (metadata as { tool_info?: unknown }).tool_info;
  if (!tool || typeof tool !== 'object') {
    throw new Error('TypeScript SCIP shard has no producer tool identity');
  }
  const identity = tool as { name?: unknown; version?: unknown };
  if (identity.name !== 'scip-typescript' || identity.version !== packageVersion) {
    throw new Error('TypeScript SCIP shard producer identity changed');
  }
}

function validateRelativePath(value: string): string {
  if (!value || value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) {
    throw new Error(`invalid TypeScript SCIP document path: ${value}`);
  }
  const parts = value.split('/');
  if (parts.includes('') || parts.includes('.') || parts.includes('..')) {
    throw new Error(`invalid TypeScript SCIP document path: ${value}`);
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
