import type { ScipDatabase } from '../../storage/db.js';
import { containment } from '../../analysis/similarity.js';
import { ProjectIndex } from '../../core/project-index.js';
import { leafName, shortenSymbol } from '../../symbols/symbol-parser.js';
import {
  GIT_DIFF_UNAVAILABLE_NOTE,
  baseContentPathsForDiffPlan,
  createBaseContentReader,
  diffImpactPlan,
} from './diff-impact.js';
import type { BaseContentReader, DiffImpactPlan } from './diff-impact.js';
import { getCalleeFingerprintIndex, meaningfulCallees } from '../cleanup/similar.js';
import type { CalleeFingerprintIndex } from '../cleanup/similar.js';

export interface IncompleteMigrationLeftover {
  symbol: string;
  shortName: string;
  file: string;
  migrationScope: IncompleteMigrationScope;
  migrationScopeReasons: string[];
  /** |helper callees ∩ site callees| / |helper callees| (0-1). */
  containment: number;
  /** |helper callees ∩ site callees| / |site callees| (0-1). */
  siteCoverage: number;
  uniqueSiteCalleeCount: number;
  sharedCallees: string[];
}

export type IncompleteMigrationHelperShape = 'specific-callee-cluster';
export type IncompleteMigrationScope = 'same-scope' | 'possible-subtype' | 'unknown';

export interface IncompleteMigrationFinding {
  helperSymbol: string;
  helperShortName: string;
  helperFile: string;
  helperShape: IncompleteMigrationHelperShape;
  helperCalleeCount: number;
  specificHelperCalleeCount: number;
  /** Files referencing the helper. The helper is new, so every one of these references landed in this diff. */
  migratedFiles: string[];
  /** Un-migrated sites: contain the helper's callee set inline, don't call it. */
  leftovers: IncompleteMigrationLeftover[];
}

export interface IncompleteMigrationSkip {
  helperShortName: string;
  helperFile: string;
  reason: string;
}

export interface IncompleteMigrationResult {
  /** False when git history is unavailable (not a repo, bad base ref). */
  available: boolean;
  base: string;
  changedFiles: string[];
  /** New helpers that passed the callee/reference gates and were scored. */
  helpersChecked: number;
  /** New helpers that could not be scored, with reasons — no silent caps. */
  skipped: IncompleteMigrationSkip[];
  findings: IncompleteMigrationFinding[];
  note?: string;
}

const MAX_LEFTOVERS_PER_HELPER = 5;

/**
 * Incomplete extractions: an agent adds a helper, rewires a site or two into
 * it, and misses the remaining sites that still hold the same logic inline.
 *
 * The signature of a missed site is asymmetric: its callee set CONTAINS the
 * helper's callee set (plus its own surrounding logic), so symmetric cosine
 * (`similar`) under-scores exactly the sites we're after. This detector:
 *
 * 1. finds production callables in the diff whose name is absent at `base`
 *    (the new helpers),
 * 2. keeps those with at least one reference — the wired-in evidence
 *    (zero-reference helpers belong to diff-gate's new-dead check),
 * 3. reports established, untouched functions whose callees contain the
 *    helper's callees at >= minContainment and that do NOT call the helper,
 *    requiring at least one non-ubiquitous shared callee so project-wide
 *    infrastructure overlap alone can't fire. (Deliberately NOT median-IDF
 *    significance: the more sites a pattern was duplicated across, the more
 *    common its callees are in the corpus — an IDF gate suppresses exactly
 *    the widespread-leftover case this detector exists for.)
 *
 * Helpers with fewer than `minCallees` meaningful callees are skipped (and
 * reported as skipped): callee evidence is too thin to score tiny wrappers.
 */
