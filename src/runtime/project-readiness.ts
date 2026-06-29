import { execFileSync } from 'node:child_process';
import type { ProjectConfig, SupportedLanguage } from '../domain/types.js';
import { detectLanguages } from '../reindex/detect.js';
import { getIndexerConfig } from '../reindex/indexers.js';
import { getIndexerDependencyStatus } from '../reindex/install.js';
import { getTypeScriptSemanticStatus } from '../semantic/typescript/status.js';
import { detectCheckers } from './cleanup-verify.js';

export interface LanguageReadiness {
  language: SupportedLanguage;
  binaryLabel: string;
  installed: boolean;
  runnable: boolean;
  resolvedBinary?: string;
  note?: string;
  installUrl?: string;
}

export interface SemanticReadiness {
  language: 'typescript';
  available: boolean;
  dependencyAvailable: boolean;
  tsconfigPath?: string;
  tsconfigPaths?: string[];
  reason?: string;
}

// scip-query: ignore-stale — readiness is the named handoff from project
// probing to status, doctor, and capability-matrix rendering; structural
// ReturnType consumers otherwise hide that boundary from the detector.
export interface ProjectReadiness {
  languages: SupportedLanguage[];
  indexers: LanguageReadiness[];
  semantic?: SemanticReadiness;
  checkers: Array<{ label: string; coversExtensions: string[] }>;
  gitAvailable: boolean;
}

export type CapabilityStatus = 'available' | 'partial' | 'unavailable';
export type CapabilityEvidence = 'graph-fact' | 'semantic' | 'heuristic' | 'compiler' | 'git';

export interface ProjectCapability {
  id: string;
  label: string;
  status: CapabilityStatus;
  evidence: CapabilityEvidence;
  reason: string;
}

export interface LanguageCapability {
  language: SupportedLanguage;
  indexing: ProjectCapability;
  sourceFacts: ProjectCapability;
  semantic: ProjectCapability;
  detectors: ProjectCapability;
  cleanupVerification: ProjectCapability;
}

export interface ProjectCapabilityReport {
  languages: SupportedLanguage[];
  capabilities: ProjectCapability[];
  matrix: LanguageCapability[];
}

