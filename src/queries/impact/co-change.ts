import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ScipDatabase } from '../../storage/db.js';
import { classifyFile } from '../../analysis/file-classifier.js';
import { gitEvidenceProduct } from '../../analysis/git-history.js';
import type {
  CoChangeCommitScope,
  CoChangeRecency,
  CoChangeSubjectContext,
  GitHistoryMode,
} from '../../analysis/git-history.js';
import { buildFileDepGraph } from '../../symbols/graph/file-dep-graph.js';

export type CoChangePartnerClass =
  | 'doc-code'
  | 'config-code'
  | 'schema-script'
  | 'model-view'
  | 'test-code'
  | 'same-feature'
  | 'unknown';

export interface CoChangePartnerClassification {
  partnerClass: CoChangePartnerClass;
  reasons: string[];
}

export interface DeclaredCouplingSuggestion {
  name: string;
  files: string[];
  reason: string;
}

export interface CoChangePairEvidence {
  fileA: string;
  fileB: string;
  together: number;
  confidence: number;
  commitScope?: CoChangeCommitScope;
  recency?: CoChangeRecency;
  subjectContext?: CoChangeSubjectContext;
}

export interface CoChangeFinding {
  fileA: string;
  fileB: string;
  /** Commits in the analyzed window where both files changed. */
  together: number;
  /** max(P(B|A), P(A|B)) over the analyzed window. */
  confidence: number;
  changesA: number;
  changesB: number;
  focusedTogether: number;
  broadTogether: number;
  broadCommitRatio: number;
  lastTogetherAt: number;
  recentTogether: number;
  commitScope: CoChangeCommitScope;
  recency: CoChangeRecency;
  subjectContext: CoChangeSubjectContext;
  /** True when a dependency edge or declared coupling already explains the pair. */
  structurallyLinked: boolean;
  partnerClass: CoChangePartnerClass;
  partnerClassReasons: string[];
  declaredCouplingSuggestion?: DeclaredCouplingSuggestion;
}

export interface CoChangeResult {
  /** False when git history is unavailable (not a repo, git missing). */
  available: boolean;
  commitsAnalyzed: number;
  findings: CoChangeFinding[];
}

// Changelogs co-change with everything BY POLICY — intentional coupling,
// not a hidden concept (same class as tests and same-stem siblings).
export function isCoChangeNoiseFile(file: string): boolean {
  return NOISE_FILE_PATTERN.test(file);
}

const NOISE_FILE_PATTERN =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|uv\.lock|poetry\.lock|Pipfile\.lock|bun\.lockb?|\.SRCINFO|CHANGELOG(?:\.[a-z]+)?|.*\.(?:map|tsbuildinfo))$|(?:^|\/)(?:dist|build|out|node_modules|docs\/plans)\//i;

/**
 * Hidden coupling from the change graph: file pairs that repeatedly change
 * in the same commits but have no structural link between them.
 *
 * The reference graph cannot see that two mechanisms implement one concept —
 * a config list and the test that checks it share no symbols. The commit
 * history can: if editing one reliably means editing the other, a maintainer
 * who edits only one is probably introducing drift. With a `file` argument,
 * reports that file's co-change partners instead (including structurally
 * linked ones — exploration mode).
 */