export function incompleteMigration(
  db: ScipDatabase,
  opts: {
    base?: string;
    minContainment?: number;
    minCallees?: number;
    minSiteCoverage?: number;
    maxHelpers?: number;
    limit?: number;
    scanLimit?: number;
    semantic?: boolean;
    diffPlan?: DiffImpactPlan;
    baseContentAt?: BaseContentReader;
  } = {},
): IncompleteMigrationResult {
  const {
    base = 'HEAD',
    minContainment = 0.7,
    minCallees = 3,
    minSiteCoverage = 0.4,
    maxHelpers = Number.POSITIVE_INFINITY,
    limit = 20,
    scanLimit,
  } = opts;
  const semantic = opts.semantic !== false;

  const plan = opts.diffPlan ?? diffImpactPlan(db, { base });
  const result: IncompleteMigrationResult = {
    available: plan.note !== GIT_DIFF_UNAVAILABLE_NOTE,
    base,
    changedFiles: plan.changedFiles,
    helpersChecked: 0,
    skipped: [],
    findings: [],
  };
  if (!result.available || plan.changedFiles.length === 0) return result;

  const index = new ProjectIndex(db);
  const changed = new Set(plan.changedFiles);
  const renamedFromByFile = new Map(plan.renamedFiles.map((rename) => [rename.to, rename.from]));
  const baseContentAt =
    opts.baseContentAt ?? createBaseContentReader(db.config.projectRoot, base, baseContentPathsForDiffPlan(plan));

  const newDefs = newCallablesInDiff(index, changed, renamedFromByFile, baseContentAt);
  if (newDefs.length === 0) return result;
  const helpers = newDefs.slice(0, maxHelpers);
  if (newDefs.length > maxHelpers) {
    result.note = `helper scoring capped at ${maxHelpers} of ${newDefs.length} new symbols`;
  }

  const helperCalleeRows = index.calleeMap(helpers, { semantic });
  const helperFingerprints = helpers.map((def) => ({
    def,
    callees: meaningfulCallees((helperCalleeRows.get(def.symbolId) ?? []).map((c) => c.symbol)),
  }));
  let candidateIndex: CalleeFingerprintIndex | undefined;
  const getCandidateIndex = (): CalleeFingerprintIndex => {
    candidateIndex ??= getCalleeFingerprintIndex(db, { minCallees: Math.min(3, minCallees), scanLimit, semantic });
    return candidateIndex;
  };

  for (const { def, callees } of helperFingerprints) {
    const shortName = shortenSymbol(def.symbol);
    if (callees.size < minCallees) {
      result.skipped.push({
        helperShortName: shortName,
        helperFile: def.relativePath,
        reason: `fewer than ${minCallees} meaningful callees — too small to score`,
      });
      continue;
    }
    const candidateIndex = getCandidateIndex();
    const specificHelperCalleeCount = specificCalleeCount(callees, candidateIndex);
    if (specificHelperCalleeCount === 0) {
      result.skipped.push({
        helperShortName: shortName,
        helperFile: def.relativePath,
        reason: 'helper callee pattern is all project-wide infrastructure — too generic to score',
      });
      continue;
    }
    const migratedFiles = referencingFiles(db, def.symbolId);
    if (migratedFiles.length === 0) {
      result.skipped.push({
        helperShortName: shortName,
        helperFile: def.relativePath,
        reason: 'no references yet — covered by the new-dead check',
      });
      continue;
    }
    result.helpersChecked += 1;

    const leftovers = collectLeftoversForHelper({
      candidateIndex,
      changed,
      helperCallees: callees,
      helperFile: def.relativePath,
      helperSymbol: def.symbol,
      minContainment,
      minSiteCoverage,
      migratedFiles,
    });
    if (leftovers.length === 0) continue;

    leftovers.sort(
      (a, b) =>
        migrationScopeRank(b.migrationScope) - migrationScopeRank(a.migrationScope) ||
        b.containment - a.containment ||
        b.siteCoverage - a.siteCoverage ||
        a.file.localeCompare(b.file),
    );
    result.findings.push({
      helperSymbol: def.symbol,
      helperShortName: shortName,
      helperFile: def.relativePath,
      helperShape: 'specific-callee-cluster',
      helperCalleeCount: callees.size,
      specificHelperCalleeCount,
      migratedFiles: migratedFiles.sort(),
      leftovers: leftovers.slice(0, MAX_LEFTOVERS_PER_HELPER),
    });
  }

  result.findings.sort(
    (a, b) =>
      (b.leftovers[0]?.containment ?? 0) - (a.leftovers[0]?.containment ?? 0) ||
      a.helperFile.localeCompare(b.helperFile),
  );
  result.findings = result.findings.slice(0, limit);
  return result;
}

function collectLeftoversForHelper(opts: {
  candidateIndex: CalleeFingerprintIndex;
  changed: ReadonlySet<string>;
  helperCallees: Set<string>;
  helperFile: string;
  helperSymbol: string;
  minContainment: number;
  minSiteCoverage: number;
  migratedFiles: readonly string[];
}): IncompleteMigrationLeftover[] {
  const leftovers: IncompleteMigrationLeftover[] = [];
  const migrationScopeTokens = migrationScopeTokensForHelper(opts.helperSymbol, opts.helperFile, opts.migratedFiles);
  const candidateSet = new Set<number>();
  for (const callee of opts.helperCallees) {
    for (const candidateIndex of opts.candidateIndex.candidateIndexesByCallee.get(callee) ?? []) {
      candidateSet.add(candidateIndex);
    }
  }
  for (const candidateIndex of candidateSet) {
    const candidate = opts.candidateIndex.corpus[candidateIndex]!;
    if (candidate.symbol === opts.helperSymbol) continue;
    if (opts.changed.has(candidate.file)) continue; // touched files are the agent's active edit set
    if (candidate.callees.has(opts.helperSymbol)) continue; // already migrated
    const score = containment(opts.helperCallees, candidate.callees);
    if (score < opts.minContainment) continue;
    const shared = [...opts.helperCallees].filter((callee) => candidate.callees.has(callee));
    const siteCoverage = candidate.callees.size === 0 ? 0 : shared.length / candidate.callees.size;
    if (siteCoverage < opts.minSiteCoverage) continue;
    if (
      !shared.some((callee) => (opts.candidateIndex.docFreq.get(callee) ?? 0) <= opts.candidateIndex.ubiquityThreshold)
    ) {
      continue;
    }
    const scopeHint = migrationScopeForLeftover(migrationScopeTokens, candidate.symbol, candidate.file);
    leftovers.push({
      symbol: candidate.symbol,
      shortName: shortenSymbol(candidate.symbol),
      file: candidate.file,
      ...scopeHint,
      containment: score,
      siteCoverage,
      uniqueSiteCalleeCount: Math.max(0, candidate.callees.size - shared.length),
      sharedCallees: shared.map(shortenSymbol).sort(),
    });
  }
  return leftovers;
}

