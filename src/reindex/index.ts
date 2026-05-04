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
  /** Languages that were successfully indexed. */
  languages: SupportedLanguage[];
  indexPath: string;
  dbPath: string;
  durationMs: number;
  /**
   * Languages detected in the project but skipped because their indexer
   * could not be located, installed, or run. Each entry includes the reason.
   */
  skipped: { language: SupportedLanguage; reason: string }[];
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

  // Track which languages actually produced an index so we only merge those.
  const indexedOutputs: { language: SupportedLanguage; scipPath: string }[] = [];
  const skippedLanguages: { language: SupportedLanguage; reason: string }[] = [];

  // Index each language. Failures for one language don't stop the rest:
  // we want users on minimal environments to still get partial coverage
  // (e.g. TS+Python work even when rust-analyzer isn't installed).
  for (const { language: lang, scipPath } of languageOutputs) {
    const config = getIndexerConfig(lang);
    const binaryLabel = describeIndexerBinary(config);
    const projectLocalBinary = resolveProjectLocalIndexerBinary(config, projectRoot);

    // Check if indexer is installed, auto-install if needed
    if (!projectLocalBinary && !isIndexerInstalled(config)) {
      if (skipAutoInstall) {
        const reason = `${binaryLabel} not found on PATH (auto-install disabled). ${config.installUrl ?? ''}`.trim();
        onStatus(`Skipping ${lang}: ${reason}`);
        skippedLanguages.push({ language: lang, reason });
        continue;
      }
      onStatus(`${binaryLabel} not found. Attempting auto-install...`);
      if (!tryInstallIndexer(config, onStatus)) {
        const reason = `${binaryLabel} could not be auto-installed. ${config.installUrl ? `Install manually from ${config.installUrl}` : `Install ${binaryLabel} and put it on PATH.`}`;
        onStatus(`Skipping ${lang}: ${reason}`);
        skippedLanguages.push({ language: lang, reason });
        continue;
      }
    }

    const resolvedBinary = projectLocalBinary ?? resolveIndexerBinary(config);
    if (!resolvedBinary) {
      const reason = `${binaryLabel} was not found after installation checks.`;
      onStatus(`Skipping ${lang}: ${reason}`);
      skippedLanguages.push({ language: lang, reason });
      continue;
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
      const reason = `${resolvedBinary} indexer failed: ${msg.split('\n')[0]}`;
      onStatus(`Skipping ${lang}: ${reason}`);
      skippedLanguages.push({ language: lang, reason });
      continue;
    }

    moveDefaultOutputIfNeeded(config, projectRoot, scipPath);
    indexedOutputs.push({ language: lang, scipPath });
  }

  if (indexedOutputs.length === 0) {
    const detail = skippedLanguages.map((s) => `  - ${s.language}: ${s.reason}`).join('\n');
    throw new Error(
      'No language indexers ran successfully. Install at least one indexer for the languages in this project.\n' +
      detail,
    );
  }

  if (skippedLanguages.length > 0) {
    onStatus(`Indexed ${indexedOutputs.length} of ${languages.length} languages; skipped ${skippedLanguages.map((s) => s.language).join(', ')}.`);
  }

  // Multi-language project where multiple indexers ran: merge per-language
  // SCIP files into one. Single-language path already wrote directly to
  // outputScip. If only one of N expected indexers actually ran, treat its
  // output as the single SCIP and rename if necessary.
  if (languages.length > 1) {
    if (indexedOutputs.length > 1) {
      onStatus(`Merging ${indexedOutputs.length} language indexes...`);
      mergeScipFiles(indexedOutputs.map((entry) => entry.scipPath), outputScip);
    } else if (indexedOutputs[0]!.scipPath !== outputScip) {
      // Exactly one language indexed in a multi-lang project — promote its
      // temp file to outputScip so the convert step finds it.
      renameSync(indexedOutputs[0]!.scipPath, outputScip);
    }
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

  return {
    languages: indexedOutputs.map((o) => o.language),
    indexPath: outputScip,
    dbPath: outputDb,
    durationMs,
    skipped: skippedLanguages,
  };
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
