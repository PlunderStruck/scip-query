import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isLanguageRelevantProjectInputPath, type ProjectFileFingerprint } from '../domain/project-input.js';
import type { SupportedLanguage, TypeScriptProjectMode } from '../domain/types.js';

export interface ProjectInputFingerprint {
  version: 2;
  languages: SupportedLanguage[];
  pnpmWorkspaces: boolean;
  typescriptProjectMode: TypeScriptProjectMode;
  typescriptProjects: string[];
  clojureConfigPath?: string;
  files: ProjectFileFingerprint[];
}

export interface ProjectInputFingerprintOptions {
  pnpmWorkspaces?: boolean;
  typescriptProjectMode?: TypeScriptProjectMode;
  typescriptProjects?: readonly string[];
  clojureConfigPath?: string;
}

/**
 * Dedupe, trim, and sort a `typescript.projects` config list — shared by the
 * fingerprint builder and the freshness check so a re-ordered or
 * whitespace-padded config never registers as a fingerprint change.
 */
export function normalizeTypeScriptProjects(projects: readonly string[] | undefined): string[] {
  return [...new Set((projects ?? []).map((project) => project.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function listProjectFiles(projectRoot: string): string[] {
  return (listGitProjectFiles(projectRoot) ?? listFilesystemProjectFiles(projectRoot))
    .filter((file) => file && !isProjectArtifactPath(file))
    .sort();
}

export function fingerprintProjectFiles(
  projectRoot: string,
  opts: {
    language?: SupportedLanguage;
    markerFiles?: readonly string[];
    includePath?: (relativePath: string) => boolean;
  } = {},
): ProjectFileFingerprint[] {
  const files = listProjectFiles(projectRoot)
    .filter((path) => !opts.language || isLanguageRelevantProjectInputPath(path, opts.language, opts.markerFiles))
    .filter((path) => !opts.includePath || opts.includePath(path));
  const canonicalProjectRoot = realpathSync(projectRoot);
  return files.map((relativePath) => {
    const absPath = join(projectRoot, relativePath);
    try {
      if (lstatSync(absPath).isSymbolicLink()) {
        const targetPath = realpathSync(absPath);
        const relativeTarget = relative(canonicalProjectRoot, targetPath);
        if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
          throw new Error('external symlink');
        }
        const target = readlinkSync(absPath);
        return {
          path: relativePath,
          size: Buffer.byteLength(target),
          hash: createHash('sha256').update('symlink\0').update(target).digest('hex'),
        };
      }
      const data = readFileSync(absPath);
      return {
        path: relativePath,
        size: data.byteLength,
        hash: createHash('sha256').update(data).digest('hex'),
      };
    } catch {
      return {
        path: relativePath,
        size: -1,
        hash: 'unreadable',
      };
    }
  });
}

export function buildProjectInputFingerprint(
  projectRoot: string,
  languages: readonly SupportedLanguage[],
  opts: ProjectInputFingerprintOptions,
): ProjectInputFingerprint {
  return {
    version: 2,
    languages: [...languages].sort(),
    pnpmWorkspaces: opts.typescriptProjectMode !== 'workspace' && opts.pnpmWorkspaces === true,
    typescriptProjectMode: opts.typescriptProjectMode ?? 'single',
    typescriptProjects: normalizeTypeScriptProjects(opts.typescriptProjects),
    clojureConfigPath: normalizeOptionalPath(opts.clojureConfigPath),
    files: fingerprintProjectFiles(projectRoot),
  };
}

function normalizeOptionalPath(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  return trimmed || undefined;
}

function listGitProjectFiles(projectRoot: string): string[] | null {
  try {
    return execFileSync('git', ['-C', projectRoot, 'ls-files', '-co', '--exclude-standard', '--', '.'], {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
}

function listFilesystemProjectFiles(projectRoot: string): string[] {
  const files: string[] = [];
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const absDir = relDir ? join(projectRoot, relDir) : projectRoot;
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relativePath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!isProjectArtifactPath(relativePath)) {
          stack.push(relativePath);
        }
        continue;
      }
      files.push(relativePath);
    }
  }
  return files;
}

function isProjectArtifactPath(relativePath: string): boolean {
  const parts = relativePath.split('/');
  return (
    relativePath === 'meta.json' ||
    parts.some((part) => PROJECT_ARTIFACT_DIRS.has(part)) ||
    relativePath.endsWith('.db') ||
    relativePath.endsWith('.db-wal') ||
    relativePath.endsWith('.db-shm') ||
    relativePath.endsWith('.scip')
  );
}

const PROJECT_ARTIFACT_DIRS = new Set([
  '.git',
  'node_modules',
  '.scipquery-cache',
  '.scipquery-generations',
  '.stryker-tmp',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  'target',
]);