export function coChange(
  db: ScipDatabase,
  file?: string,
  opts: {
    minTogether?: number;
    minConfidence?: number;
    limit?: number;
    includeLinked?: boolean;
    maxFilesPerCommit?: number;
    historyMode?: GitHistoryMode;
    /** Already-resolved invocation HEAD for snapshot-consistent Git evidence without another subprocess. */
    head?: string;
    /**
     * Caps how many of the (already together-count-sorted) candidate pairs
     * get classified — the per-pair loop below does filesystem/graph lookups
     * so its cost scales with candidate count on a large repo history. Set
     * by the CLI's analysis-budget disclosure on large indexes; honoring it
     * for real (rather than only disclosing it) keeps the disclosed budget
     * truthful. Highest-`together` pairs are kept first since `coChangePairs`
     * returns them pre-sorted by priority.
     */
    scanLimit?: number;
  } = {},
): CoChangeResult {
  const { minTogether = 4, minConfidence = 0.6, limit = 30, maxFilesPerCommit = 20 } = opts;
  const git = gitEvidenceProduct(db, {
    historyMode: opts.historyMode,
    ...(opts.head ? { head: opts.head } : {}),
  });
  const history = git.commitHistory();
  const partnersMode = file !== undefined;
  const allPairs = git.coChangePairs({
    minTogether: partnersMode ? Math.min(minTogether, 2) : minTogether,
    minConfidence: partnersMode ? 0 : minConfidence,
    maxFilesPerCommit,
  });
  if (!history || !allPairs) return { available: false, commitsAnalyzed: 0, findings: [] };
  const pairs = typeof opts.scanLimit === 'number' ? allPairs.slice(0, opts.scanLimit) : allPairs;

  const graph = buildFileDepGraph(db);
  const declaredCouplings = declaredCouplingSets(db);
  const structurallyLinkedPair = coChangeStructuralLinkChecker(db, graph, declaredCouplings);
  const includeLinked = opts.includeLinked === true || partnersMode;

  const findings: CoChangeFinding[] = [];
  for (const pair of pairs) {
    if (NOISE_FILE_PATTERN.test(pair.fileA) || NOISE_FILE_PATTERN.test(pair.fileB)) continue;
    // History contains files that were since moved or deleted — a pair is
    // only actionable when both sides still exist.
    if (!fileStillExists(db, pair.fileA) || !fileStillExists(db, pair.fileB)) continue;
    if (partnersMode && !pair.fileA.includes(file) && !pair.fileB.includes(file)) continue;
    if (!partnersMode) {
      // Tests co-changing with their subject is expected (and healthy) —
      // the hidden-coupling detector targets production/config/doc pairs.
      if (classifyFile(pair.fileA) === 'test' || classifyFile(pair.fileB) === 'test') continue;
      // Same-stem siblings (Component.vue / .script.ts / .css) are one unit
      // split across files — expected coupling, not a hidden concept.
      if (isSameStemSibling(pair.fileA, pair.fileB)) continue;
      // 21.2 calibration retune (external calibration: Vega_2.0 §5 —
      // "suppress ... locale-sibling (locales/*.json) pairs by default — the
      // 'hidden' premise fails when colocation already signals the
      // coupling"). Per-locale resource files (locales/en/x.json vs
      // locales/fr/x.json) are the same content in every language by
      // design — the coupling is obvious from the directory structure, not
      // a hidden concept worth surfacing.
      if (isLocaleSiblingPair(pair.fileA, pair.fileB)) continue;
    }
    const structurallyLinked = structurallyLinkedPair(pair.fileA, pair.fileB);
    if (!includeLinked && structurallyLinked) continue;
    const classification = classifyCoChangePartner(pair.fileA, pair.fileB);
    const declaredCouplingSuggestion = declaredCouplingSuggestionForPair(pair, classification, structurallyLinked);
    findings.push({
      ...pair,
      structurallyLinked,
      partnerClass: classification.partnerClass,
      partnerClassReasons: classification.reasons,
      ...(declaredCouplingSuggestion ? { declaredCouplingSuggestion } : {}),
    });
    if (findings.length >= limit) break;
  }

  return {
    available: true,
    commitsAnalyzed: history.commits.length,
    findings,
  };
}

function fileStillExists(db: ScipDatabase, relativePath: string): boolean {
  return existsSync(join(db.config.projectRoot, relativePath));
}

export function classifyCoChangePartner(fileA: string, fileB: string): CoChangePartnerClassification {
  const left = coChangePathFacts(fileA);
  const right = coChangePathFacts(fileB);
  const reasons: string[] = [];

  const addReason = (reason: string): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  const hasPair = (first: CoChangePathTag, second: CoChangePathTag): boolean =>
    (left.tags.has(first) && right.tags.has(second)) || (left.tags.has(second) && right.tags.has(first));

  if (hasPair('doc', 'code')) {
    addReason('one side is documentation and the other is executable source');
    return { partnerClass: 'doc-code', reasons };
  }
  if (left.tags.has('test') || right.tags.has('test')) {
    addReason('one side is classified as a test file');
    return { partnerClass: 'test-code', reasons };
  }
  if (hasPair('schema', 'script')) {
    addReason('schema or contract file changes with a script or generated-code path');
    return { partnerClass: 'schema-script', reasons };
  }
  if (hasPair('model', 'view')) {
    addReason('model or state path changes with a view or component path');
    return { partnerClass: 'model-view', reasons };
  }
  if (hasPair('config', 'code')) {
    addReason('configuration file changes with executable source');
    return { partnerClass: 'config-code', reasons };
  }

  const sharedFeatureTokens = sharedTokens(left.tokens, right.tokens).filter(
    (token) => !GENERIC_PATH_TOKENS.has(token),
  );
  if (sameDirectory(fileA, fileB) || sharedFeatureTokens.length >= 2) {
    addReason(
      sameDirectory(fileA, fileB)
        ? 'both files live in the same directory'
        : `files share feature tokens: ${sharedFeatureTokens.slice(0, 4).join(', ')}`,
    );
    return { partnerClass: 'same-feature', reasons };
  }

  addReason('no specific relationship pattern matched');
  return { partnerClass: 'unknown', reasons };
}

