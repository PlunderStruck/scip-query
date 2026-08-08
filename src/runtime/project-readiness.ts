import { execFileSync } from 'node:child_process';
import type { ProjectConfig, SupportedLanguage } from '../domain/types.js';
import type { GraphEvidenceFamily } from '../domain/graph-exploration-contract.js';
import { GRAPH_RELATION_CONTRACTS } from '../domain/graph-relation-contracts.js';
import {
  GRAPH_RELATION_PROVIDER_CONTRACTS,
  type GraphRelationProviderContract,
  type GraphRelationProviderRequirement,
  type GraphRelationSubtypeContract,
} from '../domain/graph-relation-providers.js';
import { getIndexerDependencyStatus } from '../platform/indexer-toolchain.js';
import { detectLanguages } from '../reindex/detect.js';
import { getIndexerConfig } from '../reindex/indexers.js';
import type { SemanticProviderLanguage } from '../semantic/types.js';
import { getRustSemanticStatus } from '../semantic/rust/status.js';
import { getTypeScriptSemanticStatus } from '../semantic/typescript/status.js';
import { detectCheckers, type CleanupCheckerStrength } from './cleanup-verify.js';
import { probeAstLanguageRuntime, type LanguageRuntimeProbe } from '../source/ast/ast-runtime.js';
import type { AstLanguage } from '../source/ast/ast-language.js';
import { registeredParserCapabilities } from '../language-parsers/registry.js';
import type { ParserFallbackMode } from '../language-parsers/types.js';

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
  language: SemanticProviderLanguage;
  available: boolean;
  dependencyAvailable: boolean;
  tsconfigPath?: string;
  tsconfigPaths?: string[];
  resolvedBinary?: string;
  /** Explanatory status text, including positive readiness detail. */
  reason?: string;
}

// scip-query: ignore-stale — readiness is the named handoff from project
// probing to status, doctor, and capability-matrix rendering; structural
// ReturnType consumers otherwise hide that boundary from the detector.
export interface ProjectReadiness {
  languages: SupportedLanguage[];
  indexers: LanguageReadiness[];
  semantics?: SemanticReadiness[];
  semantic?: SemanticReadiness;
  checkers: Array<{ label: string; coversExtensions: string[]; strength?: CleanupCheckerStrength }>;
  gitAvailable: boolean;
}

export type CapabilityStatus = 'available' | 'partial' | 'unavailable';
export type CapabilityEvidence = 'graph-fact' | 'semantic' | 'heuristic' | 'checker' | 'git';

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
  relations: ProjectRelationCapability[];
}

export type GraphRelationSupportStatus = 'exact' | 'partial' | 'candidate' | 'unsupported';

export interface ProjectRelationCapability {
  family: GraphEvidenceFamily;
  status: GraphRelationSupportStatus;
  establishes: string;
  nonClaims: readonly string[];
  providers: readonly string[];
  providerCapabilities: ProjectRelationProviderCapability[];
  reason: string;
}

export interface LanguageRelationProviderCapability {
  language: SupportedLanguage;
  status: GraphRelationSupportStatus;
  reason: string;
}

export interface ProjectRelationProviderCapability {
  id: string;
  label: string;
  status: GraphRelationSupportStatus;
  requirements: readonly GraphRelationProviderRequirement[];
  subtypes: string[];
  languages: LanguageRelationProviderCapability[];
  reason: string;
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

const AST_LANGUAGE_BY_SUPPORTED_LANGUAGE: Partial<Record<SupportedLanguage, AstLanguage>> = {
  typescript: 'typescript',
  javascript: 'javascript',
  java: 'java',
  scala: 'scala',
  kotlin: 'kotlin',
  rust: 'rust',
  python: 'python',
  ruby: 'ruby',
  cpp: 'cpp',
  c: 'c',
  csharp: 'csharp',
  vb: 'vb',
  php: 'php',
  clojure: 'clojure',
};

const REGISTRY_LANGUAGE_BY_SUPPORTED_LANGUAGE: Partial<Record<SupportedLanguage, string>> = {
  typescript: 'javascript',
  javascript: 'javascript',
  java: 'jvm',
  scala: 'jvm',
  kotlin: 'jvm',
  rust: 'rust',
  python: 'python',
  ruby: 'ruby',
  cpp: 'c/cpp',
  c: 'c/cpp',
  csharp: 'dotnet',
  vb: 'dotnet',
  dart: 'dart',
  php: 'php',
  clojure: 'clojure',
};

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
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
  const semantics = semanticReadinessForLanguages(projectRoot, languages, config);
  const semantic = semanticReadinessForLanguage({ semantics }, 'typescript');
  const checkers = detectCheckers(projectRoot).map((checker) => ({
    label: checker.label,
    coversExtensions: checker.coversExtensions,
    strength: checker.strength,
  }));

