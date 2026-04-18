import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { tryInstallScipCli } from '../scip-cli.js';
import type { SupportedLanguage, IndexerConfig } from '../types.js';
import { detectLanguages } from './detect.js';
import { getIndexerConfig } from './indexers.js';
import { mergeScipFiles } from './merge.js';
import {
  describeIndexerBinary,
  getIndexerExecutionEnv,
  isBinaryAvailable,
  isIndexerInstalled,
  resolveIndexerBinary,
  resolveProjectLocalIndexerBinary,
  tryInstallIndexer,
} from './install.js';

export interface ReindexOptions {
  projectRoot: string;
  /** Override language detection — index only these languages */
  languages?: SupportedLanguage[];
  /** Path for the SCIP protobuf output (default: <projectRoot>/index.scip) */
  outputScip?: string;
  /** Path for the SQLite output (default: <projectRoot>/index.db) */
  outputDb?: string;
  /** Max Node.js heap size in MB (default: 8192) */
  maxHeapMb?: number;
  /** Callback for status updates */
  onStatus?: (message: string) => void;
  /** Extra flags for pnpm-workspace-aware TS indexing */
  pnpmWorkspaces?: boolean;
  /** Skip auto-install prompts */
  skipAutoInstall?: boolean;
}

export interface ReindexResult {
  languages: SupportedLanguage[];
  indexPath: string;
  dbPath: string;
  durationMs: number;
}

/**
 * Reindex a project: detect languages, run the appropriate SCIP indexer(s),
 * and convert the output to SQLite.
 */
