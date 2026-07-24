import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { SupportedLanguage, IndexerConfig } from '../domain/types.js';
import { RUST_ANALYZER_TOOLCHAIN } from '../platform/indexer-toolchain.js';

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
    indexArgs: ({ outputPath, pnpmWorkspaces, indexerBinary, projectPath }) => {
      const args = projectPath
        ? ['index', '--output', outputPath, '--no-progress-bar', projectPath]
        : ['index', '--infer-tsconfig', '--output', outputPath, '--no-progress-bar'];
      if (pnpmWorkspaces && !projectPath) args.splice(1, 0, '--pnpm-workspaces');
      return { binary: indexerBinary, args };
    },
    markerFiles: ['tsconfig.json'],
    installMethods: [
      { label: 'npm', prerequisite: 'npm', binary: 'npm', args: ['install', '-g', '@sourcegraph/scip-typescript'] },
    ],
    installUrl: 'https://github.com/sourcegraph/scip-typescript',
    bundledNpmPackage: '@sourcegraph/scip-typescript',
  },

  javascript: {
    language: 'javascript',
    indexerBinary: 'scip-typescript',
    checkCommand: 'npx scip-typescript --version',
    indexArgs: ({ outputPath, indexerBinary }) => ({
      binary: indexerBinary,
      args: ['index', '--infer-tsconfig', '--output', outputPath, '--no-progress-bar'],
    }),
    markerFiles: ['package.json'],
    installMethods: [
      { label: 'npm', prerequisite: 'npm', binary: 'npm', args: ['install', '-g', '@sourcegraph/scip-typescript'] },
    ],
    installUrl: 'https://github.com/sourcegraph/scip-typescript',
    bundledNpmPackage: '@sourcegraph/scip-typescript',
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
    installMethods: [],
    installUrl: 'https://github.com/sourcegraph/scip-java/releases',
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
    installMethods: [],
    installUrl: 'https://github.com/sourcegraph/scip-java/releases',
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
    installMethods: [],
    installUrl: 'https://github.com/sourcegraph/scip-java/releases',
  },

  rust: {
    language: RUST_ANALYZER_TOOLCHAIN.language,
    indexerBinary: RUST_ANALYZER_TOOLCHAIN.indexerBinary,
    checkCommand: `${RUST_ANALYZER_TOOLCHAIN.indexerBinary} --version`,
    indexArgs: ({ outputPath }) => ({
      binary: RUST_ANALYZER_TOOLCHAIN.indexerBinary,
      args: ['scip', '.', '--output', outputPath],
    }),
    markerFiles: ['Cargo.toml'],
    installMethods: [
      { label: 'rustup', prerequisite: 'rustup', binary: 'rustup', args: ['component', 'add', 'rust-analyzer'] },
    ],
    installUrl: RUST_ANALYZER_TOOLCHAIN.installUrl,
  },

  python: {
    language: 'python',
    indexerBinary: 'scip-python-plus',
    binaryAliases: ['scip-python'],
    checkCommand: 'scip-python-plus --version',
    indexArgs: ({ outputPath, indexerBinary }) => ({
      binary: indexerBinary,
      args: ['index', '--output', outputPath, '--project-name', 'project'],
    }),
    markerFiles: ['pyproject.toml', 'setup.py'],
    installMethods: [{ label: 'npm', prerequisite: 'npm', binary: 'npm', args: ['install', '-g', 'scip-python-plus'] }],
    installUrl: 'https://github.com/PlunderStruck/scip-python',
    bundledNpmPackage: 'scip-python-plus',
  },

  clojure: {
    language: 'clojure',
    indexerBinary: 'scip-clojure',
    projectLocalBinaries: ['node_modules/.bin/scip-clojure'],
    checkCommand: 'scip-clojure -h',
    indexArgs: ({ projectRoot, outputPath, indexerBinary, configPath }) => {
      const args = ['-root', projectRoot, '-output', outputPath];
      if (configPath) {
        args.push('-config', isAbsolute(configPath) ? configPath : resolve(projectRoot, configPath));
      }
      return { binary: indexerBinary, args };
    },
    markerFiles: ['deps.edn', 'project.clj', 'bb.edn', 'shadow-cljs.edn'],
    installMethods: [],
    installUrl: 'https://github.com/PlunderStruck/scip-clojure',
  },

  ruby: {
    language: 'ruby',
    indexerBinary: 'scip-ruby',
    checkCommand: 'scip-ruby --version',
    indexArgs: ({ indexerBinary }) => ({
      binary: indexerBinary,
      args: ['--dir', '.'],
    }),
    defaultOutputPath: 'index.scip',
    markerFiles: ['Gemfile'],
    installMethods: [],
    installUrl: 'https://github.com/sourcegraph/scip-ruby/releases',
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
    installMethods: [
      {
        label: 'go install',
        prerequisite: 'go',
        binary: 'go',
        args: ['install', 'github.com/sourcegraph/scip-go@latest'],
      },
    ],
    installUrl: 'https://github.com/sourcegraph/scip-go',
  },

  cpp: {
    language: 'cpp',
    indexerBinary: 'scip-clang',
    checkCommand: 'scip-clang --version',
    indexArgs: ({ outputPath }) => ({
      binary: 'scip-clang',
      args: ['--compdb-path', 'compile_commands.json', '--index-output-path', outputPath],
    }),
    markerFiles: ['CMakeLists.txt', 'Makefile'],
    installMethods: [],
    installUrl: 'https://github.com/sourcegraph/scip-clang/releases',
  },

  c: {
    language: 'c',
    indexerBinary: 'scip-clang',
    checkCommand: 'scip-clang --version',
    indexArgs: ({ outputPath }) => ({
      binary: 'scip-clang',
      args: ['--compdb-path', 'compile_commands.json', '--index-output-path', outputPath],
    }),
    markerFiles: ['CMakeLists.txt', 'Makefile'],
    installMethods: [],
    installUrl: 'https://github.com/sourcegraph/scip-clang/releases',
  },

  csharp: {
    language: 'csharp',
    indexerBinary: 'scip-dotnet',
    checkCommand: 'scip-dotnet --version',
    indexArgs: ({ projectRoot, outputPath }) => ({
      binary: 'scip-dotnet',
      args: [
        'index',
        resolveDotnetProject(projectRoot, ['.sln', '.csproj']) ?? projectRoot,
        '--output',
        outputPath,
        '--working-directory',
        projectRoot,
      ],
    }),
    markerFiles: ['*.csproj', '*.sln'],
    installMethods: [
      {
        label: 'dotnet',
        prerequisite: 'dotnet',
        binary: 'dotnet',
        args: ['tool', 'install', '--global', 'scip-dotnet'],
      },
    ],
    installUrl: 'https://github.com/sourcegraph/scip-dotnet/releases',
  },

  vb: {
    language: 'vb',
    indexerBinary: 'scip-dotnet',
    checkCommand: 'scip-dotnet --version',
    indexArgs: ({ projectRoot, outputPath }) => ({
      binary: 'scip-dotnet',
      args: [
        'index',
        resolveDotnetProject(projectRoot, ['.sln', '.vbproj']) ?? projectRoot,
        '--output',
        outputPath,
        '--working-directory',
        projectRoot,
      ],
    }),
    markerFiles: ['*.vbproj', '*.sln'],
    installMethods: [
      {
        label: 'dotnet',
        prerequisite: 'dotnet',
        binary: 'dotnet',
        args: ['tool', 'install', '--global', 'scip-dotnet'],
      },
    ],
    installUrl: 'https://github.com/sourcegraph/scip-dotnet/releases',
  },

  dart: {
    language: 'dart',
    indexerBinary: 'scip-dart',
    checkCommand: 'scip-dart --version',
    indexArgs: ({ indexerBinary, outputPath }) => ({
      binary: indexerBinary,
      args: ['--output', outputPath],
    }),
    markerFiles: ['pubspec.yaml'],
    installMethods: [
      { label: 'dart pub', prerequisite: 'dart', binary: 'dart', args: ['pub', 'global', 'activate', 'scip_dart'] },
    ],
    installUrl: 'https://github.com/Workiva/scip-dart/releases',
  },

  php: {
    language: 'php',
    indexerBinary: 'scip-php',
    projectLocalBinaries: ['vendor/davidrjenni/scip-php/bin/scip-php', 'vendor/bin/scip-php'],
    checkCommand: 'scip-php --version',
    indexArgs: ({ projectRoot, indexerBinary }) => {
      const localBinary = join(projectRoot, 'vendor', 'bin', 'scip-php');
      const nestedLocalBinary = join(projectRoot, 'vendor', 'davidrjenni', 'scip-php', 'bin', 'scip-php');
      const targetBinary = existsSync(nestedLocalBinary)
        ? nestedLocalBinary
        : existsSync(localBinary)
          ? localBinary
          : indexerBinary;
      return {
        binary: 'php',
        args: ['-d', 'error_reporting=E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED', targetBinary],
      };
    },
    defaultOutputPath: 'index.scip',
    markerFiles: ['composer.json'],
    installMethods: [],
    installUrl: 'https://github.com/davidrjenni/scip-php/releases',
  },
};

/** Get the indexer config for a language */
export function getIndexerConfig(language: SupportedLanguage): IndexerConfig {
  return INDEXER_CONFIGS[language];
}

function resolveDotnetProject(projectRoot: string, suffixes: readonly string[]): string | null {
  let entries: string[];
  try {
    entries = readdirSync(projectRoot);
  } catch {
    return null;
  }

  for (const suffix of suffixes) {
    for (const entry of entries) {
      if (entry.endsWith(suffix)) {
        return join(projectRoot, entry);
      }
    }
  }

  return null;
}