  return { languages, indexers, semantics, semantic, checkers, gitAvailable: gitAvailable(projectRoot) };
}

export function getProjectCapabilities(
  readiness: ProjectReadiness,
  opts: {
    hasIndexedGraph?: boolean;
    indexedLanguages?: readonly SupportedLanguage[];
    runtimeProbe?: (language: SupportedLanguage) => LanguageRuntimeProbe;
  } = {},
): ProjectCapabilityReport {
  const runnableIndexers = readiness.indexers.filter((indexer) => indexer.runnable).length;
  const graphStatus =
    readiness.languages.length === 0 || (runnableIndexers === 0 && !opts.hasIndexedGraph)
      ? 'unavailable'
      : runnableIndexers === readiness.indexers.length && readiness.indexers.length > 0
        ? 'available'
        : 'partial';
  const graphDataAvailable = graphStatus !== 'unavailable';
  const matrix = readiness.languages.map((language) =>
    languageCapability(readiness, language, {
      hasIndexedGraph: languageHasIndexedGraph(language, opts),
      runtimeProbe: opts.runtimeProbe,
    }),
  );
  const verificationStatuses = matrix.map((row) => row.cleanupVerification.status);
  const verificationStatus: CapabilityStatus =
    verificationStatuses.length === 0 || verificationStatuses.every((status) => status === 'unavailable')
      ? 'unavailable'
      : verificationStatuses.every((status) => status === 'available')
        ? 'available'
        : 'partial';
  return {
    languages: readiness.languages,
    matrix,
    relations: projectRelationCapabilities(matrix, graphDataAvailable),
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
      ...projectSemanticCapabilities(readiness),
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
        label: 'Project cleanup verification',
        status: verificationStatus,
        evidence: 'checker',
        reason:
          verificationStatus !== 'unavailable'
            ? matrix
                .map((row) => `${row.language}: ${row.cleanupVerification.status} (${row.cleanupVerification.reason})`)
                .join('; ')
            : 'No project checker was detected for cleanup-plan --verify.',
      },
      {
        id: 'diff-impact',
        label: 'Git change mapping',
        status: readiness.gitAvailable && graphDataAvailable ? 'available' : 'unavailable',
        evidence: 'git',
        reason: readiness.gitAvailable
          ? 'Git diff data is available for changed-symbol and downstream-consumer mapping.'
          : 'Git is unavailable or the project root is not a git worktree.',
      },
    ],
  };
}

function projectRelationCapabilities(
  matrix: readonly LanguageCapability[],
  graphDataAvailable: boolean,
): ProjectRelationCapability[] {
  return GRAPH_RELATION_CONTRACTS.map((contract) => {
    const providerCapabilities = GRAPH_RELATION_PROVIDER_CONTRACTS.flatMap((provider) => {
      const relations = provider.relations.filter((relation) => relation.family === contract.family);
      return relations.length === 0 ? [] : [projectProviderCapability(provider, relations, matrix, graphDataAvailable)];
    });
    const status = aggregateRelationSupport(providerCapabilities.map((provider) => provider.status));
    return {
      ...contract,
      status,
      providerCapabilities,
      reason:
        status === 'unsupported'
          ? graphDataAvailable
            ? 'The current project has no available provider for this relationship family.'
            : 'An indexed graph is required before this relationship family can be queried.'
          : status === 'exact'
            ? 'Exact within indexed compiler/source identity coverage; dynamic or unindexed constructs remain outside scope.'
            : 'Supported by bounded static providers; unresolved and unsupported constructs remain explicitly reported.',
    };
  });
}

