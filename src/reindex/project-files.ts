import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupportedLanguage } from '../domain/types.js';

export interface ProjectFileFingerprint {
  path: string;
  size: number;
  hash: string;
}

export type ProjectInputPathKind = 'source' | 'ambient' | 'config' | 'other';

export function classifyProjectInputPath(
  relativePath: string,
  languages: readonly SupportedLanguage[],
): ProjectInputPathKind {
  const basename = relativePath.split('/').at(-1) ?? relativePath;
  if (
    COMMON_INDEX_INPUTS.has(basename) ||
    basename === '.scipquery.json' ||
    /^tsconfig(?:\..+)?\.json$/.test(basename)
  ) {
    return 'config';
  }
  if (/\.d\.(?:ts|mts|cts)$/.test(relativePath.toLowerCase())) return 'ambient';
  const extension = relativePath.includes('.') ? `.${relativePath.split('.').at(-1)!.toLowerCase()}` : '';
  if (languages.some((language) => (LANGUAGE_SOURCE_EXTENSIONS[language] ?? []).includes(extension))) return 'source';
  return 'other';
}

/**
 * Dedupe, trim, and sort a `typescript.projects` config list — shared by the
 * fingerprint builder (this module's caller in src/reindex/index.ts) and the
 * freshness check (src/runtime/index-freshness.ts) so a re-ordered or
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
    .filter((path) => !opts.language || isLanguageRelevantPath(path, opts.language, opts.markerFiles))
    .filter((path) => !opts.includePath || opts.includePath(path));
  return files.map((relativePath) => {
    const absPath = join(projectRoot, relativePath);
    try {
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

function isLanguageRelevantPath(
  relativePath: string,
  language: SupportedLanguage,
  markerFiles: readonly string[] | undefined,
): boolean {
  const basename = relativePath.split('/').at(-1) ?? relativePath;
  if (markerFiles?.includes(relativePath) || markerFiles?.includes(basename)) return true;
  if (COMMON_INDEX_INPUTS.has(basename)) return true;
  const extension = relativePath.includes('.') ? `.${relativePath.split('.').at(-1)!.toLowerCase()}` : '';
  return (LANGUAGE_SOURCE_EXTENSIONS[language] ?? []).includes(extension);
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
  '.stryker-tmp',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  'target',
]);

const COMMON_INDEX_INPUTS = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'tsconfig.json',
  'tsconfig.base.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'build.sbt',
  'compile_commands.json',
  'CMakeLists.txt',
  'Makefile',
  'Gemfile',
  'Gemfile.lock',
  'composer.json',
  'composer.lock',
  'pubspec.yaml',
  'pubspec.lock',
  'deps.edn',
  'project.clj',
  'bb.edn',
  'shadow-cljs.edn',
]);

const LANGUAGE_SOURCE_EXTENSIONS: Record<SupportedLanguage, readonly string[]> = {
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  java: ['.java'],
  scala: ['.scala'],
  kotlin: ['.kt', '.kts'],
  rust: ['.rs'],
  python: ['.py', '.pyi'],
  ruby: ['.rb'],
  go: ['.go'],
  cpp: ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'],
  c: ['.c', '.h'],
  csharp: ['.cs'],
  vb: ['.vb'],
  dart: ['.dart'],
  php: ['.php'],
  clojure: ['.clj', '.cljs', '.cljc'],
};
