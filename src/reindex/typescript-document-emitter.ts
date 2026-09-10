import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type * as TypeScript from 'typescript';
import type { SemanticReferenceFragment } from '../semantic/types.js';
import { readSmallArtifactText } from '../platform/bounded-file.js';
import { installTypeScriptDocumentEncoding } from './typescript-document-encoding.js';
import { TypeScriptFragmentCache } from './typescript-document-blob.js';
import {
  installTypeScriptSuperCalls,
  type TypeScriptCallIndexer,
  type TypeScriptCallOccurrenceConstructor,
} from './typescript-super-calls.js';
import {
  installTypeScriptSymbolIdentity,
  typeScriptExportBoundary,
  type TypeScriptSymbolConstructors,
} from './typescript-symbol-identity.js';
import {
  installTypeScriptDeclarationEvidence,
  type TypeScriptDeclarationIndexer,
  type TypeScriptEvidenceConstructors,
} from './typescript-declaration-evidence.js';

const require = createRequire(import.meta.url);

export const SCIP_TYPESCRIPT_DOCUMENT_EMITTER_ADAPTER_VERSION = 7;
const SUPPORTED_SCIP_TYPESCRIPT_VERSION = '0.4.0';

type TypeScriptModule = typeof TypeScript;

interface ScipDocumentLike {
  relative_path: string;
  occurrences: ScipOccurrenceLike[];
  symbols: unknown[];
  serializeBinary(): Uint8Array;
}

interface ScipOccurrenceLike {
  range: number[];
  symbol: string;
  symbol_roles: number;
}

interface ScipIndexLike {
  metadata?: unknown;
  documents: ScipDocumentLike[];
  external_symbols: unknown[];
  serializeBinary(): Uint8Array;
}

interface ScipDocumentConstructor {
  readonly prototype: Parameters<typeof installTypeScriptDocumentEncoding>[0];
  new (value: { relative_path: string; occurrences: unknown[] }): ScipDocumentLike;
  deserializeBinary(value: Uint8Array): ScipDocumentLike;
}

interface ScipIndexConstructor {
  new (value: { metadata?: unknown; documents?: ScipDocumentLike[]; external_symbols?: unknown[] }): ScipIndexLike;
  deserializeBinary(value: Uint8Array): ScipIndexLike;
}

interface FileIndexerLike extends TypeScriptCallIndexer, TypeScriptDeclarationIndexer {
  sourceFile: TypeScript.SourceFile;
  index(): void;
}

interface FileIndexerConstructor {
  readonly prototype: FileIndexerLike;
  new (
    checker: TypeScript.TypeChecker,
    options: Record<string, unknown>,
    input: unknown,
    document: ScipDocumentLike,
    symbolTable: Map<TypeScript.Node, unknown>,
    constructorTable: Map<TypeScript.ClassDeclaration, boolean>,
    packages: unknown,
    sourceFile: TypeScript.SourceFile,
  ): FileIndexerLike;
}

interface InputConstructor {
  new (path: string, text: string): unknown;
}

interface PackagesConstructor {
  new (projectRoot: string): unknown;
}

export interface TypeScriptDocumentRuntime {
  packageVersion: string;
  typescript: TypeScriptModule;
  Document: ScipDocumentConstructor;
  Index: ScipIndexConstructor;
  FileIndexer: FileIndexerConstructor;
  Input: InputConstructor;
  Packages: PackagesConstructor;
}

export type TypeScriptDocumentRuntimeAvailability =
  | { available: true; runtime: TypeScriptDocumentRuntime; producerIdentity: string }
  | { available: false; reason: string };

export type TypeScriptDocumentProducerAvailability =
  | { available: true; packageVersion: string; typescriptVersion: string; producerIdentity: string }
  | { available: false; reason: string };

export interface TypeScriptDocumentFragment {
  relativePath: string;
  bytes: Uint8Array | null;
  occurrences: number;
  symbols: number;
  referenceFragments: SemanticReferenceFragment[];
}

export interface TypeScriptDocumentEmitterStats {
  initializations: number;
  programUpdates: number;
  documentsEmitted: number;
  documentsReused: number;
  documentsRemoved: number;
  sourceNodesReused: number;
  sourceNodesReplaced: number;
  symbolEntriesPruned: number;
}