function projectProviderCapability(
  provider: GraphRelationProviderContract,
  relations: readonly GraphRelationSubtypeContract[],
  matrix: readonly LanguageCapability[],
  graphDataAvailable: boolean,
): ProjectRelationProviderCapability {
  const languages = matrix.map((row) => languageProviderCapability(provider, relations, row, graphDataAvailable));
  const status = aggregateRelationSupport(languages.map((language) => language.status));
  const availableLanguages = languages
    .filter((language) => language.status !== 'unsupported')
    .map((row) => row.language);
  return {
    id: provider.id,
    label: provider.label,
    status,
    requirements: provider.requirements,
    subtypes: relations.map((relation) => relation.subtype),
    languages,
    reason:
      availableLanguages.length === 0
        ? `Unavailable: requires ${provider.requirements.join(', ')}.`
        : `${status} support for ${availableLanguages.join(', ')}; analytical ceiling is declared per subtype.`,
  };
}

function languageProviderCapability(
  provider: GraphRelationProviderContract,
  relations: readonly GraphRelationSubtypeContract[],
  language: LanguageCapability,
  graphDataAvailable: boolean,
): LanguageRelationProviderCapability {
  const missing = provider.requirements.filter(
    (requirement) => !providerRequirementAvailable(requirement, language, graphDataAvailable),
  );
  if (missing.length > 0) {
    return {
      language: language.language,
      status: 'unsupported',
      reason: `Missing ${missing.join(', ')}.`,
    };
  }
  const status = aggregateRelationSupport(relations.map((relation) => relation.supportCeiling));
  return {
    language: language.language,
    status,
    reason: `${provider.label} is available; subtype coverage is ${status}.`,
  };
}

function providerRequirementAvailable(
  requirement: GraphRelationProviderRequirement,
  language: LanguageCapability,
  graphDataAvailable: boolean,
): boolean {
  switch (requirement) {
    case 'indexed-graph':
      return graphDataAvailable && language.indexing.status !== 'unavailable';
    case 'source-facts':
      return language.sourceFacts.status !== 'unavailable';
    case 'typescript-semantic':
      return language.language === 'typescript' && language.semantic.status === 'available';
  }
}

function aggregateRelationSupport(statuses: readonly GraphRelationSupportStatus[]): GraphRelationSupportStatus {
  const available = statuses.filter((status) => status !== 'unsupported');
  if (available.length === 0) return 'unsupported';
  if (available.every((status) => status === 'exact')) return 'exact';
  if (available.some((status) => status === 'exact' || status === 'partial')) return 'partial';
  return 'candidate';
}

function projectSemanticCapabilities(readiness: ProjectReadiness): ProjectCapability[] {
  return semanticProviderLanguagesForProject(readiness).map((language) => {
    const semantic = semanticReadinessForLanguage(readiness, language);
    const status: CapabilityStatus = semantic
      ? semantic.available
        ? 'available'
        : semantic.dependencyAvailable
          ? 'partial'
          : 'unavailable'
      : 'unavailable';
    return {
      id: `semantic-${language}`,
      label: `${semanticProviderLabel(language)} semantic provider`,
      status,
      evidence: 'semantic',
      reason: semanticProviderReason(language, semantic),
    };
  });
}

function semanticProviderLanguagesForProject(readiness: ProjectReadiness): SemanticProviderLanguage[] {
  const languages = new Set<SemanticProviderLanguage>();
  for (const language of readiness.languages) {
    if (language === 'typescript' || language === 'rust') languages.add(language);
  }
  for (const semantic of semanticReadinessEntries(readiness)) {
    languages.add(semantic.language);
  }
  return [...languages].sort((left, right) => semanticProviderOrder(left) - semanticProviderOrder(right));
}

