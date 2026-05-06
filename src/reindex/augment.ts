import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createGitignoreFilter } from '../gitignore-filter.js';
import { AUXILIARY_EXTENSIONS, SKIP_DIRS } from '../source-fileset.js';

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

/**
 * Add source files that upstream SCIP indexers skipped to the SQLite
 * documents table. Vue SFCs are the motivating case: scip-typescript can
 * resolve imports to generated TS, but it does not emit `.vue` documents.
 */
export function augmentAuxiliaryDocuments(
  opts: AugmentAuxiliaryDocumentsOptions,
): AugmentAuxiliaryDocumentsResult {
  const extensions = new Set(
    (opts.extensions ?? AUXILIARY_EXTENSIONS).map((ext) => ext.toLowerCase()),
  );

  if (extensions.size === 0) {
    return { scanned: 0, inserted: 0, existing: 0 };
  }
  if (!existsSync(opts.dbPath)) {
    throw new Error(`SCIP SQLite database not found at ${opts.dbPath}`);
  }

  const filter = createGitignoreFilter(opts.projectRoot);
  const files = listAuxiliaryFiles(opts.projectRoot, extensions)
    .filter((file) => !filter.isIgnored(file));

  const db = new Database(opts.dbPath);
  try {
    const existing = files.length === 0
      ? new Set<string>()
      : new Set((db.prepare(
        `SELECT relative_path FROM documents WHERE relative_path IN (${files.map(() => '?').join(',')})`,
      ).all(...files) as { relative_path: string }[])
        .map((row) => row.relative_path));

    const insert = db.prepare(
      `INSERT OR IGNORE INTO documents (language, relative_path, position_encoding, text)
       VALUES (?, ?, NULL, ?)`,
    );
    const transaction = db.transaction((paths: string[]) => {
      let inserted = 0;
      for (const relativePath of paths) {
        if (existing.has(relativePath)) continue;
        const text = readFileSync(join(opts.projectRoot, relativePath), 'utf-8');
        const info = insert.run(languageForPath(relativePath), relativePath, text);
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
  const out: string[] = [];
  const visit = (relDir: string): void => {
    const absDir = relDir ? join(absRoot, relDir) : absRoot;
    let entries: { name: string; isDirectory(): boolean }[] = [];
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

function languageForPath(relativePath: string): string {
  switch (extname(relativePath).toLowerCase()) {
    case '.vue':
      return 'vue';
    default:
      return extname(relativePath).replace(/^\./, '').toLowerCase() || 'source';
  }
}
