import path from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import { cached } from './cache.js';
import { isTypeScriptLike, TYPESCRIPT_SEMANTIC_EXTENSIONS } from './source-kinds.js';
import type { ProjectBundle } from './ts-morph-runtime.js';
import type { Project, SourceFile } from 'ts-morph';

export interface SourceFileMatch {
  project: Project;
  sourceFile: SourceFile;
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
  const sourceFileMatch = (relativePath: string): SourceFileMatch | null => {
    if (!isTypeScriptLike(relativePath)) return null;
    return cached(sourceFileCache, relativePath, () => {
      const fullPath = path.join(db.config.projectRoot, relativePath);
      for (const { project } of projects) {
        const sourceFile = project.getSourceFile(fullPath) ?? project.addSourceFileAtPathIfExists(fullPath) ?? null;
        if (sourceFile) return { project, sourceFile };
      }
      return null;
    });
  };

  return {
    sourceFile: (relativePath) => sourceFileMatch(relativePath)?.sourceFile ?? null,
    sourceFileMatch,
    indexedTypeScriptLikeDocuments: () =>
      indexedDocumentPaths(db, {
        extensions: TYPESCRIPT_SEMANTIC_EXTENSIONS,
      }),
  };
}