function semanticProviderOrder(language: SemanticProviderLanguage): number {
  return language === 'typescript' ? 0 : 1;
}

function semanticProviderLabel(language: SemanticProviderLanguage): string {
  return language === 'typescript' ? 'TypeScript' : 'Rust';
}

function semanticProviderReason(language: SemanticProviderLanguage, semantic: SemanticReadiness | undefined): string {
  if (semantic?.available) {
    return language === 'typescript'
      ? 'ts-morph can load the configured TypeScript project.'
      : 'rust-analyzer semantic queries are available.';
  }
  if (semantic) {
    return (
      semantic.reason ??
      (language === 'typescript'
        ? 'TypeScript semantic checks will fall back to SCIP/source evidence.'
        : 'Rust semantic checks will fall back to SCIP/source evidence.')
    );
  }
  return language === 'typescript'
    ? 'TypeScript is not detected/configured for this project.'
    : 'Rust is not detected/configured for this project.';
}

function languageCapability(
  readiness: ProjectReadiness,
  language: SupportedLanguage,
  opts: { hasIndexedGraph: boolean; runtimeProbe?: (language: SupportedLanguage) => LanguageRuntimeProbe },
): LanguageCapability {
  const indexer = readiness.indexers.find((entry) => entry.language === language);
  const indexingStatus: CapabilityStatus = indexer?.runnable
    ? 'available'
    : opts.hasIndexedGraph
      ? 'partial'
      : 'unavailable';
  const graphDataAvailable = indexingStatus !== 'unavailable';
  const sourceSupport = sourceFactCapability(language, opts.runtimeProbe);
  const semantic = languageSemanticCapability(readiness, language);
  const coveredByCheckers = checkersForLanguage(readiness, language);
  const cleanupVerificationStatus: CapabilityStatus =
    coveredByCheckers.length === 0
      ? 'unavailable'
      : coveredByCheckers.every((checker) => checker.strength !== 'syntax-only')
        ? 'available'
        : 'partial';

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
      status: cleanupVerificationStatus,
      evidence: 'checker',
      reason:
        coveredByCheckers.length > 0
          ? coveredByCheckers.map((checker) => checker.label).join(', ')
          : `No detected checker covers ${LANGUAGE_EXTENSIONS[language].join(', ')} files.`,
    },
  };
}

function languageHasIndexedGraph(
  language: SupportedLanguage,
  opts: { hasIndexedGraph?: boolean; indexedLanguages?: readonly SupportedLanguage[] },
): boolean {
  if (opts.indexedLanguages) return opts.indexedLanguages.includes(language);
  return opts.hasIndexedGraph === true;
}

function sourceFactCapability(
  language: SupportedLanguage,
  runtimeProbe: ((language: SupportedLanguage) => LanguageRuntimeProbe) | undefined,
): { status: CapabilityStatus; reason: string } {
  if (language === 'go') {
    return {
      status: 'unavailable',
      reason: 'No Go source-fallback adapter is registered; Go relies on SCIP graph facts.',
    };
  }
  if (language === 'clojure') {
    const probe = runtimeProbe?.(language) ?? defaultRuntimeProbe(language);
    if (probe === 'unavailable') {
      return {
        status: 'unavailable',
        reason:
          'Clojure built-in reader is not available in this environment; no source-fallback evidence can be produced.',
      };
    }
    return {
      status: 'available',
      reason:
        'Clojure source fallback uses the built-in reader for namespace imports plus callable, callsite, and protocol/record member evidence for .clj, .cljs, and .cljc files.',
    };
  }

  const mode = primaryParserFallbackMode(language);
  if (mode === 'regex-only') {
    return { status: 'partial', reason: `${language} source fallback is regex-only for imports and exports.` };
  }
  if (!mode) {
    return { status: 'unavailable', reason: `No source-fallback adapter is registered for ${language}.` };
  }

  const probe = runtimeProbe?.(language) ?? defaultRuntimeProbe(language);
  if (probe === 'unavailable') {
    return {
      status: 'partial',
      reason: 'tree-sitter native module not loadable — regex/import-only evidence remains available where registered.',
    };
  }
  if (probe === 'regex') {
    return { status: 'partial', reason: `${language} source fallback is regex-only for imports and exports.` };
  }
  if (probe === 'reader') {
    return { status: 'available', reason: `${language} source fallback is reader-backed.` };
  }
  return {
    status: 'available',
    reason:
      mode === 'ast-dispatch-with-regex-fallback'
        ? `AST-dispatched source fallback covers ${language} imports.`
        : `AST/source fallback covers ${language} imports and source-backed evidence.`,
  };
}

