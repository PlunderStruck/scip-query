import { execFileSync } from 'node:child_process';
import { listProjectFiles, projectFileExists, readProjectFile } from '../platform/project-files.js';
import { sourceHash } from './ast/function-metrics.js';

export interface SourceSnapshot {
  revision: string;
  files: Map<string, string>;
  fingerprint: string;
  eligibleFiles: number;
  excludedFiles: number;
  problems: string[];
}

export interface SourceScanOptions {
  includeTests?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
}

export const SOURCE_SCAN_DEFAULTS = { maxFiles: 5000, maxFileBytes: 1024 * 1024 };
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;

export function eligibleMaintenanceFile(file: string, includeTests = false): boolean {
  if (!/\.[cm]?[jt]sx?$/.test(file) || /\.d\.[cm]?ts$/.test(file)) return false;
  if (/(^|\/)(node_modules|vendor|dist|build|coverage|\.git|\.scipquery|generated)(\/|$)/.test(file)) return false;
  return (
    includeTests ||
    !/(^|\/)(__tests__|__fixtures__|tests?|fixtures|benchmarks)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/.test(file)
  );
}

export function currentSourceSnapshot(projectRoot: string, opts: SourceScanOptions = {}): SourceSnapshot {
  const paths = presentProjectFiles(projectRoot);
  return collectSnapshot('working-tree', paths, opts, (file) =>
    readProjectFile(projectRoot, file, { maxBytes: opts.maxFileBytes ?? SOURCE_SCAN_DEFAULTS.maxFileBytes }).toString(
      'utf8',
    ),
  );
}

export function gitRevision(projectRoot: string, base: string): string {
  return git(projectRoot, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`])
    .toString('utf8')
    .trim();
}

/** Read immutable blobs in one batch, including paths containing spaces or newlines. */
export function baseSourceSnapshot(projectRoot: string, base: string, opts: SourceScanOptions = {}): SourceSnapshot {
  const revision = gitRevision(projectRoot, base);
  const entries = git(projectRoot, ['ls-tree', '-r', '-z', revision]).toString('utf8').split('\0').filter(Boolean);
  const blobs = new Map<string, string>();
  for (const entry of entries) {
    const match = /^(100\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (match) blobs.set(match[3]!, match[2]!);
  }
  const selected = [...blobs.keys()]
    .filter((file) => eligibleMaintenanceFile(file, opts.includeTests))
    .sort()
    .slice(0, opts.maxFiles ?? SOURCE_SCAN_DEFAULTS.maxFiles);
  const contents = new Map<string, string>();
  // Batches bound peak memory independently of the repository's total object size.
  for (let offset = 0; offset < selected.length; offset += 32) {
    const batch = selected.slice(offset, offset + 32);
    const sizes = git(
      projectRoot,
      ['cat-file', '--batch-check'],
      batch.map((file) => blobs.get(file)).join('\n') + '\n',
    )
      .toString('utf8')
      .trim()
      .split('\n');
    const readable = batch.filter(
      (_, index) => Number(sizes[index]?.split(' ')[2]) <= (opts.maxFileBytes ?? SOURCE_SCAN_DEFAULTS.maxFileBytes),
    );
    if (readable.length === 0) continue;
    const output = git(projectRoot, ['cat-file', '--batch'], readable.map((file) => blobs.get(file)).join('\n') + '\n');
    let cursor = 0;
    for (const file of readable) {
      const headerEnd = output.indexOf(10, cursor);
      const size = Number(output.subarray(cursor, headerEnd).toString('utf8').split(' ')[2]);
      if (headerEnd < 0 || !Number.isSafeInteger(size) || size < 0 || headerEnd + 1 + size > output.length) {
        throw new Error('Invalid Git blob response while reading review base');
      }
      contents.set(file, output.subarray(headerEnd + 1, headerEnd + 1 + size).toString('utf8'));
      cursor = headerEnd + 1 + size + 1;
    }
  }
  return collectSnapshot(revision, [...blobs.keys()], opts, (file) => {
    const content = contents.get(file);
    if (content === undefined) throw new Error('exceeds the per-file byte limit');
    return content;
  });
}

export function assertSourceSnapshotCurrent(
  projectRoot: string,
  snapshot: SourceSnapshot,
  opts: SourceScanOptions = {},
): string[] {
  const paths = presentProjectFiles(projectRoot)
    .filter((file) => eligibleMaintenanceFile(file, opts.includeTests))
    .sort();
  const problems: string[] = [];
  if (
    paths.length !== snapshot.eligibleFiles ||
    paths.slice(0, opts.maxFiles ?? SOURCE_SCAN_DEFAULTS.maxFiles).some((file) => !snapshot.files.has(file))
  ) {
    problems.push('Eligible source file set changed or was incomplete during analysis; rerun after edits settle.');
  }
  for (const [file, content] of snapshot.files) {
    try {
      if (
        readProjectFile(projectRoot, file, {
          maxBytes: opts.maxFileBytes ?? SOURCE_SCAN_DEFAULTS.maxFileBytes,
        }).toString('utf8') !== content
      ) {
        problems.push(`${file}: source changed during analysis; rerun after edits settle.`);
      }
    } catch {
      problems.push(`${file}: source unavailable during final freshness check.`);
    }
  }
  return problems;
}

function collectSnapshot(
  revision: string,
  paths: string[],
  opts: SourceScanOptions,
  read: (file: string) => string,
): SourceSnapshot {
  const eligible = paths.filter((file) => eligibleMaintenanceFile(file, opts.includeTests)).sort();
  const files = new Map<string, string>();
  const problems: string[] = [];
  const selected = eligible.slice(0, opts.maxFiles ?? SOURCE_SCAN_DEFAULTS.maxFiles);
  if (selected.length < eligible.length)
    problems.push(
      `${eligible.length - selected.length} eligible files omitted by max-files; increase --max-files to cover them.`,
    );
  let bytes = 0;
  for (const file of selected) {
    try {
      const content = read(file);
      bytes += Buffer.byteLength(content);
      if (bytes > MAX_SNAPSHOT_BYTES) {
        problems.push(
          `Snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes; ${selected.length - files.size} remaining files omitted.`,
        );
        break;
      }
      files.set(file, content);
    } catch (error) {
      problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    revision,
    files,
    fingerprint: sourceHash(
      [...files].map(([file, content]) => `${JSON.stringify(file)}:${sourceHash(content)}`).join('\n'),
    ),
    eligibleFiles: eligible.length,
    excludedFiles: paths.length - eligible.length,
    problems,
  };
}

function git(projectRoot: string, args: string[], input?: string): Buffer {
  return execFileSync('git', args, {
    cwd: projectRoot,
    input,
    maxBuffer: MAX_SNAPSHOT_BYTES,
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function presentProjectFiles(projectRoot: string): string[] {
  return listProjectFiles(projectRoot).filter((file) => {
    try {
      return projectFileExists(projectRoot, file);
    } catch {
      return true;
    } // Retain unsafe/unreadable paths so the scan reports their omissions.
  });
}