const LANGUAGE_EXTENSIONS: Record<SupportedLanguage, string[]> = {
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  javascript: ['.js', '.jsx', '.vue'],
  java: ['.java'],
  scala: ['.scala'],
  kotlin: ['.kt', '.kts'],
  rust: ['.rs'],
  python: ['.py', '.pyi'],
  ruby: ['.rb'],
  go: ['.go'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
  c: ['.c', '.h'],
  csharp: ['.cs'],
  vb: ['.vb'],
  dart: ['.dart'],
  php: ['.php'],
  clojure: ['.clj', '.cljs', '.cljc'],
};

const SOURCE_FACT_SUPPORT: Record<SupportedLanguage, { status: CapabilityStatus; reason: string }> = {
  typescript: {
    status: 'available',
    reason: 'AST/source fallback covers TypeScript imports, references, and source-backed evidence.',
  },
  javascript: { status: 'available', reason: 'AST/source fallback covers JavaScript, JSX, and Vue script evidence.' },
  java: { status: 'available', reason: 'AST-dispatched source fallback covers Java imports.' },
  scala: { status: 'available', reason: 'AST-dispatched source fallback covers Scala imports.' },
  kotlin: { status: 'available', reason: 'AST-dispatched source fallback covers Kotlin imports.' },
  rust: { status: 'available', reason: 'AST/source fallback covers Rust imports and exports.' },
  python: { status: 'available', reason: 'AST/source fallback covers Python imports.' },
  ruby: { status: 'available', reason: 'AST/source fallback covers Ruby imports.' },
  go: { status: 'unavailable', reason: 'No Go source-fallback adapter is registered; Go relies on SCIP graph facts.' },
  cpp: { status: 'available', reason: 'AST/source fallback covers C++ includes.' },
  c: { status: 'available', reason: 'AST/source fallback covers C includes.' },
  csharp: { status: 'available', reason: 'AST-dispatched source fallback covers C# imports.' },
  vb: { status: 'available', reason: 'AST-dispatched source fallback covers Visual Basic imports.' },
  dart: { status: 'partial', reason: 'Dart source fallback is regex-only for imports and exports.' },
  php: { status: 'available', reason: 'AST/source fallback covers PHP imports.' },
  clojure: {
    status: 'available',
    reason:
      'Source fallback covers Clojure namespace imports plus callable, callsite, and protocol/record member evidence for .clj, .cljs, and .cljc files.',
  },
};

export function getProjectReadiness(projectRoot: string, config: ProjectConfig): ProjectReadiness {
  const languages = config.languages ?? detectLanguages(projectRoot);
  const indexers = languages.map((language) => {
    const status = getIndexerDependencyStatus(getIndexerConfig(language), projectRoot);
    return {
      ...status,
      language,
      resolvedBinary: status.resolvedBinary ?? undefined,
    };
  });
  const semantic = languages.includes('typescript')
    ? {
        language: 'typescript' as const,
        ...getTypeScriptSemanticStatus(projectRoot, config.semantic?.typescript?.tsconfigs),
      }
    : undefined;
  const checkers = detectCheckers(projectRoot).map((checker) => ({
    label: checker.label,
    coversExtensions: checker.coversExtensions,
  }));

  return { languages, indexers, semantic, checkers, gitAvailable: gitAvailable(projectRoot) };
}

export function getProjectCapabilities(
  readiness: ProjectReadiness,
  opts: { hasIndexedGraph?: boolean } = {},
): ProjectCapabilityReport {
  const runnableIndexers = readiness.indexers.filter((indexer) => indexer.runnable).length;
  const graphStatus =
    readiness.languages.length === 0 || (runnableIndexers === 0 && !opts.hasIndexedGraph)
      ? 'unavailable'
      : runnableIndexers === readiness.indexers.length && readiness.indexers.length > 0
        ? 'available'
        : 'partial';
  const graphDataAvailable = graphStatus !== 'unavailable';
  const semanticStatus = readiness.semantic ? (readiness.semantic.available ? 'available' : 'partial') : 'unavailable';

  return {
    languages: readiness.languages,
    matrix: readiness.languages.map((language) =>
      languageCapability(readiness, language, { hasIndexedGraph: opts.hasIndexedGraph === true }),
    ),
    capabilities: [
      {
        id: 'indexing',
        label: 'SCIP indexing',
        status: graphStatus,
        evidence: 'graph-fact',
        reason:
          graphStatus === 'available'
            ? 'All detected/configured language indexers are runnable.'
            : opts.hasIndexedGraph
              ? `An indexed graph is present; ${runnableIndexers}/${readiness.indexers.length} detected/configured language indexers are runnable for refresh.`
              : `${runnableIndexers}/${readiness.indexers.length} detected/configured language indexers are runnable.`,
      },
      {
        id: 'semantic-typescript',
        label: 'TypeScript semantic provider',
        status: semanticStatus,
        evidence: 'semantic',
        reason: readiness.semantic
          ? readiness.semantic.available
            ? 'ts-morph can load the configured TypeScript project.'
            : (readiness.semantic.reason ?? 'TypeScript semantic checks will fall back to SCIP/source evidence.')
          : 'TypeScript is not detected/configured for this project.',
      },
      {
        id: 'heuristic-detectors',
        label: 'Heuristic cleanup detectors',
        status: graphDataAvailable ? 'available' : 'unavailable',
        evidence: 'heuristic',
        reason: !graphDataAvailable
          ? 'Heuristic detectors need an indexed code graph.'
          : 'Similarity, migration, wrapper, stale-abstraction, and doc-drift detectors can run over the index.',
      },
      {
        id: 'cleanup-verification',
        label: 'Compiler cleanup verification',
        status: readiness.checkers.length > 0 ? 'available' : 'unavailable',
        evidence: 'compiler',
        reason:
          readiness.checkers.length > 0
            ? readiness.checkers.map((checker) => checker.label).join(', ')
            : 'No project checker was detected for cleanup-plan --verify.',
      },
      {
        id: 'diff-gate',
        label: 'Git diff gate',
        status: readiness.gitAvailable && graphDataAvailable ? 'available' : 'unavailable',
        evidence: 'git',
        reason: readiness.gitAvailable
          ? 'Git diff data is available for changed-file gates.'
          : 'Git is unavailable or the project root is not a git worktree.',
      },
    ],
  };
}

function languageCapability(
  readiness: ProjectReadiness,
  language: SupportedLanguage,
  opts: { hasIndexedGraph: boolean },
): LanguageCapability {
  const indexer = readiness.indexers.find((entry) => entry.language === language);
  const indexingStatus: CapabilityStatus = indexer?.runnable
    ? 'available'
    : opts.hasIndexedGraph
      ? 'partial'
      : 'unavailable';
  const graphDataAvailable = indexingStatus !== 'unavailable';
  const sourceSupport = SOURCE_FACT_SUPPORT[language];
  const semantic =
    language === 'typescript'
      ? typescriptSemanticCapability(readiness)
      : {
          id: 'semantic',
          label: 'Semantic provider',
          status: 'unavailable' as const,
          evidence: 'semantic' as const,
          reason: `No semantic provider is registered for ${language}; commands use graph and source evidence instead.`,
        };
  const coveredByCheckers = checkersForLanguage(readiness, language);

  return {
    language,
    indexing: {
      id: 'indexing',
      label: 'SCIP indexing',
      status: indexingStatus,
      evidence: 'graph-fact',
      reason:
        indexingStatus === 'available'
          ? `${indexer?.binaryLabel ?? language} is runnable${indexer?.resolvedBinary ? ` at ${indexer.resolvedBinary}` : ''}.`
          : indexingStatus === 'partial'
            ? `An indexed ${language} graph is present, but ${indexer?.binaryLabel ?? language} is not currently runnable for refresh.`
            : (indexer?.note ?? `${language} indexing is not runnable in this project.`),
    },
    sourceFacts: {
      id: 'source-facts',
      label: 'Source fallback',
      status: graphDataAvailable ? sourceSupport.status : 'unavailable',
      evidence: 'heuristic',
      reason: !graphDataAvailable
        ? 'Source fallback needs indexed documents before it can attach evidence.'
        : sourceSupport.reason,
    },
    semantic,
    detectors: {
      id: 'detectors',
      label: 'Cleanup detectors',
      status: graphDataAvailable ? 'available' : 'unavailable',
      evidence: 'heuristic',
      reason: !graphDataAvailable
        ? 'Cleanup detectors need an indexed graph for this language.'
        : 'Graph-backed cleanup detectors can analyze this language; source and semantic precision depends on the rows above.',
    },
    cleanupVerification: {
      id: 'cleanup-verification',
      label: 'Cleanup verification',
      status: coveredByCheckers.length > 0 ? 'available' : 'unavailable',
      evidence: 'compiler',
      reason:
        coveredByCheckers.length > 0
          ? coveredByCheckers.map((checker) => checker.label).join(', ')
          : `No detected checker covers ${LANGUAGE_EXTENSIONS[language].join(', ')} files.`,
    },
  };
}

function typescriptSemanticCapability(readiness: ProjectReadiness): ProjectCapability {
  if (!readiness.semantic) {
    return {
      id: 'semantic',
      label: 'Semantic provider',
      status: 'unavailable',
      evidence: 'semantic',
      reason: 'TypeScript is not detected/configured for this project.',
    };
  }

  return {
    id: 'semantic',
    label: 'Semantic provider',
    status: readiness.semantic.available ? 'available' : 'partial',
    evidence: 'semantic',
    reason: readiness.semantic.available
      ? 'ts-morph can load the configured TypeScript project.'
      : (readiness.semantic.reason ?? 'TypeScript semantic checks fall back to SCIP/source evidence.'),
  };
}

function checkersForLanguage(readiness: ProjectReadiness, language: SupportedLanguage): Array<{ label: string }> {
  const extensions = new Set(LANGUAGE_EXTENSIONS[language]);
  return readiness.checkers.filter((checker) =>
    checker.coversExtensions.some((extension) => extensions.has(extension)),
  );
}

function gitAvailable(projectRoot: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectRoot,
      stdio: 'ignore',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}