export async function reindex(opts: ReindexOptions): Promise<ReindexResult> {
  const {
    projectRoot,
    maxHeapMb = 8192,
    onStatus = console.log,
    skipAutoInstall = false,
  } = opts;

  const outputScip = opts.outputScip ?? join(projectRoot, 'index.scip');
  const outputDb = opts.outputDb ?? join(projectRoot, 'index.db');
  const start = Date.now();

  // Detect or use provided languages
  const languages = opts.languages ?? detectLanguages(projectRoot);
  if (languages.length === 0) {
    throw new Error(
      'No supported languages detected in this project. ' +
      'Looked for: tsconfig.json, Cargo.toml, go.mod, pyproject.toml, etc.',
    );
  }

  onStatus(`Detected languages: ${languages.join(', ')}`);

  // Check that the scip CLI is available, auto-install if needed
  if (!isBinaryAvailable('scip')) {
    if (skipAutoInstall) {
      throw new Error(
        'The scip CLI is required but not found on PATH.\n' +
        'Install from: https://github.com/sourcegraph/scip/releases',
      );
    }
    onStatus('scip CLI not found on PATH. Attempting auto-install...');
    if (!tryInstallScipCli(onStatus)) {
      throw new Error(
        'The scip CLI is required but could not be installed.\n' +
        'Install manually from: https://github.com/sourcegraph/scip/releases',
      );
    }
  }

  const env = {
    ...process.env,
    NODE_OPTIONS: `--max-old-space-size=${maxHeapMb}`,
  };

  const languageOutputs = languages.map((language, index) => ({
    language,
    scipPath: languages.length > 1
      ? tempScipPath(outputScip, language, index)
      : outputScip,
  }));

  // Index each language
  for (const { language: lang, scipPath } of languageOutputs) {
    const config = getIndexerConfig(lang);
    const binaryLabel = describeIndexerBinary(config);
    const projectLocalBinary = resolveProjectLocalIndexerBinary(config, projectRoot);

    // Check if indexer is installed, auto-install if needed
    if (!projectLocalBinary && !isIndexerInstalled(config)) {
      if (skipAutoInstall) {
        throw new Error(
          `${binaryLabel} is required to index ${lang} but not found on PATH.\n` +
          (config.installUrl ? `Install from: ${config.installUrl}` : `Make sure ${binaryLabel} is installed and available on PATH.`),
        );
      }
      onStatus(`${binaryLabel} not found. Attempting auto-install...`);
      if (!tryInstallIndexer(config, onStatus)) {
        throw new Error(
          `${binaryLabel} is required to index ${lang} but could not be installed.\n` +
          (config.installUrl ? `Install manually from: ${config.installUrl}` : `Make sure ${binaryLabel} is installed and available on PATH.`),
        );
      }
    }

    const resolvedBinary = projectLocalBinary ?? resolveIndexerBinary(config);
    if (!resolvedBinary) {
      throw new Error(
        `${binaryLabel} is required to index ${lang} but was not found on PATH after installation checks.\n` +
        (config.installUrl ? `Install manually from: ${config.installUrl}` : `Make sure ${binaryLabel} is installed and available on PATH.`),
      );
    }

    onStatus(`Indexing ${lang} with ${resolvedBinary}...`);

    const indexerEnv = getIndexerExecutionEnv(config, env, resolvedBinary);
    const { binary, args } = config.indexArgs({
      projectRoot,
      outputPath: scipPath,
      pnpmWorkspaces: opts.pnpmWorkspaces,
      indexerBinary: resolvedBinary,
    });

    try {
      execFileSync(binary, args, {
        cwd: projectRoot,
        env: indexerEnv,
        stdio: 'pipe',
        maxBuffer: 50 * 1024 * 1024,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to index ${lang} with ${resolvedBinary}: ${msg}\n` +
        `Make sure ${binaryLabel} is installed and available on PATH.`,
        { cause: err },
      );
    }

    moveDefaultOutputIfNeeded(config, projectRoot, scipPath);
  }

  if (languageOutputs.length > 1) {
    onStatus(`Merging ${languageOutputs.length} language indexes...`);
    mergeScipFiles(languageOutputs.map((entry) => entry.scipPath), outputScip);
  }

  // Convert SCIP protobuf to SQLite
  onStatus('Converting to SQLite...');
  if (!existsSync(outputScip)) {
    throw new Error(`SCIP index not found at ${outputScip} after indexing`);
  }

  try {
    execFileSync('scip', ['expt-convert', '--output', outputDb, outputScip], {
      env,
      stdio: 'pipe',
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to convert SCIP index to SQLite: ${msg}`, { cause: err });
  } finally {
    for (const { scipPath } of languageOutputs) {
      if (scipPath !== outputScip) {
        rmSync(scipPath, { force: true });
      }
    }
  }

  const durationMs = Date.now() - start;
  onStatus(`Done in ${(durationMs / 1000).toFixed(1)}s`);

  return { languages, indexPath: outputScip, dbPath: outputDb, durationMs };
}

export { detectLanguages } from './detect.js';
export { getIndexerConfig, INDEXER_CONFIGS } from './indexers.js';
export { mergeScipFiles, mergeScipIndexes } from './merge.js';
export {
  describeIndexerBinary,
  getIndexerExecutionEnv,
  isBinaryAvailable,
  isIndexerInstalled,
  resolveIndexerBinary,
  resolveProjectLocalIndexerBinary,
  tryInstallIndexer,
} from './install.js';
export { tryInstallScipCli } from '../scip-cli.js';

function moveDefaultOutputIfNeeded(
  config: IndexerConfig,
  projectRoot: string,
  outputScip: string,
): void {
  if (!config.defaultOutputPath) {
    return;
  }

  const defaultOutputPath = join(projectRoot, config.defaultOutputPath);
  if (outputScip !== defaultOutputPath && existsSync(defaultOutputPath)) {
    renameSync(defaultOutputPath, outputScip);
  }
}

function tempScipPath(outputScip: string, language: SupportedLanguage, index: number): string {
  const extension = extname(outputScip) || '.scip';
  const stem = basename(outputScip, extension);
  return join(dirname(outputScip), `${stem}.${index + 1}.${language}${extension}`);
}
