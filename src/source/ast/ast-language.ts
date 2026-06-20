import { extname } from 'node:path';

// scip-query: ignore-stale — foundational discriminator used by AST helpers,
// framework-patterns, source scans, and parser fallbacks.
export type AstLanguage =
  | 'rust' | 'typescript' | 'tsx' | 'javascript' | 'python'
  | 'java' | 'kotlin' | 'scala' | 'ruby' | 'c' | 'cpp' | 'csharp' | 'php' | 'vb';

const LANGUAGE_BY_EXT: Readonly<Record<string, AstLanguage>> = {
  '.rs': 'rust',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.sc': 'scala',
  '.rb': 'ruby',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.vb': 'vb',
};

export function detectAstLanguage(relativePath: string): AstLanguage | null {
  return LANGUAGE_BY_EXT[extname(relativePath).toLowerCase()] ?? null;
}

export function isVueSfcPath(relativePath: string): boolean {
  return extname(relativePath).toLowerCase() === '.vue';
}
