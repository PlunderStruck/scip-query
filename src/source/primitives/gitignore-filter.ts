import ignore from 'ignore';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readTextFileWithinLimit, SMALL_ARTIFACT_MAX_BYTES } from '../../platform/bounded-file.js';

/**
 * Builds a gitignore-based path filter from .gitignore files found
 * in the project directory tree. This replaces hardcoded path exclusions
 * like "node_modules/", "dist/", "target/", "__pycache__/" — instead,
 * we respect whatever the project already ignores.
 *
 * Falls back to sensible defaults if no .gitignore is found.
 */
// scip-query: ignore-extract — this builds the project gitignore predicate:
// root discovery, ignore-file parsing, safe fallback handling, and normalized
// relative paths are one boundary policy.
export function createGitignoreFilter(projectRoot: string): PathFilter {
  const ig = ignore();
  const loaded = loadGitignoreFiles(projectRoot, ig);

  // If no .gitignore found, use universal defaults
  if (!loaded) {
    ig.add(DEFAULT_IGNORES);
  }

  return {
    isIgnored: (relativePath: string) => safeIgnores(ig, projectRoot, relativePath),
    filter: (paths: string[]) => paths.filter((p) => !safeIgnores(ig, projectRoot, p)),
  };
}

// scip-query: ignore-stale — public return type of createGitignoreFilter and
// passed across many call sites as the ScipDatabase.gitignore field; the
// 1-consumer count is the type's own file (it's the canonical PathFilter shape).
export interface PathFilter {
  /** Returns true if this path should be excluded from results */
  isIgnored: (relativePath: string) => boolean;
  /** Filter an array of paths, keeping only non-ignored ones */
  filter: (paths: string[]) => string[];
}

/**
 * Load .gitignore files above and below the project root. Ancestor ignore
 * files are added as-is; nested ignore files are prefixed so their rules apply
 * relative to the directory that owns the file, matching git's interpretation.
 */
function loadGitignoreFiles(projectRoot: string, ig: ReturnType<typeof ignore>): boolean {
  const loaded = new Set<string>();

  const addGitignore = (gitignorePath: string, relativeDir: string): void => {
    if (loaded.has(gitignorePath) || !existsSync(gitignorePath)) return;
    try {
      const content = readTextFileWithinLimit(gitignorePath, {
        maxBytes: SMALL_ARTIFACT_MAX_BYTES,
        inputKind: 'gitignore file',
      });
      ig.add(relativeDir ? prefixGitignorePatterns(content, relativeDir) : content);
      loaded.add(gitignorePath);
    } catch {
      // Skip unreadable files.
    }
  };

  // Also check parent directories (for monorepo setups where .gitignore
  // is at the repo root but the project is in a subdirectory)
  let dir = dirname(projectRoot);
  let depth = 0;
  while (dir !== dirname(dir) && depth < 5) {
    addGitignore(join(dir, '.gitignore'), '');
    // Stop if we find a .git directory — that's the repo root
    if (existsSync(join(dir, '.git'))) break;
    dir = dirname(dir);
    depth++;
  }

  walkProjectGitignores(projectRoot, '', ig, addGitignore);
  return loaded.size > 0;
}

function walkProjectGitignores(
  projectRoot: string,
  relativeDir: string,
  ig: ReturnType<typeof ignore>,
  addGitignore: (gitignorePath: string, relativeDir: string) => void,
): void {
  const absoluteDir = relativeDir ? join(projectRoot, relativeDir) : projectRoot;
  addGitignore(join(absoluteDir, '.gitignore'), relativeDir);

  let entries;
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git') continue;
    const childRelative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (safeIgnores(ig, projectRoot, `${childRelative}/`)) continue;
    walkProjectGitignores(projectRoot, childRelative, ig, addGitignore);
  }
}

function prefixGitignorePatterns(content: string, relativeDir: string): string {
  const prefix = relativeDir.replaceAll('\\', '/').replace(/\/+$/, '');
  return content
    .split(/\r?\n/)
    .map((line) => prefixGitignorePattern(line, prefix))
    .join('\n');
}

function prefixGitignorePattern(line: string, prefix: string): string {
  const trimmedLeft = line.trimStart();
  if (!trimmedLeft || trimmedLeft.startsWith('#')) return line;
  const indent = line.slice(0, line.length - trimmedLeft.length);
  const negated = trimmedLeft.startsWith('!');
  const pattern = negated ? trimmedLeft.slice(1) : trimmedLeft;
  if (!pattern || pattern.startsWith('#')) return line;

  const anchored = pattern.startsWith('/');
  const body = anchored ? pattern.slice(1) : pattern;
  const directoryOnly = body.endsWith('/');
  const significantBody = directoryOnly ? body.slice(0, -1) : body;
  const prefixed = significantBody.includes('/') || anchored ? `${prefix}/${body}` : `${prefix}/**/${body}`;
  return `${indent}${negated ? '!' : ''}${prefixed}`;
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

  const absolutePath = isAbsolute(inputPath) ? inputPath : resolve(projectRoot, inputPath);
  const relativePath = relative(projectRoot, absolutePath).replaceAll('\\', '/');

  if (!relativePath || relativePath === '.' || relativePath.startsWith('..')) {
    return null;
  }

  return relativePath;
}
