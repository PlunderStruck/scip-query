import ignore from 'ignore';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Builds a gitignore-based path filter from .gitignore files found
 * in the project directory tree. This replaces hardcoded path exclusions
 * like "node_modules/", "dist/", "target/", "__pycache__/" — instead,
 * we respect whatever the project already ignores.
 *
 * Falls back to sensible defaults if no .gitignore is found.
 */
export function createGitignoreFilter(projectRoot: string): PathFilter {
  const ig = ignore();
  let loaded = false;

  // Walk up from project root looking for .gitignore files
  // (nested .gitignore files apply to their subdirectory)
  const gitignorePaths = findGitignoreFiles(projectRoot);

  for (const gitignorePath of gitignorePaths) {
    try {
      const content = readFileSync(gitignorePath, 'utf-8');
      ig.add(content);
      loaded = true;
    } catch {
      // Skip unreadable files
    }
  }

  // If no .gitignore found, use universal defaults
  if (!loaded) {
    ig.add(DEFAULT_IGNORES);
  }

  return {
    isIgnored: (relativePath: string) => safeIgnores(ig, projectRoot, relativePath),
    filter: (paths: string[]) => paths.filter((p) => !safeIgnores(ig, projectRoot, p)),
  };
}

export interface PathFilter {
  /** Returns true if this path should be excluded from results */
  isIgnored: (relativePath: string) => boolean;
  /** Filter an array of paths, keeping only non-ignored ones */
  filter: (paths: string[]) => string[];
}

/**
 * Find all .gitignore files from project root (including nested ones).
 * We look at the root .gitignore and any in immediate subdirectories
 * but don't recursively walk the entire tree (too expensive for large repos).
 */
function findGitignoreFiles(projectRoot: string): string[] {
  const files: string[] = [];

  // Root .gitignore
  const rootGitignore = join(projectRoot, '.gitignore');
  if (existsSync(rootGitignore)) {
    files.push(rootGitignore);
  }

  // Also check parent directories (for monorepo setups where .gitignore
  // is at the repo root but the project is in a subdirectory)
  let dir = dirname(projectRoot);
  let depth = 0;
  while (dir !== dirname(dir) && depth < 5) {
    const parentGitignore = join(dir, '.gitignore');
    if (existsSync(parentGitignore)) {
      files.push(parentGitignore);
    }
    // Stop if we find a .git directory — that's the repo root
    if (existsSync(join(dir, '.git'))) break;
    dir = dirname(dir);
    depth++;
  }

  return files;
}

/**
 * Universal defaults when no .gitignore exists.
 * Covers build artifacts, dependency directories, and virtual environments
 * across all SCIP-supported languages.
 */
const DEFAULT_IGNORES = `
# Dependencies
node_modules/
vendor/
.bundle/

# Build output
dist/
build/
out/
target/
bin/
obj/

# Python
__pycache__/
*.pyc
*.pyo
.venv/
venv/
.env/
env/
*.egg-info/

# Rust
target/

# Java / Kotlin / Scala
*.class
.gradle/
.mvn/

# C# / .NET
bin/
obj/
packages/

# Go
vendor/

# Dart
.dart_tool/
build/

# PHP
vendor/

# IDE / OS
.idea/
.vscode/
*.swp
*.swo
.DS_Store
Thumbs.db

# Type definitions (often noise in queries)
*.d.ts
`;

function safeIgnores(ig: ReturnType<typeof ignore>, projectRoot: string, inputPath: string): boolean {
  const relativePath = normalizeForIgnore(projectRoot, inputPath);
  if (!relativePath) {
    return false;
  }

  try {
    return ig.ignores(relativePath);
  } catch {
    return false;
  }
}

function normalizeForIgnore(projectRoot: string, inputPath: string): string | null {
  if (!inputPath || inputPath === '.') {
    return null;
  }

  if (!isAbsolute(inputPath) && !inputPath.startsWith('..')) {
    return inputPath.replaceAll('\\', '/');
  }

  const absolutePath = isAbsolute(inputPath)
    ? inputPath
    : resolve(projectRoot, inputPath);
  const relativePath = relative(projectRoot, absolutePath).replaceAll('\\', '/');

  if (!relativePath || relativePath === '.' || relativePath.startsWith('..')) {
    return null;
  }

  return relativePath;
}
