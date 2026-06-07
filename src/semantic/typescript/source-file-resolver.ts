import path from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { cached } from './cache.js';
import type { ProjectBundle } from './ts-morph-runtime.js';
import type { Project, SourceFile } from 'ts-morph';

export interface SourceFileMatch {
  project: Project;
  sourceFile: SourceFile;
}

export class TypeScriptSourceFiles {
  private readonly sourceFileCache = new Map<string, SourceFileMatch | null>();

  constructor(
    private readonly db: ScipDatabase,
    private readonly projects: readonly ProjectBundle[],
  ) {}

  sourceFile(relativePath: string): SourceFile | null {
    return this.sourceFileMatch(relativePath)?.sourceFile ?? null;
  }

  sourceFileMatch(relativePath: string): SourceFileMatch | null {
    if (!isTypeScriptLike(relativePath)) return null;
    return cached(this.sourceFileCache, relativePath, () => {
      const fullPath = path.join(this.db.config.projectRoot, relativePath);
      for (const { project } of this.projects) {
        const sourceFile = project.getSourceFile(fullPath)
          ?? project.addSourceFileAtPathIfExists(fullPath)
          ?? null;
        if (sourceFile) return { project, sourceFile };
      }
      return null;
    });
  }

  indexedTypeScriptLikeDocuments(): string[] {
    return this.db.all<{ relative_path: string }>(
      `SELECT relative_path
       FROM documents
       WHERE (
         relative_path LIKE '%.ts'
         OR relative_path LIKE '%.tsx'
         OR relative_path LIKE '%.mts'
         OR relative_path LIKE '%.cts'
         OR relative_path LIKE '%.js'
         OR relative_path LIKE '%.jsx'
         OR relative_path LIKE '%.mjs'
         OR relative_path LIKE '%.cjs'
       )
         ${this.db.pathExclusionsFor('documents')}`,
    ).map((document) => document.relative_path);
  }
}

function isTypeScriptLike(relativePath: string): boolean {
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(relativePath);
}