// scip-query: ignore-stale — reviewed S1 owned contract; these options define document-emission policy.
export interface TypeScriptDocumentEmitterOptions {
  workspaceRoot: string;
  tsconfigPath: string;
  projectRoot?: string;
  maxFileByteSize?: number;
  runtime?: TypeScriptDocumentRuntime | null;
}

export interface TypeScriptDocumentAdvanceInput {
  modifiedFiles: readonly string[];
  /** Files removed since the previous compiler program. Omitted by older direct callers. */
  removedFiles?: readonly string[];
  affectedFiles: readonly string[];
}

export interface TypeScriptDocumentAdvanceResult {
  producerIdentity: string;
  fragments: TypeScriptDocumentFragment[];
  durationMs: number;
  stats: TypeScriptDocumentEmitterStats;
}

interface ConsumerDocumentReuse {
  program: TypeScript.Program;
  options: string;
  boundaries: ReadonlyMap<string, string>;
  documents: TypeScriptFragmentCache;
}

// scip-query: ignore-stale — reviewed S1 owned contract; this union makes emitter creation failure explicit.
export type TypeScriptDocumentEmitterCreation =
  | { available: true; emitter: TypeScriptDocumentEmitter }
  | { available: false; reason: string };

/**
 * Loads the exact compiler and shipped scip-typescript internals used by the
 * document adapter. Failure is an availability result so callers can retain
 * the whole-project CLI as the correctness fallback.
 */
