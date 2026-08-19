import Database from 'better-sqlite3';
import { classifyProjectInputPath, type ProjectInputSnapshot } from '../domain/project-input.js';
import { normalizeRelativePath } from '../domain/path-normalization.js';
import type { SupportedLanguage } from '../domain/types.js';

const MAX_REPORTED_MISSING_PATHS = 25;

export type IndexDocumentCoverage =
  | {
      state: 'complete';
      expectedDocumentCount: number;
      actualDocumentCount: number;
    }
  | {
      state: 'incomplete';
      expectedDocumentCount: number;
      actualDocumentCount: number;
      missingDocumentCount: number;
      missingPaths: string[];
      affectedLanguages: SupportedLanguage[];
    }
  | {
      state: 'unavailable';
      reason: string;
    };

/**
 * Checks that every source file selected into the project fingerprint has a
 * document in the SQLite generation. This ties freshness to the graph-bearing
 * artifact, rather than accepting matching input hashes for an incomplete DB.
 */
export function inspectIndexDocumentCoverage(
  dbPath: string,
  snapshot: ProjectInputSnapshot,
  languages: readonly SupportedLanguage[],
): IndexDocumentCoverage {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const actualPaths = new Set(
      (db.prepare('SELECT relative_path FROM documents').pluck().all() as string[]).map(normalizeRelativePath),
    );
    const expectedByLanguage = expectedSourcePathsByLanguage(snapshot, languages);
    const expectedPaths = new Set([...expectedByLanguage.values()].flatMap((paths) => [...paths]));
    const missingPaths = [...expectedPaths].filter((path) => !actualPaths.has(path)).sort();
    if (missingPaths.length === 0) {
      return {
        state: 'complete',
        expectedDocumentCount: expectedPaths.size,
        actualDocumentCount: actualPaths.size,
      };
    }

    const missing = new Set(missingPaths);
    const affectedLanguages = languages.filter((language) =>
      [...(expectedByLanguage.get(language) ?? [])].some((path) => missing.has(path)),
    );
    return {
      state: 'incomplete',
      expectedDocumentCount: expectedPaths.size,
      actualDocumentCount: actualPaths.size,
      missingDocumentCount: missingPaths.length,
      missingPaths: missingPaths.slice(0, MAX_REPORTED_MISSING_PATHS),
      affectedLanguages,
    };
  } catch (error) {
    return { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

function expectedSourcePathsByLanguage(
  snapshot: ProjectInputSnapshot,
  languages: readonly SupportedLanguage[],
): Map<SupportedLanguage, Set<string>> {
  const result = new Map<SupportedLanguage, Set<string>>();
  for (const language of languages) result.set(language, new Set());
  for (const file of snapshot.files) {
    const path = normalizeRelativePath(file.path);
    for (const language of languages) {
      if (classifyProjectInputPath(path, [language]) === 'source') result.get(language)!.add(path);
    }
  }
  return result;
}
