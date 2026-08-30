import { readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { LANGUAGE_INDEX_MARKERS } from '../domain/project-input.js';
import type { SupportedLanguage, IndexerConfig } from '../domain/types.js';
import { RUST_ANALYZER_TOOLCHAIN } from '../platform/indexer-toolchain.js';

const SCIP_TYPESCRIPT_PACKAGE = '@sourcegraph/scip-typescript@0.4.0';
const SCIP_PYTHON_PACKAGE = 'scip-python-plus@0.7.5';
const SCIP_GO_PACKAGE = 'github.com/sourcegraph/scip-go@v0.2.7';
const SCIP_DOTNET_PACKAGE = 'scip-dotnet@0.2.14';
const SCIP_DART_PACKAGE = 'scip_dart@1.6.2';

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
      if (projectPath) {
        return {
          binary: indexerBinary,
          args: ['index', '--output', outputPath, '--no-progress-bar', '--no-global-caches', projectPath],
        };
      }
      if (pnpmWorkspaces) {
        return {
          binary: indexerBinary,
          args: ['index', '--pnpm-workspaces', '--output', outputPath, '--no-progress-bar', '--no-global-caches'],
        };
      }
      return {
        binary: indexerBinary,
        args: ['index', '--output', outputPath, '--no-progress-bar', '--no-global-caches'],
      };
    },
    markerFiles: [...LANGUAGE_INDEX_MARKERS.typescript],
    installMethods: [
      {
        label: 'npm',
        identity: SCIP_TYPESCRIPT_PACKAGE,
        destination: 'npm global prefix',
        prerequisite: 'npm',
        binary: 'npm',
        args: ['install', '-g', SCIP_TYPESCRIPT_PACKAGE],
      },
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
      args: ['index', '--output', outputPath, '--no-progress-bar', '--no-global-caches'],
    }),
    markerFiles: [...LANGUAGE_INDEX_MARKERS.javascript],
    installMethods: [
      {
        label: 'npm',
        identity: SCIP_TYPESCRIPT_PACKAGE,
        destination: 'npm global prefix',
        prerequisite: 'npm',
        binary: 'npm',
        args: ['install', '-g', SCIP_TYPESCRIPT_PACKAGE],
      },
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
    markerFiles: [...LANGUAGE_INDEX_MARKERS.java],
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
    markerFiles: [...LANGUAGE_INDEX_MARKERS.scala],
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
    markerFiles: [...LANGUAGE_INDEX_MARKERS.kotlin],
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
    markerFiles: [...LANGUAGE_INDEX_MARKERS.rust],
    installMethods: [],
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
    markerFiles: [...LANGUAGE_INDEX_MARKERS.python],
    installMethods: [
      {
        label: 'npm',
        identity: SCIP_PYTHON_PACKAGE,
        destination: 'npm global prefix',
        prerequisite: 'npm',
        binary: 'npm',
        args: ['install', '-g', SCIP_PYTHON_PACKAGE],
      },
    ],
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
    markerFiles: [...LANGUAGE_INDEX_MARKERS.clojure],
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
    markerFiles: [...LANGUAGE_INDEX_MARKERS.ruby],
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
    markerFiles: [...LANGUAGE_INDEX_MARKERS.go],
    installMethods: [
      {
        label: 'go install',
        identity: SCIP_GO_PACKAGE,
        destination: 'Go bin directory (GOBIN or GOPATH/bin)',
        prerequisite: 'go',
        binary: 'go',
        args: ['install', SCIP_GO_PACKAGE],
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
    markerFiles: [...LANGUAGE_INDEX_MARKERS.cpp],
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
    markerFiles: [...LANGUAGE_INDEX_MARKERS.c],
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
    markerFiles: [...LANGUAGE_INDEX_MARKERS.csharp],
    installMethods: [
      {
        label: 'dotnet',
        identity: SCIP_DOTNET_PACKAGE,
        destination: 'dotnet global tool directory',
        prerequisite: 'dotnet',
        binary: 'dotnet',
        args: ['tool', 'install', '--global', 'scip-dotnet', '--version', '0.2.14'],
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
    markerFiles: [...LANGUAGE_INDEX_MARKERS.vb],
    installMethods: [
      {
        label: 'dotnet',
        identity: SCIP_DOTNET_PACKAGE,
        destination: 'dotnet global tool directory',
        prerequisite: 'dotnet',
        binary: 'dotnet',
        args: ['tool', 'install', '--global', 'scip-dotnet', '--version', '0.2.14'],
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
    markerFiles: [...LANGUAGE_INDEX_MARKERS.dart],
    installMethods: [
      {
        label: 'dart pub',
        identity: SCIP_DART_PACKAGE,
        destination: 'Dart pub global cache',
        prerequisite: 'dart',
        binary: 'dart',
        args: ['pub', 'global', 'activate', 'scip_dart', '1.6.2'],
      },
    ],
    installUrl: 'https://github.com/Workiva/scip-dart/releases',
  },

  php: {
    language: 'php',
    indexerBinary: 'scip-php',
    projectLocalBinaries: ['vendor/davidrjenni/scip-php/bin/scip-php', 'vendor/bin/scip-php'],
    checkCommand: 'scip-php --version',
    indexArgs: ({ indexerBinary }) =>
      isAbsolute(indexerBinary)
        ? {
            binary: 'php',
            args: ['-d', 'error_reporting=E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED', indexerBinary],
          }
        : { binary: indexerBinary, args: [] },
    defaultOutputPath: 'index.scip',
    markerFiles: [...LANGUAGE_INDEX_MARKERS.php],
    installMethods: [],
    installUrl: 'https://github.com/davidrjenni/scip-php/releases',
  },
};

export function temporaryRootConfigContent(opts: {
  language: SupportedLanguage;
  projectPath?: string;
  pnpmWorkspaces?: boolean;
}): string | undefined {
  if (opts.projectPath || opts.pnpmWorkspaces) return undefined;
  if (opts.language === 'typescript') return '{}';
  if (opts.language === 'javascript') return '{"compilerOptions":{"allowJs":true}}';
  return undefined;
}

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
