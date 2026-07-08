import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as TypeScript from 'typescript';
import type { IndexedDefinition } from '../../domain/types.js';
import type {
  SemanticAvailability,
  SemanticCallee,
  SemanticImportUsage,
  SemanticProvider,
  SemanticReference,
} from '../types.js';
import type { ScipDatabase } from '../../storage/db.js';
import { dedupeLocations, toRelative } from './semantic-locations.js';
import { discoverTypeScriptTsconfigs } from './tsconfig-discovery.js';
import { unavailableProvider } from './ts-morph-runtime.js';

export interface TypeScriptReferenceProviderMismatch {
  symbol: string;
  missing: SemanticReference[];
  extra: SemanticReference[];
}

export interface TypeScriptReferenceProviderComparison {
  slot: 'semantic-references';
  definitions: number;
  matches: number;
  mismatches: TypeScriptReferenceProviderMismatch[];
}

type TypeScriptModule = typeof TypeScript;

interface LanguageServiceBundle {
  tsconfigPath: string;
  service: TypeScript.LanguageService;
  files: Set<string>;
}

const require = createRequire(import.meta.url);
let typescriptModule: TypeScriptModule | null | undefined;

export function createTsServerProvider(db: ScipDatabase): SemanticProvider {
  const ts = loadTypeScript();
  if (!ts) return unavailableProvider('typescript is not installed');

  const tsconfigPaths = discoverTypeScriptTsconfigs(db);
  if (tsconfigPaths.length === 0) return unavailableProvider('no tsconfig found');

  try {
    return new TsServerSemanticProvider(
      db.config.projectRoot,
      ts,
      tsconfigPaths.map((tsconfigPath) => createLanguageServiceBundle(ts, tsconfigPath)),
    );
  } catch (error) {
    return unavailableProvider(error instanceof Error ? error.message : String(error), tsconfigPaths[0], tsconfigPaths);
  }
}

export function compareTypeScriptReferenceProviders(
  definitions: readonly IndexedDefinition[],
  baseline: SemanticProvider,
  candidate: SemanticProvider,
): TypeScriptReferenceProviderComparison {
  const baselineReferences = referencesForDefinitions(baseline, definitions);
  const candidateReferences = referencesForDefinitions(candidate, definitions);
  const mismatches: TypeScriptReferenceProviderMismatch[] = [];
  let matches = 0;

  for (const definition of definitions) {
    const baselineSet = referenceKeySet(baselineReferences.get(definition.symbolId) ?? []);
    const candidateSet = referenceKeySet(candidateReferences.get(definition.symbolId) ?? []);
    const missing = referencesWithout(baselineReferences.get(definition.symbolId) ?? [], candidateSet);
    const extra = referencesWithout(candidateReferences.get(definition.symbolId) ?? [], baselineSet);
    if (missing.length === 0 && extra.length === 0) {
      matches += 1;
      continue;
    }
    mismatches.push({ symbol: definition.symbol, missing, extra });
  }

  return {
    slot: 'semantic-references',
    definitions: definitions.length,
    matches,
    mismatches,
  };
}

class TsServerSemanticProvider implements SemanticProvider {
  readonly language = 'typescript' as const;
  private readonly referencesCache = new Map<number, SemanticReference[]>();

  constructor(
    private readonly projectRoot: string,
    private readonly ts: TypeScriptModule,
    private readonly bundles: LanguageServiceBundle[],
  ) {}

  availability(): SemanticAvailability {
    return {
      available: true,
      tsconfigPath: this.bundles[0]?.tsconfigPath,
      tsconfigPaths: this.bundles.map((bundle) => bundle.tsconfigPath),
    };
  }

  importUsage(_file: string): SemanticImportUsage[] {
    return [];
  }

  referencesFor(definition: IndexedDefinition): SemanticReference[] {
    const cached = this.referencesCache.get(definition.symbolId);
    if (cached) return cached;
    const references = this.computeReferences(definition);
    this.referencesCache.set(definition.symbolId, references);
    return references;
  }

  referencesForDefinitions(definitions: readonly IndexedDefinition[]): Map<number, SemanticReference[]> {
    const result = new Map<number, SemanticReference[]>();
    for (const definition of definitions) {
      result.set(definition.symbolId, this.referencesFor(definition));
    }
    return result;
  }

  calleesFor(_definition: IndexedDefinition): SemanticCallee[] {
    return [];
  }

  signatureFor(_definition: IndexedDefinition): string | null {
    return null;
  }

