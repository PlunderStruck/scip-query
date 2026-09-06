import { execFileSync } from 'node:child_process';
import { listProjectFiles, projectFileExists, readProjectFile } from '../platform/project-files.js';
import { sourceHash } from './ast/function-metrics.js';
import { classifyFile } from './primitives/file-kind.js';
import { maintenanceProject, type MaintenanceProject } from './maintenance-project.js';

export interface SourceSnapshot {
  revision: string;
  files: Map<string, string>;
  fingerprint: string;
  eligibleFiles: number;
  excludedFiles: number;
  exclusions: Record<string, number>;
  project: MaintenanceProject;
  problems: string[];
}

export interface SourceScanOptions {
  includeTests?: boolean;
  includeReferences?: boolean;
  includeGenerated?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
}

export const SOURCE_SCAN_DEFAULTS = { maxFiles: 10000, maxFileBytes: 1024 * 1024 };
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;

export function eligibleMaintenanceFile(file: string, includeTests = false): boolean {
  return maintenanceExclusion(file, { includeTests }) === undefined;
}

export function maintenanceExclusion(file: string, opts: SourceScanOptions = {}): string | undefined {
  if (!/\.[cm]?[jt]sx?$/.test(file)) return 'unsupported-language';
  if (/\.d\.[cm]?ts$/.test(file)) return 'declaration';
  if (/(^|\/)(node_modules|dist|build|coverage|\.git|\.scipquery|\.next|\.nuxt|\.turbo|\.cache)(\/|$)/.test(file))
    return 'managed-output';
  if (!opts.includeGenerated && /(^|\/)(__generated__|generated)(\/|$)/.test(file)) return 'generated';
  if (
    !opts.includeReferences &&
    (/^(docs|agent_docs|\.agents|\.claude|\.codex)\//.test(file) ||
      /(^|\/)(vendor|third_party|third-party)(\/|$)/.test(file))
  )
    return 'reference';
  if (!opts.includeTests && (classifyFile(file) === 'test' || /(^|\/)(fixtures|benchmarks)(\/|$)/.test(file)))
    return 'test';
  return undefined;
}

export function currentSourceSnapshot(projectRoot: string, opts: SourceScanOptions = {}): SourceSnapshot {
  validateScanLimits(opts);
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
  validateScanLimits(opts);
  const revision = gitRevision(projectRoot, base);
  const entries = git(projectRoot, ['ls-tree', '-r', '-z', revision]).toString('utf8').split('\0').filter(Boolean);
  const blobs = new Map<string, string>();
  for (const entry of entries) {
    const match = /^(100\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
    if (match) blobs.set(match[3]!, match[2]!);
  }
  const selected = [...blobs.keys()]
    .filter((file) => !maintenanceExclusion(file, opts))
    .sort()
    .slice(0, opts.maxFiles ?? SOURCE_SCAN_DEFAULTS.maxFiles);
  const contents = new Map<string, string>();
  let retainedBytes = 0;
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
    retainedBytes += output.length;
    if (retainedBytes > MAX_SNAPSHOT_BYTES) break;
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
    if (content !== undefined) return content;
    const blob = blobs.get(file);
    if (file.endsWith('.json') && blob) {
      const size = Number(git(projectRoot, ['cat-file', '-s', blob]).toString('utf8').trim());
      if (size > (opts.maxFileBytes ?? SOURCE_SCAN_DEFAULTS.maxFileBytes))
        throw new Error('configuration exceeds file byte limit');
      return git(projectRoot, ['cat-file', 'blob', blob]).toString('utf8');
    }
    throw new Error('omitted by the Git source snapshot file/total byte limits');
  });
}

export function assertSourceSnapshotCurrent(
  projectRoot: string,
  snapshot: SourceSnapshot,
  opts: SourceScanOptions = {},
): string[] {
  const inventory = presentProjectFiles(projectRoot);
  const paths = inventory.filter((file) => !maintenanceExclusion(file, opts)).sort();
  const problems: string[] = [];
  if (
    paths.length !== snapshot.eligibleFiles ||
    paths.slice(0, opts.maxFiles ?? SOURCE_SCAN_DEFAULTS.maxFiles).some((file) => !snapshot.files.has(file))
  ) {
    problems.push('Eligible source file set changed or was incomplete during analysis; rerun after edits settle.');
  }
  if (
    configurationInventory(inventory).join('\n') !== configurationInventory([...snapshot.project.inventory]).join('\n')
  )
    problems.push('Project configuration file set changed during analysis; rerun after edits settle.');
  for (const [file, content] of [...snapshot.files, ...snapshot.project.inputs]) {
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
  const exclusions: Record<string, number> = {};
  const eligible = paths
    .filter((file) => {
      const reason = maintenanceExclusion(file, opts);
      if (reason) exclusions[reason] = (exclusions[reason] ?? 0) + 1;
      return !reason;
    })
    .sort();
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
  const project = maintenanceProject(paths, eligible, (file) => {
    const content = read(file);
    bytes += Buffer.byteLength(content);
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('source and configuration snapshot exceeds total byte limit');
    return content;
  });

  return {
    revision,
    files,
    fingerprint: sourceHash(
      [...files, ...project.inputs]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, content]) => `${JSON.stringify(file)}:${sourceHash(content)}`)
        .join('\n'),
    ),
    eligibleFiles: eligible.length,
    excludedFiles: paths.length - eligible.length,
    exclusions,
    project,
    problems,
  };
}

function configurationInventory(paths: readonly string[]): string[] {
  return paths.filter((file) => /(^|\/)((ts|js)config[^/]*\.json|package\.json|\.scipquery\.json)$/.test(file)).sort();
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

function validateScanLimits(opts: SourceScanOptions): void {
  for (const key of ['maxFiles', 'maxFileBytes'] as const) {
    const value = opts[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new Error(`${key} must be a positive safe integer.`);
  }
}
