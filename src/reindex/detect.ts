import { existsSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { SupportedLanguage } from '../types.js';

interface LanguageMarker {
  language: SupportedLanguage;
  files?: string[];
  globs?: string[];
  extensions?: string[];
}

const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.idea',
  '.vscode',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'target',
  'bin',
  'obj',
  '.dart_tool',
  '.gradle',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
]);

/**
 * Marker files that indicate a language is present in a project.
 * Ordered roughly by specificity — more specific markers first.
 */
const LANGUAGE_MARKERS: LanguageMarker[] = [
  { language: 'typescript', files: ['tsconfig.json', 'tsconfig.base.json'], extensions: ['.ts', '.tsx', '.mts', '.cts'] },
  { language: 'rust', files: ['Cargo.toml'], extensions: ['.rs'] },
  { language: 'go', files: ['go.mod'], extensions: ['.go'] },
  { language: 'java', files: ['pom.xml', 'build.gradle', 'build.gradle.kts'], extensions: ['.java'] },
  { language: 'kotlin', files: ['build.gradle.kts'], extensions: ['.kt', '.kts'] },
  { language: 'scala', files: ['build.sbt'], extensions: ['.scala'] },
  { language: 'python', files: ['pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile'], extensions: ['.py', '.pyi'] },
  { language: 'ruby', files: ['Gemfile'], extensions: ['.rb'] },
  { language: 'cpp', files: ['compile_commands.json', 'CMakeLists.txt', 'Makefile'], extensions: ['.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'] },
  { language: 'c', files: ['compile_commands.json', 'CMakeLists.txt', 'Makefile'], extensions: ['.c', '.h'] },
  { language: 'csharp', globs: ['*.csproj', '*.sln'], extensions: ['.cs'] },
  { language: 'vb', globs: ['*.vbproj'], extensions: ['.vb'] },
  { language: 'dart', files: ['pubspec.yaml'], extensions: ['.dart'] },
  { language: 'php', files: ['composer.json'], extensions: ['.php'] },
  { language: 'javascript', files: ['package.json'], extensions: ['.js', '.jsx', '.mjs', '.cjs'] }, // Last — very common
];

/**
 * Detect which languages are present in a project directory by checking for
 * marker files, root-level project files, and source-file extensions.
 */
export function detectLanguages(projectRoot: string): SupportedLanguage[] {
  const detected: SupportedLanguage[] = [];
  const rootEntries = safeReadDir(projectRoot);
  const extensionSet = collectExtensions(projectRoot);

  for (const marker of LANGUAGE_MARKERS) {
    if (hasMarkerFile(projectRoot, marker.files)) {
      detected.push(marker.language);
      continue;
    }

    if (matchesRootGlob(rootEntries, marker.globs)) {
      detected.push(marker.language);
      continue;
    }

    if (hasExtension(extensionSet, marker.extensions)) {
      detected.push(marker.language);
    }
  }

  // If we found TypeScript, don't also report JavaScript (it's implied).
  if (detected.includes('typescript')) {
    removeLanguage(detected, 'javascript');
  }

  // Prefer the more specific C++ signal over generic C header-only matches.
  if (detected.includes('cpp') && !extensionSet.has('.c')) {
    removeLanguage(detected, 'c');
  }

  return detected;
}

function safeReadDir(projectRoot: string): string[] {
  try {
    return readdirSync(projectRoot);
  } catch {
    return [];
  }
}

function hasMarkerFile(projectRoot: string, files: readonly string[] | undefined): boolean {
  if (!files?.length) {
    return false;
  }

  return files.some((file) => existsSync(join(projectRoot, file)));
}

function matchesRootGlob(entries: readonly string[], globs: readonly string[] | undefined): boolean {
  if (!globs?.length) {
    return false;
  }

  return entries.some((entry) => globs.some((glob) => matchesSimpleGlob(entry, glob)));
}

function matchesSimpleGlob(entry: string, pattern: string): boolean {
  if (pattern === '*') {
    return true;
  }
  if (!pattern.includes('*')) {
    return entry === pattern;
  }
  const [prefix, suffix] = pattern.split('*');
  return entry.startsWith(prefix ?? '') && entry.endsWith(suffix ?? '');
}

function collectExtensions(projectRoot: string): Set<string> {
  const found = new Set<string>();
  const stack = [projectRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && !entry.name.endsWith('proj') && !entry.name.endsWith('sln')) {
        if (entry.isDirectory()) {
          continue;
        }
      }

      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          stack.push(fullPath);
        }
        continue;
      }

      const extension = extname(entry.name).toLowerCase();
      if (extension) {
        found.add(extension);
      }
    }
  }

  return found;
}

function hasExtension(extensionSet: Set<string>, extensions: readonly string[] | undefined): boolean {
  if (!extensions?.length) {
    return false;
  }

  return extensions.some((extension) => extensionSet.has(extension));
}

function removeLanguage(detected: SupportedLanguage[], language: SupportedLanguage): void {
  const index = detected.indexOf(language);
  if (index !== -1) {
    detected.splice(index, 1);
  }
}