  private computeReferences(definition: IndexedDefinition): SemanticReference[] {
    const absolutePath = path.join(this.projectRoot, definition.relativePath);
    const bundle = this.bundleForFile(absolutePath);
    if (!bundle) return [];
    const source = bundle.service.getProgram()?.getSourceFile(absolutePath);
    if (!source) return [];
    const position = positionForDefinition(this.ts, source, definition);
    if (position === null) return [];
    const referencedSymbols = bundle.service.findReferences(absolutePath, position) ?? [];
    const references: SemanticReference[] = [];
    for (const referencedSymbol of referencedSymbols) {
      for (const entry of referencedSymbol.references) {
        const location = referenceEntryLocation(this.ts, bundle.service, this.projectRoot, entry);
        if (!location) continue;
        if (
          location.file === definition.relativePath &&
          location.line >= definition.startLine &&
          location.line <= definition.endLine
        ) {
          continue;
        }
        references.push(location);
      }
    }
    return dedupeLocations(references);
  }

  private bundleForFile(absolutePath: string): LanguageServiceBundle | null {
    const normalized = normalizePath(absolutePath);
    return this.bundles.find((bundle) => bundle.files.has(normalized)) ?? null;
  }
}

function loadTypeScript(): TypeScriptModule | null {
  if (typescriptModule !== undefined) return typescriptModule;
  try {
    typescriptModule = require('typescript') as TypeScriptModule;
  } catch {
    typescriptModule = null;
  }
  return typescriptModule;
}

function createLanguageServiceBundle(ts: TypeScriptModule, tsconfigPath: string): LanguageServiceBundle {
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error) {
    throw new Error(flattenDiagnostic(ts, config.error));
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(tsconfigPath));
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => flattenDiagnostic(ts, error)).join('\n'));
  }

  const files = new Set(parsed.fileNames.map(normalizePath));
  const service = ts.createLanguageService(createLanguageServiceHost(ts, parsed), ts.createDocumentRegistry());
  return { tsconfigPath, service, files };
}

function createLanguageServiceHost(
  ts: TypeScriptModule,
  parsed: TypeScript.ParsedCommandLine,
): TypeScript.LanguageServiceHost {
  return {
    getCompilationSettings: () => parsed.options,
    getCurrentDirectory: () =>
      parsed.options.configFilePath ? path.dirname(String(parsed.options.configFilePath)) : process.cwd(),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    getDirectories: ts.sys.getDirectories,
    getScriptFileNames: () => parsed.fileNames,
    getScriptSnapshot: (fileName) => {
      if (!existsSync(fileName)) return undefined;
      return ts.ScriptSnapshot.fromString(readFileSync(fileName, 'utf8'));
    },
    getScriptVersion: () => '0',
    readDirectory: ts.sys.readDirectory,
    readFile: ts.sys.readFile,
    fileExists: ts.sys.fileExists,
    directoryExists: ts.sys.directoryExists,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
  };
}

function positionForDefinition(
  ts: TypeScriptModule,
  source: TypeScript.SourceFile,
  definition: IndexedDefinition,
): number | null {
  const lines = source.text.split('\n');
  const start = Math.max(0, definition.startLine);
  const end = Math.min(lines.length - 1, Math.max(definition.endLine, definition.startLine));
  for (let line = start; line <= end; line += 1) {
    const column = lines[line]?.indexOf(definition.leaf) ?? -1;
    if (column >= 0) return ts.getPositionOfLineAndCharacter(source, line, column);
  }
  return null;
}

function referenceEntryLocation(
  ts: TypeScriptModule,
  service: TypeScript.LanguageService,
  projectRoot: string,
  entry: TypeScript.ReferenceEntry,
): SemanticReference | null {
  const relative = toRelative(projectRoot, entry.fileName);
  if (!relative) return null;
  const source = service.getProgram()?.getSourceFile(entry.fileName);
  if (!source) return null;
  const pos = ts.getLineAndCharacterOfPosition(source, entry.textSpan.start);
  return {
    file: relative,
    line: pos.line,
    column: pos.character,
  };
}

function referencesForDefinitions(
  provider: SemanticProvider,
  definitions: readonly IndexedDefinition[],
): Map<number, SemanticReference[]> {
  if (provider.referencesForDefinitions) {
    return provider.referencesForDefinitions(definitions);
  }
  return new Map(definitions.map((definition) => [definition.symbolId, provider.referencesFor(definition)]));
}

function referenceKeySet(references: readonly SemanticReference[]): Set<string> {
  return new Set(references.map(referenceKey));
}

function referencesWithout(references: readonly SemanticReference[], existing: Set<string>): SemanticReference[] {
  return references.filter((reference) => !existing.has(referenceKey(reference)));
}

function referenceKey(reference: SemanticReference): string {
  return `${reference.file}:${reference.line}:${reference.column}`;
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/');
}

function flattenDiagnostic(ts: TypeScriptModule, diagnostic: TypeScript.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}