export function declaredCouplingSuggestionForPair(
  pair: CoChangePairEvidence,
  classification: CoChangePartnerClassification,
  structurallyLinked: boolean,
): DeclaredCouplingSuggestion | undefined {
  if (structurallyLinked) return undefined;
  if (pair.together < 4 || pair.confidence < 0.75) return undefined;
  if (pair.commitScope === 'broad-sweep' || pair.recency === 'stale') return undefined;
  if (!DECLARABLE_PARTNER_CLASSES.has(classification.partnerClass)) return undefined;

  const files = [pair.fileA, pair.fileB].sort();
  return {
    name: `co-change ${classification.partnerClass}: ${suggestionName(files)}`,
    files,
    reason: `${classification.partnerClass} pair changed together ${pair.together}x with ${Math.round(
      pair.confidence * 100,
    )}% confidence; declare it if future edits should require both sides.`,
  };
}

export function coChangeStructuralLinkChecker(
  db: ScipDatabase,
  graph = buildFileDepGraph(db),
  declaredCouplings = declaredCouplingSets(db),
): (fileA: string, fileB: string) => boolean {
  return (fileA, fileB) => hasStructuralLink(graph, declaredCouplings, fileA, fileB);
}

const LOCALE_RESOURCE_DIR_PATTERN = /(?:^|\/)(?:locales|i18n)\//i;

function isLocaleResourceFile(file: string): boolean {
  return LOCALE_RESOURCE_DIR_PATTERN.test(file);
}

/**
 * Both files are locale/i18n resources — either both live under a
 * `locales/` or `i18n/` directory, or they're same-basename `.json` files
 * in sibling per-locale directories (`translations/en/common.json` vs
 * `translations/fr/common.json`) even when the parent isn't literally named
 * `locales`/`i18n`.
 */
function isLocaleSiblingPair(fileA: string, fileB: string): boolean {
  if (isLocaleResourceFile(fileA) && isLocaleResourceFile(fileB)) return true;
  return isSiblingLocaleDirJsonPair(fileA, fileB);
}

function isSiblingLocaleDirJsonPair(fileA: string, fileB: string): boolean {
  if (!fileA.endsWith('.json') || !fileB.endsWith('.json')) return false;
  const lastSlashA = fileA.lastIndexOf('/');
  const lastSlashB = fileB.lastIndexOf('/');
  if (lastSlashA < 0 || lastSlashB < 0) return false;
  const dirA = fileA.slice(0, lastSlashA);
  const dirB = fileB.slice(0, lastSlashB);
  if (dirA === dirB) return false; // same directory — not a "sibling locale dir" pair
  const baseA = fileA.slice(lastSlashA + 1);
  const baseB = fileB.slice(lastSlashB + 1);
  if (baseA !== baseB) return false;
  const parentSlashA = dirA.lastIndexOf('/');
  const parentSlashB = dirB.lastIndexOf('/');
  const parentA = parentSlashA >= 0 ? dirA.slice(0, parentSlashA) : '';
  const parentB = parentSlashB >= 0 ? dirB.slice(0, parentSlashB) : '';
  return parentA === parentB;
}

function isSameStemSibling(fileA: string, fileB: string): boolean {
  const lastSlashA = fileA.lastIndexOf('/');
  const lastSlashB = fileB.lastIndexOf('/');
  if (fileA.slice(0, lastSlashA) !== fileB.slice(0, lastSlashB)) return false;
  const stemA = fileA.slice(lastSlashA + 1).split('.')[0];
  const stemB = fileB.slice(lastSlashB + 1).split('.')[0];
  return stemA !== '' && stemA === stemB;
}

function declaredCouplingSets(db: ScipDatabase): Array<ReadonlySet<string>> {
  return (db.config.declaredCouplings ?? [])
    .filter((coupling) => Array.isArray(coupling.files) && coupling.files.length >= 2)
    .map((coupling) => new Set(coupling.files));
}

function hasStructuralLink(
  graph: Map<string, Set<string>>,
  declaredCouplings: readonly ReadonlySet<string>[],
  fileA: string,
  fileB: string,
): boolean {
  if (graph.get(fileA)?.has(fileB) === true || graph.get(fileB)?.has(fileA) === true) {
    return true;
  }
  return declaredCouplings.some((group) => group.has(fileA) && group.has(fileB));
}

type CoChangePathTag = 'doc' | 'config' | 'schema' | 'script' | 'model' | 'view' | 'test' | 'code';

