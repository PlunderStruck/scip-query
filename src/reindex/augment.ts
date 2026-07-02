import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createGitignoreFilter } from '../source/gitignore-filter.js';
import { AUXILIARY_EXTENSIONS, SKIP_DIRS } from '../source/source-fileset.js';
import type { PostIndexAugmentationStage } from './post-index-augmentation.js';

export interface AugmentAuxiliaryDocumentsOptions {
  projectRoot: string;
  dbPath: string;
  extensions?: readonly string[];
  onStatus?: (message: string) => void;
}

export interface AugmentAuxiliaryDocumentsResult {
  scanned: number;
  inserted: number;
  existing: number;
}

export function auxiliaryDocumentsAugmentationStage(
  opts: {
    extensions?: readonly string[];
  } = {},
): PostIndexAugmentationStage<AugmentAuxiliaryDocumentsResult> {
  return {
    id: 'auxiliary-documents',
    facts: ['auxiliary-document'],
    run: (context) =>
      augmentAuxiliaryDocuments({
        projectRoot: context.projectRoot,
        dbPath: context.dbPath,
        extensions: opts.extensions,
        onStatus: context.onStatus,
      }),
  };
}

/**
 * Add source files that upstream SCIP indexers skipped to the SQLite
 * documents table. Vue SFCs are the motivating case: scip-typescript can
 * resolve imports to generated TS, but it does not emit `.vue` documents.
 */
// scip-query: ignore-extract — this is the auxiliary-document transaction
// pipeline; the helper calls already own discovery/filtering/language
// detection, and keeping the DB write sequence together is clearer.
export function augmentAuxiliaryDocuments(opts: AugmentAuxiliaryDocumentsOptions): AugmentAuxiliaryDocumentsResult {
  const extensions = new Set((opts.extensions ?? AUXILIARY_EXTENSIONS).map((ext) => ext.toLowerCase()));

  if (extensions.size === 0) {
    return { scanned: 0, inserted: 0, existing: 0 };
  }
  if (!existsSync(opts.dbPath)) {
    throw new Error(`SCIP SQLite database not found at ${opts.dbPath}`);
  }

  const filter = createGitignoreFilter(opts.projectRoot);
  const files = listAuxiliaryFiles(opts.projectRoot, extensions).filter((file) => !filter.isIgnored(file));

  const db = new Database(opts.dbPath);
  try {
    const existing = selectExistingDocuments(db, files);

    const insert = db.prepare(
      `INSERT OR IGNORE INTO documents (language, relative_path, position_encoding, text)
       VALUES (?, ?, NULL, ?)`,
    );
    const transaction = db.transaction((paths: string[]) => {
      let inserted = 0;
      for (const relativePath of paths) {
        if (existing.has(relativePath)) continue;
        const text = readFileSync(join(opts.projectRoot, relativePath), 'utf-8');
        const info = insert.run(auxiliaryDocumentLanguageTag(relativePath), relativePath, text);
        inserted += Number(info.changes);
      }
      return inserted;
    });

    const inserted = transaction(files);
    const result = {
      scanned: files.length,
      inserted,
      existing: files.length - inserted,
    };
    opts.onStatus?.(
      `Augmented SQLite documents with ${inserted} auxiliary source file${inserted === 1 ? '' : 's'} (${result.existing} already present).`,
    );
    return result;
  } finally {
    db.close();
  }
}

function listAuxiliaryFiles(absRoot: string, extensions: ReadonlySet<string>): string[] {
  const gitFiles = listGitTrackedFiles(absRoot, extensions);
  if (gitFiles) {
    return gitFiles;
  }

  const out: string[] = [];
  const visit = (relDir: string): void => {
    const absDir = relDir ? join(absRoot, relDir) : absRoot;
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const relativePath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(relativePath);
        continue;
      }
      if (extensions.has(extname(entry.name).toLowerCase())) {
        out.push(relativePath);
      }
    }
  };

  visit('');
  return out.sort();
}

function listGitTrackedFiles(absRoot: string, extensions: ReadonlySet<string>): string[] | null {
  try {
    const stdout = execFileSync('git', ['-C', absRoot, 'ls-files', '-co', '--exclude-standard', '--', '.'], {
      encoding: 'utf-8',
      maxBuffer: 25 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return stdout
      .split('\n')
      .filter((file) => file && extensions.has(extname(file).toLowerCase()))
      .sort();
  } catch {
    return null;
  }
}

function selectExistingDocuments(db: Database.Database, files: readonly string[]): Set<string> {
  const existing = new Set<string>();
  const chunkSize = 500;
  for (let start = 0; start < files.length; start += chunkSize) {
    const chunk = files.slice(start, start + chunkSize);
    const rows = db
      .prepare(`SELECT relative_path FROM documents WHERE relative_path IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk) as { relative_path: string }[];
    for (const row of rows) {
      existing.add(row.relative_path);
    }
  }
  return existing;
}

// Best-effort language TAG for a documents-table row that no scip indexer
// produced (auxiliary/unindexed source files) -- not the canonical
// SupportedLanguage enum (see queries/navigation/code.ts's
// supportedLanguageFromPath for that); every row needs *some* string here,
// even for extensions the project doesn't otherwise recognize.
function auxiliaryDocumentLanguageTag(relativePath: string): string {
  switch (extname(relativePath).toLowerCase()) {
    case '.vue':
      return 'vue';
    default:
      return extname(relativePath).replace(/^\./, '').toLowerCase() || 'source';
  }
}
