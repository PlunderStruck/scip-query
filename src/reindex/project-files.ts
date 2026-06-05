import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ProjectFileFingerprint {
  path: string;
  size: number;
  hash: string;
}

export function listProjectFiles(projectRoot: string): string[] {
  return (listGitProjectFiles(projectRoot) ?? listFilesystemProjectFiles(projectRoot))
    .filter((file) => file && !isProjectArtifactPath(file))
    .sort();
}

export function fingerprintProjectFiles(projectRoot: string): ProjectFileFingerprint[] {
  return listProjectFiles(projectRoot).map((relativePath) => {
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

function listGitProjectFiles(projectRoot: string): string[] | null {
  try {
    return execFileSync(
      'git',
      ['-C', projectRoot, 'ls-files', '-co', '--exclude-standard', '--', '.'],
      {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).split('\n').filter(Boolean);
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
  return parts.some((part) => PROJECT_ARTIFACT_DIRS.has(part))
    || relativePath.endsWith('.db')
    || relativePath.endsWith('.db-wal')
    || relativePath.endsWith('.db-shm')
    || relativePath.endsWith('.scip');
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
