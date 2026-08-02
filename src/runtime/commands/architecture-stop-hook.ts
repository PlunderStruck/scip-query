import { execFileSync } from 'node:child_process';
import type { ScipDatabase } from '../../storage/db.js';
import { indexedDocumentPaths } from '../../storage/scip-documents.js';
import * as queries from '../../queries/index.js';

export interface ArchitectureStopHookOutput {
  decision?: 'block';
  reason?: string;
}

export interface ArchitectureStopEvaluation {
  kind: 'allow' | 'block';
  checkedSourceFiles: string[];
  findings: string[];
  reason?: string;
}

export interface ArchitectureStopDependencies {
  changedPaths(projectRoot: string): string[];
  indexedPaths(db: ScipDatabase): string[];
  architectureFindings(db: ScipDatabase): string[];
}

const DEFAULT_DEPENDENCIES: ArchitectureStopDependencies = {
  changedPaths: listChangedPaths,
  indexedPaths: (db) => indexedDocumentPaths(db, { includeIgnored: false }),
  architectureFindings: (db) => queries.architectureFindingIdentities(queries.architecture(db)),
};

const SUPPORTED_SOURCE_PATH =
  /\.(?:[cm]?[jt]sx?|vue|java|scala|kt|kts|rs|py|rb|go|c|cc|cpp|cxx|h|hh|hpp|hxx|cs|vb|dart|php|clj|cljs|cljc)$/iu;

/**
 * Enforce only declared architecture policy at the final Stop boundary.
 * The hook stays silent when no indexed source changed.
 */
export function evaluateArchitectureStop(
  projectRoot: string,
  db: ScipDatabase,
  dependencies: ArchitectureStopDependencies = DEFAULT_DEPENDENCIES,
): ArchitectureStopEvaluation {
  const changedPaths = dependencies.changedPaths(projectRoot);
  if (changedPaths.includes('.scipquery.json')) {
    return {
      kind: 'block',
      checkedSourceFiles: [],
      findings: [],
      reason:
        'Architecture policy changed in the same worktree as the implementation. Keep .scipquery.json policy changes in a separate reviewed change, then stop again.',
    };
  }

  const indexedPaths = new Set(dependencies.indexedPaths(db));
  const changedSourceFiles = changedPaths.filter((path) => indexedPaths.has(path) || SUPPORTED_SOURCE_PATH.test(path));
  if (changedSourceFiles.length === 0) {
    return { kind: 'allow', checkedSourceFiles: [], findings: [] };
  }

  const findings = dependencies.architectureFindings(db);
  if (findings.length === 0) {
    return { kind: 'allow', checkedSourceFiles: changedSourceFiles, findings: [] };
  }

  return {
    kind: 'block',
    checkedSourceFiles: changedSourceFiles,
    findings,
    reason:
      `scip-query found ${findings.length} enforced architecture violation(s):\n` +
      `${findings.map((finding) => `- ${finding}`).join('\n')}\n\n` +
      'Inspect the boundary graph with: scip-query architecture',
  };
}

export function renderArchitectureStopOutput(evaluation: ArchitectureStopEvaluation): ArchitectureStopHookOutput {
  return evaluation.kind === 'block' ? { decision: 'block', reason: evaluation.reason } : {};
}

function listChangedPaths(projectRoot: string): string[] {
  const tracked = gitLines(projectRoot, ['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD', '--']);
  const untracked = gitLines(projectRoot, ['ls-files', '--others', '--exclude-standard', '--']);
  return [...new Set([...tracked, ...untracked])].sort();
}

function gitLines(projectRoot: string, args: string[]): string[] {
  try {
    return execFileSync('git', ['-C', projectRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
      killSignal: 'SIGKILL',
    })
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    throw new Error(`Could not inspect changed files for the architecture Stop hook: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
