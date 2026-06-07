import type { fingerprintProjectFiles } from './project-files.js';

export interface AugmentVueResolvedResult {
  vueFiles: number;
  resolvedReferences: number;
  insertedMentions: number;
  skippedReferences: number;
  syntheticSymbols: number;
}

export interface DefinitionInfo {
  fileName: string;
  textSpan: { start: number; length: number };
  name?: string;
  kind?: string;
}

export interface VueLanguageContext {
  ts: TsModule;
  language: VolarLanguage;
  languageService: TsLanguageService;
  fileNames: string[];
  configDir: string;
}

export interface TsModule {
  sys: {
    fileExists(path: string): boolean;
    readFile(path: string): string | undefined;
    readDirectory: (...args: unknown[]) => string[];
    directoryExists?(path: string): boolean;
    getDirectories?(path: string): string[];
    realpath?(path: string): string;
    useCaseSensitiveFileNames: boolean;
    newLine: string;
    writeFile(path: string, data: string): void;
  };
  ScriptKind: Record<string, number>;
  ScriptSnapshot: { fromString(text: string): TsScriptSnapshot };
  readConfigFile(configPath: string, readFile: (path: string) => string | undefined): {
    config?: unknown;
    error?: unknown;
  };
  parseJsonConfigFileContent(
    config: unknown,
    host: unknown,
    basePath: string,
    existingOptions?: unknown,
    configFileName?: string,
    resolutionStack?: unknown,
    extraFileExtensions?: unknown[],
  ): { options: unknown; fileNames: string[]; projectReferences?: unknown[] };
  createLanguageService(host: unknown): TsLanguageService;
  getDefaultLibFilePath(options: unknown): string;
}

export interface TsScriptSnapshot {
  getLength(): number;
  getText(start: number, end: number): string;
}

export interface TsLanguageService {
  getDefinitionAtPosition(fileName: string, position: number): DefinitionInfo[] | undefined;
  getDocumentHighlights?(
    fileName: string,
    position: number,
    filesToSearch: string[],
  ): {
    fileName: string;
    highlightSpans: { textSpan: { start: number; length: number } }[];
  }[] | undefined;
  getProgram(): { getSourceFile(fileName: string): unknown } | undefined;
}

export interface VueCoreModule {
  createParsedCommandLine(ts: TsModule, host: unknown, configFileName: string): {
    vueOptions: Record<string, unknown>;
  };
  createGlobalTypesWriter?(options: unknown, writeFile: (path: string, data: string) => void): unknown;
  getAllExtensions(options: Record<string, unknown>): string[];
  createVueLanguagePlugin(
    ts: TsModule,
    compilerOptions: unknown,
    vueOptions: unknown,
    asFileName: (id: string) => string,
  ): {
    getLanguageId(id: string): string | undefined;
  };
  createLanguage(
    plugins: unknown[],
    scripts: Map<string, unknown>,
    sync: (id: string) => void,
  ): VolarLanguage;
}

export interface VolarTsModule {
  createLanguageServiceHost(
    ts: TsModule,
    sys: unknown,
    language: VolarLanguage,
    asScriptId: (id: string) => string,
    projectHost: unknown,
  ): { languageServiceHost: unknown };
}

export interface VolarLanguage {
  scripts: {
    get(id: string, includeFsFiles?: boolean, shouldRegister?: boolean): VolarSourceScript | undefined;
    set(id: string, snapshot: TsScriptSnapshot, languageId?: string): VolarSourceScript | undefined;
  };
  maps: {
    get(virtualCode: VolarVirtualCode, sourceScript: VolarSourceScript): VolarMapper;
  };
}

export interface VolarSourceScript {
  generated?: {
    root: VolarVirtualCode;
    languagePlugin: {
      typescript?: {
        getServiceScript(root: VolarVirtualCode): { code: VolarVirtualCode } | undefined;
      };
    };
  };
}

export interface VolarVirtualCode {
  id: string;
  snapshot: TsScriptSnapshot;
}

export interface VolarMapper {
  toGeneratedLocation(
    sourceOffset: number,
    filter?: (data: { navigation?: unknown }) => boolean,
  ): Generator<readonly [number, { data: { navigation?: unknown } }]>;
}

export interface ResolvedOccurrence {
  sourceFile: string;
  sourceLine: number;
  sourceStartChar: number;
  sourceEndChar: number;
  symbolId: number;
}

export interface VueReferenceComputationResult {
  occurrences: ResolvedOccurrence[];
  skippedReferences: number;
}

export interface VueReferenceTask {
  fileName: string;
  startOffset: number;
  endOffset: number;
  countFileSkip: boolean;
}

export interface VueIdentifierToken {
  text: string;
  start: number;
  end: number;
}

export interface SourceTextInfo {
  text: string;
  lineStarts: number[];
}

export interface SourcePosition {
  line: number;
  character: number;
}

export interface VueSourceReader {
  get(fileName: string): SourceTextInfo | null;
  positionAt(source: SourceTextInfo, offset: number): SourcePosition;
}

export interface AugmentVueFingerprint {
  version: 2;
  tsconfig: string;
  files: ReturnType<typeof fingerprintProjectFiles>;
  db: {
    documents: number;
    symbols: number;
    chunks: number;
    mentions: number;
    ranges: number;
    maxChunkId: number | null;
    maxSymbolId: number | null;
  };
}
