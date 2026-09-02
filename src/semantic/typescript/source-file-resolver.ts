import path from 'node:path';
import { realpathSync } from 'node:fs';
import type { ScipDatabase } from '../../storage/db.js';
import { isMissingProjectFileError, resolveProjectFile } from '../../platform/project-files.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { cached } from './cache.js';
import { isTypeScriptLike, TYPESCRIPT_SEMANTIC_EXTENSIONS } from './source-kinds.js';
import type { ProjectBundle } from './ts-morph-runtime.js';
import type { Project, SourceFile } from 'ts-morph';
import { profileSpan } from '../../instrumentation/profile.js';

export interface SourceFileMatch {
  project: Project;
  sourceFile: SourceFile;
}

interface ProjectSourceFileIndex {
  project: Project;
  sourceFiles: Map<string, SourceFile>;
}

export function createTypeScriptSourceFiles(
  db: ScipDatabase,
  projects: readonly ProjectBundle[],
): {
  sourceFile(relativePath: string): SourceFile | null;
  sourceFileMatch(relativePath: string): SourceFileMatch | null;
  indexedTypeScriptLikeDocuments(): string[];
} {
  const sourceFileCache = new Map<string, SourceFileMatch | null>();
  const indexes = new Map<ProjectBundle, ProjectSourceFileIndex>();
  let indexedTypeScriptDocuments: string[] | null = null;

  const indexedDocuments = (): string[] => {
    indexedTypeScriptDocuments ??= indexedDocumentPaths(db, {
      extensions: TYPESCRIPT_SEMANTIC_EXTENSIONS,
    });
    return indexedTypeScriptDocuments;
  };

  // A bundle's index is built when the bundle is first consulted, which is
  // also when its compiler program is created; bundles no request touches
  // stay unloaded.
  const indexFor = (bundle: ProjectBundle): ProjectSourceFileIndex =>
    cached(indexes, bundle, () =>
      profileSpan(
        'typescript.source-file-index',
        () => {
          const sourceFiles = new Map<string, SourceFile>();
          for (const sourceFile of bundle.project.getSourceFiles()) addSourceFileAliases(sourceFiles, sourceFile);
          return { project: bundle.project, sourceFiles };
        },
        () => ({ tsconfigPath: bundle.tsconfigPath, indexedDocuments: indexedDocuments().length }),
      ),
    );

  const attach = (bundle: ProjectBundle, fullPath: string): SourceFileMatch | null => {
    const index = indexFor(bundle);
    let sourceFile = index.sourceFiles.get(fullPath) ?? null;
    if (!sourceFile) {
      sourceFile = bundle.project.addSourceFileAtPathIfExists(fullPath) ?? null;
      if (sourceFile) addSourceFileAliases(index.sourceFiles, sourceFile);
    }
    return sourceFile ? { project: index.project, sourceFile } : null;
  };

  const sourceFileMatch = (relativePath: string): SourceFileMatch | null => {
    if (!isTypeScriptLike(relativePath)) return null;
    return cached(sourceFileCache, relativePath, () => {
      const fullPath = resolveIndexedSourcePath(db.config.projectRoot, relativePath);
      if (!fullPath) return null;
      // Loaded bundles that already hold the file answer without any work.
      for (const bundle of projects) {
        if (!bundle.loaded) continue;
        const sourceFile = indexFor(bundle).sourceFiles.get(fullPath);
        if (sourceFile) return { project: bundle.project, sourceFile };
      }
      // Otherwise the tsconfig that lists the file owns it, even when that
      // means building its project: another project's compiler options
      // would resolve the file's imports differently.
      const listed = projects.find((bundle) => bundle.fileNames?.has(fullPath));
      if (listed) return attach(listed, fullPath);
      // A file no config lists is attached to a project already loaded, else
      // to the first (root) project, as before.
      for (const bundle of projects) {
        if (!bundle.loaded) continue;
        const match = attach(bundle, fullPath);
        if (match) return match;
      }
      const root = projects[0];
      return root ? attach(root, fullPath) : null;
    });
  };

  return {
    sourceFile: (relativePath) => sourceFileMatch(relativePath)?.sourceFile ?? null,
    sourceFileMatch,
    indexedTypeScriptLikeDocuments: indexedDocuments,
  };
}

function addSourceFileAliases(index: Map<string, SourceFile>, sourceFile: SourceFile): void {
  const sourcePath = normalizeSourcePath(sourceFile.getFilePath());
  index.set(sourcePath, sourceFile);
  try {
    index.set(normalizeSourcePath(realpathSync(sourcePath)), sourceFile);
  } catch (error) {
    if (!isMissingProjectFileError(error)) throw error;
  }
}

function resolveIndexedSourcePath(projectRoot: string, relativePath: string): string | null {
  try {
    return normalizeSourcePath(
      resolveProjectFile(projectRoot, relativePath, {
        inputKind: 'indexed TypeScript source file',
      }).absolutePath,
    );
  } catch (error) {
    if (!isMissingProjectFileError(error)) throw error;
    return null;
  }
}

function normalizeSourcePath(filePath: string): string {
  return path.resolve(filePath);
}