interface CoChangePathFacts {
  tags: Set<CoChangePathTag>;
  tokens: string[];
}

// Broad co-change tagging heuristic (directory hints + extension), distinct
// from doc-drift.ts's DOC_FILE_PATTERN which tests "is this literally a doc
// file" for drift tracking. Different jobs, same name would be misleading.
const DOC_TAG_PATH_PATTERN =
  /(?:^|\/)(?:readme|docs?|guides?|adr|architecture|design)(?:\/|$)|\.(?:md|mdx|rst|adoc|txt)$/i;
const CONFIG_FILE_PATTERN =
  /(?:^|\/)(?:\.[a-z0-9-]+rc|config|configs|settings|\.github)(?:\/|$)|(?:^|\/)(?:package\.json|tsconfig(?:\.[^.]+)?\.json|vite\.config\.[cm]?[jt]s|rollup\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s)$|\.(?:json|ya?ml|toml|ini|env)$/i;
const SCHEMA_FILE_PATTERN =
  /(?:^|\/)(?:schemas?|contracts?|migrations?|models?|types?)(?:\/|$)|(?:^|\/)[^/]*(?:schema|contract|migration|model|types?)[^/]*|(?:\.schema)?\.(?:graphql|gql|proto|prisma)$/i;
const SCRIPT_FILE_PATTERN =
  /(?:^|\/)(?:scripts?|bin|tools?|tasks?|generators?|codegen|migrations?|seeds?)(?:\/|$)|(?:^|\/)[^/]*(?:generate|codegen|migrate|seed|script)[^/]*\.[cm]?[jt]s$/i;
const MODEL_FILE_PATTERN =
  /(?:^|\/)(?:models?|entities|domain|state|stores?|reducers?)(?:\/|$)|(?:^|\/)[^/]*(?:model|entity|state|store|reducer|viewmodel)[^/]*\.[^.]+$/i;
const VIEW_FILE_PATTERN =
  /(?:^|\/)(?:views?|pages?|components?|screens?|routes?|templates?)(?:\/|$)|(?:^|\/)[^/]*(?:view|page|component|screen|template)[^/]*\.[^.]+$|\.(?:vue|svelte|tsx|jsx)$/i;

const DECLARABLE_PARTNER_CLASSES = new Set<CoChangePartnerClass>([
  'doc-code',
  'config-code',
  'schema-script',
  'model-view',
  'test-code',
]);

const GENERIC_PATH_TOKENS = new Set([
  'src',
  'lib',
  'app',
  'apps',
  'packages',
  'frontend',
  'backend',
  'examples',
  'python',
  'typescript',
  'javascript',
  'test',
  'tests',
  'spec',
  'index',
  'main',
  'utils',
  'util',
  'types',
  'type',
  'config',
  'docs',
  'doc',
  'package',
  'requirements',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'vue',
  'py',
  'md',
  'mdx',
  'json',
  'yaml',
  'yml',
  'toml',
  'txt',
]);

function coChangePathFacts(file: string): CoChangePathFacts {
  const normalized = file.replace(/\\/g, '/');
  const tags = new Set<CoChangePathTag>();
  if (DOC_TAG_PATH_PATTERN.test(normalized)) tags.add('doc');
  if (CONFIG_FILE_PATTERN.test(normalized)) tags.add('config');
  if (SCHEMA_FILE_PATTERN.test(normalized)) tags.add('schema');
  if (SCRIPT_FILE_PATTERN.test(normalized)) tags.add('script');
  if (MODEL_FILE_PATTERN.test(normalized)) tags.add('model');
  if (VIEW_FILE_PATTERN.test(normalized)) tags.add('view');
  if (classifyFile(normalized) === 'test') tags.add('test');
  if (!tags.has('doc') && !tags.has('config')) tags.add('code');
  return { tags, tokens: pathTokens(normalized) };
}

function sameDirectory(fileA: string, fileB: string): boolean {
  const slashA = fileA.lastIndexOf('/');
  const slashB = fileB.lastIndexOf('/');
  const left = slashA >= 0 ? fileA.slice(0, slashA) : '';
  const right = slashB >= 0 ? fileB.slice(0, slashB) : '';
  return left !== '' && left === right;
}

function pathTokens(file: string): string[] {
  return file
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2);
}

function sharedTokens(left: readonly string[], right: readonly string[]): string[] {
  const rightTokens = new Set(right);
  return [...new Set(left.filter((token) => rightTokens.has(token)))].sort();
}

function suggestionName(files: readonly string[]): string {
  return files
    .map(
      (file) =>
        file
          .split('/')
          .pop()
          ?.replace(/\.[^.]+$/, '') || file,
    )
    .join(' + ');
}