function migrationScopeRank(scope: IncompleteMigrationScope): number {
  if (scope === 'same-scope') return 2;
  if (scope === 'unknown') return 1;
  return 0;
}

function migrationScopeTokensForHelper(
  helperSymbol: string,
  helperFile: string,
  migratedFiles: readonly string[],
): Set<string> {
  const tokens = new Set<string>([...scopeTokensFromPath(helperFile), ...scopeTokensFromText(leafName(helperSymbol))]);
  for (const file of migratedFiles) {
    for (const token of scopeTokensFromPath(file)) tokens.add(token);
  }
  return tokens;
}

function migrationScopeForLeftover(
  migrationScopeTokens: ReadonlySet<string>,
  leftoverSymbol: string,
  leftoverFile: string,
): { migrationScope: IncompleteMigrationScope; migrationScopeReasons: string[] } {
  const leftoverTokens = new Set<string>([
    ...scopeTokensFromPath(leftoverFile),
    ...scopeTokensFromText(leafName(leftoverSymbol)),
  ]);
  if (migrationScopeTokens.size === 0 || leftoverTokens.size === 0) {
    return {
      migrationScope: 'unknown',
      migrationScopeReasons: ['insufficient path/name tokens to infer migration scope'],
    };
  }

  const sharedTokens = [...leftoverTokens].filter((token) => migrationScopeTokens.has(token)).sort();
  if (sharedTokens.length > 0) {
    return {
      migrationScope: 'same-scope',
      migrationScopeReasons: [`shares migration-scope token(s): ${sharedTokens.slice(0, 5).join(', ')}`],
    };
  }

  return {
    migrationScope: 'possible-subtype',
    migrationScopeReasons: ['no path/name tokens shared with the helper or already migrated files'],
  };
}

const MIGRATION_SCOPE_STOP_TOKENS = new Set([
  'app',
  'apps',
  'common',
  'component',
  'components',
  'helper',
  'helpers',
  'index',
  'lib',
  'package',
  'packages',
  'page',
  'pages',
  'route',
  'routes',
  'service',
  'services',
  'shared',
  'spec',
  'src',
  'test',
  'tests',
  'util',
  'utils',
]);

function scopeTokensFromPath(path: string): string[] {
  return scopeTokensFromText(path.replace(/\.[^.]+$/, ''));
}

function scopeTokensFromText(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !MIGRATION_SCOPE_STOP_TOKENS.has(token));
}

function specificCalleeCount(callees: ReadonlySet<string>, candidateIndex: CalleeFingerprintIndex): number {
  let count = 0;
  for (const callee of callees) {
    if ((candidateIndex.docFreq.get(callee) ?? 0) <= candidateIndex.ubiquityThreshold) count += 1;
  }
  return count;
}

/**
 * Production callables in changed files whose leaf name does not occur in
 * the file's content at `base` — extraction always mints a new name. A file
 * that doesn't exist at base (untracked or added) makes all its callables new.
 */
function newCallablesInDiff(
  index: ProjectIndex,
  changed: ReadonlySet<string>,
  renamedFromByFile: ReadonlyMap<string, string>,
  baseContentAt: BaseContentReader,
) {
  return index.productionCallableDefinitions({ requireFunctionLikeSymbol: true }).filter((def) => {
    if (!changed.has(def.relativePath)) return false;
    const basePath = renamedFromByFile.get(def.relativePath) ?? def.relativePath;
    const content = baseContentAt(basePath);
    return content === null || !new RegExp(`\\b${escapeRegex(def.leaf)}\\b`).test(content);
  });
}

/** Distinct files with a non-definition mention of the symbol (own file included — intra-file wiring counts). */
function referencingFiles(db: ScipDatabase, symbolId: number): string[] {
  const rows = db.all<{ relative_path: string }>(
    `SELECT DISTINCT ref_d.relative_path
     FROM mentions m
     JOIN chunks c ON m.chunk_id = c.id
     JOIN documents ref_d ON c.document_id = ref_d.id
     WHERE m.symbol_id = ?
       AND m.role != 1
       ${db.pathExclusionsFor('ref_d')}`,
    symbolId,
  );
  return rows.map((row) => row.relative_path);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
