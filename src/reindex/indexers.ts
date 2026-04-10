import type { SupportedLanguage, IndexerConfig } from '../types.js';

/**
 * Indexer configurations for each supported language.
 * Each entry describes how to produce a SCIP index for that language.
 *
 * The `scip` CLI binary is required for all languages (to convert protobuf -> SQLite).
 * Each language also needs its own SCIP indexer installed.
 */
export const INDEXER_CONFIGS: Record<SupportedLanguage, IndexerConfig> = {
  typescript: {
    language: 'typescript',
    indexerBinary: 'scip-typescript',
    checkCommand: 'npx scip-typescript --version',
    indexArgs: ({ outputPath, pnpmWorkspaces }) => {
      const args = ['scip-typescript', 'index', '--infer-tsconfig', '--output', outputPath, '--no-progress-bar'];
      if (pnpmWorkspaces) args.splice(2, 0, '--pnpm-workspaces');
      return { binary: 'npx', args };
    },
    markerFiles: ['tsconfig.json'],
  },

  javascript: {
    language: 'javascript',
    indexerBinary: 'scip-typescript',
    checkCommand: 'npx scip-typescript --version',
    indexArgs: ({ outputPath }) => ({
      binary: 'npx',
      args: ['scip-typescript', 'index', '--infer-tsconfig', '--output', outputPath, '--no-progress-bar'],
    }),
    markerFiles: ['package.json'],
  },

  java: {
    language: 'java',
    indexerBinary: 'scip-java',
    checkCommand: 'scip-java --version',
    indexArgs: ({ outputPath }) => ({
      binary: 'scip-java',
      args: ['index', '--output', outputPath],
    }),
    markerFiles: ['pom.xml', 'build.gradle'],
  },

  scala: {
    language: 'scala',
    indexerBinary: 'scip-java',
    checkCommand: 'scip-java --version',
    indexArgs: ({ outputPath }) => ({
      binary: 'scip-java',
      args: ['index', '--output', outputPath],
    }),
    markerFiles: ['build.sbt'],
  },

  kotlin: {
    language: 'kotlin',
    indexerBinary: 'scip-java',
    checkCommand: 'scip-java --version',
    indexArgs: ({ outputPath }) => ({
      binary: 'scip-java',
      args: ['index', '--output', outputPath],
    }),
    markerFiles: ['build.gradle.kts'],
  },

  rust: {
    language: 'rust',
    indexerBinary: 'rust-analyzer',
    checkCommand: 'rust-analyzer --version',
    indexArgs: ({ outputPath }) => ({
      binary: 'rust-analyzer',
      args: ['scip', '.', '--output', outputPath],
    }),
    markerFiles: ['Cargo.toml'],
  },

  python: {
    language: 'python',
    indexerBinary: 'scip-python',
    checkCommand: 'scip-python --version',
    indexArgs: ({ outputPath }) => ({
      binary: 'scip-python',
      args: ['index', '--output', outputPath, '--project-name', 'project'],
    }),
    markerFiles: ['pyproject.toml', 'setup.py'],
  },

  ruby: {
    language: 'ruby',
    indexerBinary: 'scip-ruby',
    checkCommand: 'scip-ruby --version',
    indexArgs: ({ outputPath }) => ({
      binary: 'scip-ruby',
      args: ['--output', outputPath],
    }),
    markerFiles: ['Gemfile'],
  },

  go: {
    language: 'go',
    indexerBinary: 'scip-go',
    checkCommand: 'scip-go --version',
    indexArgs: ({ outputPath }) => ({
      binary: 'scip-go',
      args: ['--output', outputPath],
    }),
    markerFiles: ['go.mod'],
  },

  cpp: {
    language: 'cpp',
    indexerBinary: 'scip-clang',
    checkCommand: 'scip-clang --version',
    indexArgs: ({ outputPath }) => ({
      binary: 'scip-clang',
      args: ['--output', outputPath],
    }),
    markerFiles: ['CMakeLists.txt', 'Makefile'],
  },

  c: {
    language: 'c',
    indexerBinary: 'scip-clang',
    checkCommand: 'scip-clang --version',
    indexArgs: ({ outputPath }) => ({
      binary: 'scip-clang',
      args: ['--output', outputPath],
    }),
    markerFiles: ['CMakeLists.txt', 'Makefile'],
  },

  csharp: {
    language: 'csharp',
    indexerBinary: 'scip-dotnet',
    checkCommand: 'scip-dotnet --version',
    indexArgs: ({ outputPath }) => ({
      binary: 'scip-dotnet',
      args: ['index', '--output', outputPath],
    }),
    markerFiles: [],
  },

  dart: {
    language: 'dart',
    indexerBinary: 'scip-dart',
    checkCommand: 'scip-dart --version',
    indexArgs: ({ outputPath }) => ({
      binary: 'scip-dart',
      args: ['index', '--output', outputPath],
    }),
    markerFiles: ['pubspec.yaml'],
  },

  php: {
    language: 'php',
    indexerBinary: 'scip-php',
    checkCommand: 'scip-php --version',
    indexArgs: ({ outputPath }) => ({
      binary: 'scip-php',
      args: ['index', '--output', outputPath],
    }),
    markerFiles: ['composer.json'],
  },
};

/** Get the indexer config for a language */
export function getIndexerConfig(language: SupportedLanguage): IndexerConfig {
  return INDEXER_CONFIGS[language];
}