function defaultRuntimeProbe(language: SupportedLanguage): LanguageRuntimeProbe {
  const astLanguage = AST_LANGUAGE_BY_SUPPORTED_LANGUAGE[language];
  if (!astLanguage) return primaryParserFallbackMode(language) === 'regex-only' ? 'regex' : 'unavailable';
  return probeAstLanguageRuntime(astLanguage);
}

function primaryParserFallbackMode(language: SupportedLanguage): ParserFallbackMode | null {
  const registryLanguage = REGISTRY_LANGUAGE_BY_SUPPORTED_LANGUAGE[language];
  const capabilities = registryLanguage ? registeredParserCapabilities(registryLanguage) : null;
  return capabilities?.imports ?? capabilities?.exports ?? capabilities?.reExports ?? null;
}

function semanticReadinessForLanguages(
  projectRoot: string,
  languages: readonly SupportedLanguage[],
  config: ProjectConfig,
): SemanticReadiness[] {
  const semantics: SemanticReadiness[] = [];
  if (languages.includes('typescript')) {
    semantics.push({
      language: 'typescript',
      ...getTypeScriptSemanticStatus(projectRoot, config.semantic?.typescript?.tsconfigs),
    });
  }
  if (languages.includes('rust')) {
    const status = getRustSemanticStatus(projectRoot);
    semantics.push({
      language: 'rust',
      available: status.available,
      dependencyAvailable: status.dependencyAvailable,
      resolvedBinary: status.resolvedBinary,
      reason: status.available ? status.note : status.reason,
    });
  }
  return semantics;
}

function semanticReadinessEntries(readiness: Pick<ProjectReadiness, 'semantic' | 'semantics'>): SemanticReadiness[] {
  if (readiness.semantics) return readiness.semantics;
  return readiness.semantic ? [readiness.semantic] : [];
}

function semanticReadinessForLanguage(
  readiness: Pick<ProjectReadiness, 'semantic' | 'semantics'>,
  language: SemanticProviderLanguage,
): SemanticReadiness | undefined {
  return semanticReadinessEntries(readiness).find((entry) => entry.language === language);
}

function languageSemanticCapability(readiness: ProjectReadiness, language: SupportedLanguage): ProjectCapability {
  if (language !== 'typescript' && language !== 'rust') {
    return {
      id: 'semantic',
      label: 'Semantic provider',
      status: 'unavailable',
      evidence: 'semantic',
      reason: `No semantic provider is registered for ${language}; commands use graph and source evidence instead.`,
    };
  }

  const semantic = semanticReadinessForLanguage(readiness, language);
  if (!semantic) {
    return {
      id: 'semantic',
      label: 'Semantic provider',
      status: 'unavailable',
      evidence: 'semantic',
      reason:
        language === 'typescript'
          ? 'TypeScript is not detected/configured for this project.'
          : 'Rust is not detected/configured for this project.',
    };
  }

  return {
    id: 'semantic',
    label: 'Semantic provider',
    status: semantic.available ? 'available' : semantic.dependencyAvailable ? 'partial' : 'unavailable',
    evidence: 'semantic',
    reason: semantic.available
      ? language === 'typescript'
        ? 'ts-morph can load the configured TypeScript project.'
        : 'rust-analyzer semantic queries are available.'
      : (semantic.reason ?? `${language} semantic checks fall back to SCIP/source evidence.`),
  };
}

function checkersForLanguage(
  readiness: ProjectReadiness,
  language: SupportedLanguage,
): Array<{ label: string; strength?: CleanupCheckerStrength }> {
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
