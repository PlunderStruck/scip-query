import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../storage/db.js';
import { createPerDbValue } from '../storage/per-db-cache.js';
import { indexedDocumentPaths } from '../storage/scip-documents.js';
import { normalizePathSeparators as normalizePath } from '../domain/path-normalization.js';
import { isMissingProjectFileError, readProjectFileText } from '../platform/project-files.js';

/**
 * Source files a root configuration file names by path: `next.config.js`
 * pointing `images.loaderFile` at `./src/lib/media/image-loader.ts`, a
 * `package.json` script running `src/scripts/backfill.ts`, a bundler config
 * naming an entry. The framework or tool invokes what those files export, so
 * a zero-reference export there is not dead code.
 */
const CONFIG_FILE_PATTERN = /^(?:[\w.-]+\.config\.[cm]?[jt]s|package\.json)$/;
const SOURCE_PATH_PATTERN = /(?:\.{1,2}\/)?[\w@./-]+\.(?:[cm]?[jt]sx?)\b/g;

const configReferencedFilesCache = createPerDbValue<Set<string>>('config-referenced-files', {
  clearGroups: ['whole-project'],
});

export function configReferencedFiles(db: ScipDatabase): Set<string> {
  return configReferencedFilesCache.get(db, () => discoverConfigReferencedFiles(db));
}

export function isConfigReferencedFile(db: ScipDatabase, file: string): boolean {
  return configReferencedFiles(db).has(normalizePath(file));
}

function discoverConfigReferencedFiles(db: ScipDatabase): Set<string> {
  const referenced = new Set<string>();
  const root = db.config.projectRoot;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return referenced;
  }
  const configs = entries.filter((entry) => CONFIG_FILE_PATTERN.test(entry) && existsSync(join(root, entry)));
  if (configs.length === 0) return referenced;
  const indexed = new Set(indexedDocumentPaths(db, { includeIgnored: false }).map((path) => normalizePath(path)));
  for (const config of configs) {
    let text: string;
    try {
      text = readProjectFileText(root, config, { inputKind: 'root configuration file' });
    } catch (error) {
      if (isMissingProjectFileError(error)) continue;
      continue;
    }
    for (const match of text.matchAll(SOURCE_PATH_PATTERN)) {
      const candidate = normalizePath(match[0]).replace(/^\.\//, '');
      if (candidate.startsWith('..') || candidate.startsWith('/')) continue;
      if (indexed.has(candidate)) referenced.add(candidate);
    }
  }
  return referenced;
}