export function loadTypeScriptDocumentRuntime(): TypeScriptDocumentRuntimeAvailability {
  try {
    const producer = resolveTypeScriptDocumentProducer();
    if (!producer.available) return producer;
    const { packageRoot } = producer;
    const typescriptPath = require.resolve('typescript', { paths: [packageRoot] });
    const typescript = require(typescriptPath) as TypeScriptModule;
    const { FileIndexer } = require(resolve(packageRoot, 'dist/src/FileIndexer.js')) as {
      FileIndexer?: FileIndexerConstructor;
    };
    const { Input } = require(resolve(packageRoot, 'dist/src/Input.js')) as { Input?: InputConstructor };
    const { Packages } = require(resolve(packageRoot, 'dist/src/Packages.js')) as {
      Packages?: PackagesConstructor;
    };
    const scipModule = require(resolve(packageRoot, 'dist/src/scip.js')) as {
      scip?: {
        Document?: ScipDocumentConstructor;
        Index?: ScipIndexConstructor;
        Occurrence?: TypeScriptCallOccurrenceConstructor & TypeScriptEvidenceConstructors['Occurrence'];
        SymbolInformation?: TypeScriptEvidenceConstructors['SymbolInformation'];
      };
    };
    if (
      !FileIndexer ||
      !Input ||
      !Packages ||
      !scipModule.scip?.Document ||
      !scipModule.scip.Index ||
      !scipModule.scip.Occurrence ||
      !scipModule.scip.SymbolInformation
    ) {
      return { available: false, reason: 'scip-typescript document runtime has an unsupported module shape' };
    }
    const { ScipSymbol } = require(resolve(packageRoot, 'dist/src/ScipSymbol.js')) as {
      ScipSymbol: Pick<TypeScriptSymbolConstructors, 'global'>;
    };
    const { metaDescriptor, methodDescriptor } = require(resolve(packageRoot, 'dist/src/Descriptor.js')) as Pick<
      TypeScriptSymbolConstructors,
      'metaDescriptor' | 'methodDescriptor'
    >;
    installTypeScriptSymbolIdentity(FileIndexer.prototype, typescript, {
      global: ScipSymbol.global,
      metaDescriptor,
      methodDescriptor,
    });
    installTypeScriptDocumentEncoding(scipModule.scip.Document.prototype);
    installTypeScriptSuperCalls(FileIndexer.prototype, typescript, scipModule.scip.Occurrence);
    installTypeScriptDeclarationEvidence(FileIndexer.prototype, typescript, {
      Occurrence: scipModule.scip.Occurrence,
      SymbolInformation: scipModule.scip.SymbolInformation,
    });
    const runtime = {
      packageVersion: producer.packageVersion,
      typescript,
      Document: scipModule.scip.Document,
      Index: scipModule.scip.Index,
      FileIndexer,
      Input,
      Packages,
    };
    return { available: true, runtime, producerIdentity: producerIdentity(runtime) };
  } catch (error) {
    return {
      available: false,
      reason: `scip-typescript document runtime unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function inspectTypeScriptDocumentProducer(): TypeScriptDocumentProducerAvailability {
  const producer = resolveTypeScriptDocumentProducer();
  if (!producer.available) return producer;
  return {
    available: true,
    packageVersion: producer.packageVersion,
    typescriptVersion: producer.typescriptVersion,
    producerIdentity: producer.producerIdentity,
  };
}

function resolveTypeScriptDocumentProducer():
  | (Extract<TypeScriptDocumentProducerAvailability, { available: true }> & { packageRoot: string })
  | Extract<TypeScriptDocumentProducerAvailability, { available: false }> {
  try {
    const packageJsonPath = require.resolve('@sourcegraph/scip-typescript/package.json');
    const packageJson = JSON.parse(readSmallArtifactText(packageJsonPath, 'scip-typescript package manifest')) as {
      version?: unknown;
    };
    if (packageJson.version !== SUPPORTED_SCIP_TYPESCRIPT_VERSION) {
      return {
        available: false,
        reason: `unsupported scip-typescript version ${String(packageJson.version ?? 'unknown')}; expected ${SUPPORTED_SCIP_TYPESCRIPT_VERSION}`,
      };
    }
    const packageRoot = dirname(packageJsonPath);
    const typescriptPackagePath = require.resolve('typescript/package.json', { paths: [packageRoot] });
    const typescriptPackage = JSON.parse(
      readSmallArtifactText(typescriptPackagePath, 'TypeScript package manifest'),
    ) as { version?: unknown };
    if (typeof typescriptPackage.version !== 'string' || !typescriptPackage.version) {
      return { available: false, reason: 'scip-typescript TypeScript compiler version is unavailable' };
    }
    return {
      available: true,
      packageRoot,
      packageVersion: packageJson.version,
      typescriptVersion: typescriptPackage.version,
      producerIdentity: producerIdentityForVersions(packageJson.version, typescriptPackage.version),
    };
  } catch (error) {
    return {
      available: false,
      reason: `scip-typescript document producer unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function createTypeScriptDocumentEmitter(
  opts: TypeScriptDocumentEmitterOptions,
): TypeScriptDocumentEmitterCreation {
  const availability =
    opts.runtime === undefined
      ? loadTypeScriptDocumentRuntime()
      : opts.runtime === null
        ? { available: false as const, reason: 'scip-typescript document runtime unavailable' }
        : { available: true as const, runtime: opts.runtime, producerIdentity: producerIdentity(opts.runtime) };
  if (!availability.available) return availability;
  return { available: true, emitter: new TypeScriptDocumentEmitter(opts, availability.runtime) };
}

export class TypeScriptDocumentEmitter {
  readonly producerIdentity: string;
  private readonly workspaceRoot: string;
  private readonly tsconfigPath: string;
  private readonly projectRoot: string;
  private readonly maxFileByteSize: number;
  private readonly runtime: TypeScriptDocumentRuntime;
  private readonly host: CachedCompilerHost;
  private config: TypeScript.ParsedCommandLine | null = null;
  private includedFiles = new Set<string>();
  private program: TypeScript.Program | null = null;
  private checker: TypeScript.TypeChecker | null = null;
  private symbolTable = new Map<TypeScript.Node, unknown>();
  private constructorTable = new Map<TypeScript.ClassDeclaration, boolean>();
  private packages: unknown;
  private fragments = new Map<string, Uint8Array>();
  private documentCache = new TypeScriptFragmentCache();
  private stats: TypeScriptDocumentEmitterStats = {
    initializations: 0,
    programUpdates: 0,
    documentsEmitted: 0,
    documentsReused: 0,
    documentsRemoved: 0,
    sourceNodesReused: 0,
    sourceNodesReplaced: 0,
    symbolEntriesPruned: 0,
  };

  constructor(opts: TypeScriptDocumentEmitterOptions, runtime: TypeScriptDocumentRuntime) {
    this.workspaceRoot = resolve(opts.workspaceRoot);
    this.tsconfigPath = resolve(this.workspaceRoot, opts.tsconfigPath);
    this.projectRoot = opts.projectRoot ?? projectArgument(this.workspaceRoot, dirname(this.tsconfigPath));
    this.maxFileByteSize = opts.maxFileByteSize ?? 1024 * 1024;
    this.runtime = runtime;
    this.producerIdentity = producerIdentity(runtime);
    const config = readTypeScriptConfig(runtime.typescript, this.tsconfigPath);
    this.config = config;
    this.host = new CachedCompilerHost(runtime.typescript, config.options, this.workspaceRoot);
    this.packages = new runtime.Packages(this.projectRoot);
  }

  // scip-query: ignore-twin — initialization lifecycle belongs to this emitter's compiler state.
  initialize(): TypeScriptDocumentAdvanceResult {
    const startedAt = performance.now();
    this.initializeProgram();

    const fragments: TypeScriptDocumentFragment[] = [];
    for (const sourceFile of this.program!.getSourceFiles()) {
      if (!this.includedFiles.has(normalizedAbsolutePath(sourceFile.fileName))) continue;
      fragments.push(this.emitSourceFile(sourceFile));
    }
    return this.result(fragments, startedAt);
  }

  advance(input: TypeScriptDocumentAdvanceInput): TypeScriptDocumentAdvanceResult {
    if (!this.program || !this.checker || !this.config) return this.initializeAndAdvance(input);
    const startedAt = performance.now();
    const { modifiedFiles, removedFiles, affectedFiles } = normalizedTypeScriptAdvancePaths(input);
    this.fragments.clear();
    if (modifiedFiles.length === 0 && removedFiles.length === 0) {
      this.validateAffectedPaths(affectedFiles);
      return this.result(this.emitAffectedFiles(affectedFiles), startedAt);
    }
    const reusable = this.detachConsumerDocuments(modifiedFiles, removedFiles);
    const config = readTypeScriptConfig(this.runtime.typescript, this.tsconfigPath);
    this.config = config;
    this.includedFiles = new Set(config.fileNames.map(normalizedAbsolutePath));

    const previousProgram = this.program;
    const previousNodes = this.invalidateSourceNodes([...modifiedFiles, ...removedFiles]);

    this.program = this.runtime.typescript.createProgram(
      config.fileNames,
      config.options,
      this.host.compilerHost,
      previousProgram,
    );
    this.checker = this.program.getTypeChecker();
    this.stats.programUpdates += 1;
    this.validateIncrementalPaths(modifiedFiles, removedFiles, affectedFiles);
    this.stats.documentsRemoved += removedFiles.length;
    this.recordSourceNodeUpdates(previousNodes);

    this.restoreConsumerDocuments(reusable, modifiedFiles);

    return this.result(this.emitAffectedFiles(affectedFiles), startedAt);
  }

  fragment(relativePath: string): Uint8Array | null {
    return this.fragments.get(normalizeRelativePath(relativePath)) ?? null;
  }

  // scip-query: ignore-twin — snapshot shape belongs to this emitter's mutable counters.
  snapshotStats(): TypeScriptDocumentEmitterStats {
    return { ...this.stats };
  }

  private initializeAndAdvance(input: TypeScriptDocumentAdvanceInput): TypeScriptDocumentAdvanceResult {
    const startedAt = performance.now();
    this.initializeProgram();
    const modifiedFiles = normalizedUniqueRelativePaths(input.modifiedFiles);
    const removedFiles = normalizedUniqueRelativePaths(input.removedFiles ?? []);
    const affectedFiles = normalizedUniqueRelativePaths(input.affectedFiles);
    this.fragments.clear();
    this.validateIncrementalPaths(modifiedFiles, removedFiles, affectedFiles, true);
    this.stats.documentsRemoved += removedFiles.length;
    return this.result(this.emitAffectedFiles(affectedFiles), startedAt);
  }

  private initializeProgram(): void {
    this.documentCache = new TypeScriptFragmentCache();
    this.symbolTable = new Map();
    this.constructorTable.clear();
    const config = this.config ?? readTypeScriptConfig(this.runtime.typescript, this.tsconfigPath);
    this.includedFiles = new Set(config.fileNames.map(normalizedAbsolutePath));
    this.program = this.runtime.typescript.createProgram(config.fileNames, config.options, this.host.compilerHost);
    this.checker = this.program.getTypeChecker();
    this.stats.initializations += 1;
  }

  private validateIncrementalPaths(
    modifiedFiles: readonly string[],
    removedFiles: readonly string[],
    affectedFiles: readonly string[],
    cold = false,
  ): void {
    if (!cold && modifiedFiles.length === 0 && removedFiles.length === 0) {
      throw new Error('incremental TypeScript document update requires a modified or removed file');
    }
    if (affectedFiles.length === 0 && removedFiles.length === 0) {
      throw new Error('incremental TypeScript document update requires an affected or removed file');
    }
    for (const relativePath of modifiedFiles) {
      const absolutePath = resolveWithin(this.workspaceRoot, relativePath);
      if (!this.program?.getSourceFile(absolutePath)) {
        throw new Error(`modified TypeScript dependency is unavailable to the configured project: ${relativePath}`);
      }
    }
    for (const relativePath of removedFiles) {
      const absolutePath = resolveWithin(this.workspaceRoot, relativePath);
      if (this.program?.getSourceFile(absolutePath)) {
        throw new Error(`removed TypeScript source is still present in the configured project: ${relativePath}`);
      }
    }
    this.validateAffectedPaths(affectedFiles);
  }

  private validateAffectedPaths(affectedFiles: readonly string[]): void {
    for (const relativePath of affectedFiles) {
      const absolutePath = resolveWithin(this.workspaceRoot, relativePath);
      if (!this.includedFiles.has(normalizedAbsolutePath(absolutePath))) {
        throw new Error(`affected TypeScript file is outside the configured project: ${relativePath}`);
      }
    }
  }

  private emitAffectedFiles(affectedFiles: readonly string[]): TypeScriptDocumentFragment[] {
    // Keep declaration caches scoped to this request. Global synthetic names
    // derive from source positions; local counters remain document-scoped.
    this.stats.symbolEntriesPruned += this.symbolTable.size + this.constructorTable.size;
    this.symbolTable = new Map();
    this.constructorTable.clear();
    return affectedFiles.map((relativePath) => {
      const sourceFile = this.program!.getSourceFile(resolveWithin(this.workspaceRoot, relativePath));
      if (!sourceFile) throw new Error(`affected TypeScript source is unavailable: ${relativePath}`);
      return this.emitSourceFile(sourceFile);
    });
  }

  private emitSourceFile(sourceFile: TypeScript.SourceFile): TypeScriptDocumentFragment {
    if (!this.checker) throw new Error('TypeScript document emitter is not initialized');
    const relativePath = normalizeRelativePath(relative(this.workspaceRoot, sourceFile.fileName));
    const cached = this.documentCache.get(relativePath);
    if (cached !== undefined) {
      this.stats.documentsReused += 1;
      if (cached !== null) this.fragments.set(relativePath, cached);
      const document = cached === null ? null : this.runtime.Document.deserializeBinary(cached);
      return {
        relativePath,
        bytes: cached,
        occurrences: document?.occurrences.length ?? 0,
        symbols: document?.symbols.length ?? 0,
        referenceFragments: document ? referenceFragmentsFromDocument(relativePath, document) : [],
      };
    }
    const document = new this.runtime.Document({ relative_path: relativePath, occurrences: [] });
    const indexer = this.fileIndexer(sourceFile, document);
    indexer.index();
    this.stats.documentsEmitted += 1;
    if (document.occurrences.length === 0) {
      this.fragments.delete(relativePath);
      this.stats.documentsRemoved += 1;
      return {
        relativePath,
        bytes: null,
        occurrences: 0,
        symbols: document.symbols.length,
        referenceFragments: [],
      };
    }
    const bytes = document.serializeBinary();
    this.fragments.set(relativePath, bytes);
    this.documentCache.set(relativePath, bytes);
    return {
      relativePath,
      bytes,
      occurrences: document.occurrences.length,
      symbols: document.symbols.length,
      referenceFragments: referenceFragmentsFromDocument(relativePath, document),
    };
  }

  private fileIndexer(sourceFile: TypeScript.SourceFile, document: ScipDocumentLike): FileIndexerLike {
    return new this.runtime.FileIndexer(
      this.checker!,
      {
        cwd: this.workspaceRoot,
        projectRoot: this.projectRoot,
        projectDisplayName: this.projectRoot,
        maxFileByteSizeNumber: this.maxFileByteSize,
      },
      new this.runtime.Input(sourceFile.fileName, sourceFile.getText()),
      document,
      this.symbolTable,
      this.constructorTable,
      this.packages,
      sourceFile,
    );
  }

  private captureBoundaries(paths: readonly string[]): Map<string, string> | null {
    const result = new Map<string, string>();
    // Declaration identity tables must belong to this compiler program.
    this.symbolTable = new Map();
    this.constructorTable.clear();
    for (const path of paths) {
      const source = this.program?.getSourceFile(resolveWithin(this.workspaceRoot, path));
      if (!source || !this.program) return null;
      const indexer = this.fileIndexer(source, new this.runtime.Document({ relative_path: path, occurrences: [] }));
      const boundary = typeScriptExportBoundary(this.runtime.typescript, this.program, source, indexer);
      if (boundary === null) return null;
      result.set(path, boundary);
    }
    return result;
  }

  private detachConsumerDocuments(
    modified: readonly string[],
    removed: readonly string[],
  ): ConsumerDocumentReuse | null {
    const documents = this.documentCache;
    // Detach before any fallible program update. A failed request must never
    // leave older documents eligible for reuse in a partially advanced program.
    this.documentCache = new TypeScriptFragmentCache();
    const boundaries = removed.length ? null : this.captureBoundaries(modified);
    return boundaries
      ? { documents, boundaries, program: this.program!, options: JSON.stringify(this.config!.options) }
      : null;
  }

  private restoreConsumerDocuments(reusable: ConsumerDocumentReuse | null, modified: readonly string[]): void {
    if (
      !reusable ||
      reusable.options !== JSON.stringify(this.config!.options) ||
      !compatibleProgramSources(reusable.program, this.program!, modified, this.workspaceRoot) ||
      !equalBoundaries(reusable.boundaries, this.captureBoundaries(modified))
    )
      return;
    for (const path of modified) reusable.documents.delete(path);
    reusable.documents.protectForGeneration();
    this.documentCache = reusable.documents;
  }

  private invalidateSourceNodes(paths: readonly string[]): Map<string, TypeScript.SourceFile> {
    const previous = new Map<string, TypeScript.SourceFile>();
    for (const path of paths) {
      const absolutePath = resolveWithin(this.workspaceRoot, path);
      const source = this.program!.getSourceFile(absolutePath);
      if (source) previous.set(path, source);
      this.host.invalidate(absolutePath);
    }
    return previous;
  }

  private recordSourceNodeUpdates(previous: ReadonlyMap<string, TypeScript.SourceFile>): void {
    for (const [path, source] of previous) {
      const current = this.program!.getSourceFile(resolveWithin(this.workspaceRoot, path));
      if (current === source) this.stats.sourceNodesReused += 1;
      else this.stats.sourceNodesReplaced += 1;
    }
  }

  private result(fragments: TypeScriptDocumentFragment[], startedAt: number): TypeScriptDocumentAdvanceResult {
    return {
      producerIdentity: this.producerIdentity,
      fragments,
      durationMs: performance.now() - startedAt,
      stats: this.snapshotStats(),
    };
  }
}

export function referenceFragmentsFromDocument(
  relativePath: string,
  document: Pick<ScipDocumentLike, 'occurrences'>,
): SemanticReferenceFragment[] {
  const fragments = new Map<string, SemanticReferenceFragment>();
  for (const occurrence of document.occurrences) {
    if (!occurrence.symbol || (occurrence.symbol_roles & 1) !== 0 || occurrence.range.length < 3) continue;
    const line = occurrence.range[0];
    const column = occurrence.range[1];
    if (!Number.isInteger(line) || !Number.isInteger(column)) continue;
    const fragment = { targetSymbol: occurrence.symbol, location: { file: relativePath, line, column } };
    fragments.set(`${occurrence.symbol}\0${line}\0${column}`, fragment);
  }
  return [...fragments.values()].sort(
    (left, right) =>
      left.targetSymbol.localeCompare(right.targetSymbol) ||
      left.location.line - right.location.line ||
      left.location.column - right.location.column,
  );
}

class CachedCompilerHost {
  readonly compilerHost: TypeScript.CompilerHost;
  private readonly sourceFiles = new Map<string, TypeScript.SourceFile | undefined>();

  constructor(typescript: TypeScriptModule, options: TypeScript.CompilerOptions, currentDirectory: string) {
    const base = typescript.createCompilerHost(options);
    const getSourceFile = base.getSourceFile.bind(base);
    this.compilerHost = {
      ...base,
      getCurrentDirectory: () => currentDirectory,
      getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
        const key = normalizedAbsolutePath(fileName);
        if (this.sourceFiles.has(key)) return this.sourceFiles.get(key);
        const sourceFile = getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
        this.sourceFiles.set(key, sourceFile);
        return sourceFile;
      },
    };
  }

  invalidate(fileName: string): void {
    this.sourceFiles.delete(normalizedAbsolutePath(fileName));
  }
}

function compatibleProgramSources(
  previous: TypeScript.Program,
  current: TypeScript.Program,
  modified: readonly string[],
  root: string,
): boolean {
  if (previous.getSourceFiles().length !== current.getSourceFiles().length) return false;
  if (JSON.stringify(previous.getRootFileNames()) !== JSON.stringify(current.getRootFileNames())) return false;
  const changes = new Set(modified.map((path) => resolveWithin(root, path)));
  return previous.getSourceFiles().every((source, index) => {
    // Source order can determine merged overload precedence in global/ambient
    // declarations, even when the set of program files is unchanged.
    const replacement = current.getSourceFiles()[index];
    return (
      replacement?.fileName === source.fileName && (changes.has(resolve(source.fileName)) || source === replacement)
    );
  });
}

function equalBoundaries(previous: ReadonlyMap<string, string>, current: ReadonlyMap<string, string> | null): boolean {
  return (
    current !== null &&
    previous.size === current.size &&
    [...previous].every(([path, hash]) => current.get(path) === hash)
  );
}

function readTypeScriptConfig(typescript: TypeScriptModule, tsconfigPath: string): TypeScript.ParsedCommandLine {
  const read = typescript.readConfigFile(tsconfigPath, typescript.sys.readFile);
  if (read.error) throw new Error(typescript.formatDiagnostics([read.error], typescript.createCompilerHost({})));
  const config = typescript.parseJsonConfigFileContent(read.config as object, typescript.sys, dirname(tsconfigPath));
  const errors = config.errors.filter((error) => error.code !== 18003);
  if (errors.length > 0) {
    throw new Error(typescript.formatDiagnostics(errors, typescript.createCompilerHost({})));
  }
  return config;
}

function producerIdentity(runtime: TypeScriptDocumentRuntime): string {
  return producerIdentityForVersions(runtime.packageVersion, runtime.typescript.version);
}

function producerIdentityForVersions(packageVersion: string, typescriptVersion: string): string {
  return `scip-typescript:${packageVersion}:typescript:${typescriptVersion}:document-adapter:${SCIP_TYPESCRIPT_DOCUMENT_EMITTER_ADAPTER_VERSION}`;
}

function projectArgument(workspaceRoot: string, projectDirectory: string): string {
  const value = normalizeRelativePath(relative(workspaceRoot, projectDirectory));
  return value || '.';
}

function resolveWithin(workspaceRoot: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error(`expected a project-relative path: ${relativePath}`);
  const absolutePath = resolve(workspaceRoot, relativePath);
  const workspacePrefix = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
  if (absolutePath !== workspaceRoot && !absolutePath.startsWith(workspacePrefix)) {
    throw new Error(`path escapes the project root: ${relativePath}`);
  }
  return absolutePath;
}

function normalizedUniqueRelativePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalizeRelativePath))].sort();
}

// scip-query: ignore-twin — emitter normalization is narrower than the shared path policy.
function normalizeRelativePath(value: string): string {
  return value.split(sep).join('/').replace(/^\.\//, '');
}

// scip-query: ignore-passthrough — canonical key operation used at every
// TypeScript source-file map boundary; the name records why resolution occurs.
function normalizedAbsolutePath(value: string): string {
  return resolve(value);
}

function normalizedTypeScriptAdvancePaths(input: TypeScriptDocumentAdvanceInput): {
  modifiedFiles: string[];
  removedFiles: string[];
  affectedFiles: string[];
} {
  const modifiedFiles = normalizedUniqueRelativePaths(input.modifiedFiles);
  const removedFiles = normalizedUniqueRelativePaths(input.removedFiles ?? []);
  const affectedFiles = normalizedUniqueRelativePaths(input.affectedFiles);
  return { modifiedFiles, removedFiles, affectedFiles };
}
