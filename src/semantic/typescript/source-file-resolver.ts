import path from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
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
  let sourceFileIndexes: ProjectSourceFileIndex[] | null = null;
  let indexedTypeScriptDocuments: string[] | null = null;

  const indexedDocuments = (): string[] => {
    indexedTypeScriptDocuments ??= indexedDocumentPaths(db, {
      extensions: TYPESCRIPT_SEMANTIC_EXTENSIONS,
    });
    return indexedTypeScriptDocuments;
  };

  const projectSourceFileIndexes = (): ProjectSourceFileIndex[] => {
    sourceFileIndexes ??= profileSpan(
      'typescript.source-file-index',
      () => buildProjectSourceFileIndexes(db.config.projectRoot, projects, indexedDocuments()),
      () => ({ projects: projects.length, indexedDocuments: indexedDocuments().length }),
    );
    return sourceFileIndexes;
  };

  const sourceFileMatch = (relativePath: string): SourceFileMatch | null => {
    if (!isTypeScriptLike(relativePath)) return null;
    return cached(sourceFileCache, relativePath, () => {
      const fullPath = normalizeSourcePath(path.resolve(db.config.projectRoot, relativePath));
      for (const { project, sourceFiles } of projectSourceFileIndexes()) {
        let sourceFile = sourceFiles.get(fullPath) ?? null;
        if (!sourceFile) {
          sourceFile = project.addSourceFileAtPathIfExists(fullPath) ?? null;
          if (sourceFile) sourceFiles.set(normalizeSourcePath(sourceFile.getFilePath()), sourceFile);
        }
        if (sourceFile) return { project, sourceFile };
      }
      return null;
    });
  };

  return {
    sourceFile: (relativePath) => sourceFileMatch(relativePath)?.sourceFile ?? null,
    sourceFileMatch,
    indexedTypeScriptLikeDocuments: indexedDocuments,
  };
}

function buildProjectSourceFileIndexes(
  projectRoot: string,
  projects: readonly ProjectBundle[],
  indexedDocuments: readonly string[],
): ProjectSourceFileIndex[] {
  const indexes = projects.map(({ project }) => ({
    project,
    sourceFiles: new Map(
      project.getSourceFiles().map((sourceFile) => [normalizeSourcePath(sourceFile.getFilePath()), sourceFile]),
    ),
  }));

  for (const relativePath of indexedDocuments) {
    const fullPath = normalizeSourcePath(path.resolve(projectRoot, relativePath));
    for (const index of indexes) {
      if (index.sourceFiles.has(fullPath)) break;
      const sourceFile = index.project.addSourceFileAtPathIfExists(fullPath) ?? null;
      if (sourceFile) {
        index.sourceFiles.set(normalizeSourcePath(sourceFile.getFilePath()), sourceFile);
        break;
      }
    }
  }

  return indexes;
}

function normalizeSourcePath(filePath: string): string {
  return path.resolve(filePath);
}
