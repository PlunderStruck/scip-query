import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { ProjectIndex } from '../internal/project-index.js';
import {
  semanticCalleeMap,
  semanticEvidenceProduct,
  semanticReferences,
  semanticCalleeCoverage,
  semanticCompilerVisibleFiles,
} from '../../semantic/shared-primitives.js';
import { symbolSemanticEvidence } from '../../semantic/symbol-evidence.js';
import { referenceSitesForSymbol } from '../../symbols/references/reference-sites.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';
import { detectAstLanguage, getSourceFacts } from '../../source/ast.js';

export type AuditQuestion = 'references' | 'callees' | 'renders';
export type AuditOracleKind = 'semantic' | 'source';

export interface AuditDisagreement {
  symbol: string;
  question: AuditQuestion;
  /** Files only the cheap evidence path reported (potential false positives). */
  cheapOnly: string[];
  /** Files only the compiler oracle reported (potential misses). */
  oracleOnly: string[];
}

export interface AuditQuestionScore {
  question: AuditQuestion;
  /** Symbols where both paths produced a comparable (non-empty) answer. */
  comparedSymbols: number;
  /**
   * Null when the oracle is partial for this question (it confirms positives
   * but doesn't enumerate all of them), so "cheap-only" answers are
   * unverified rather than wrong and no precision claim is valid.
   */
  precision: number | null;
  recall: number;
  /** Cheap-path answers the oracle could not confirm (only meaningful when precision is null). */
  unverified: number;
  /** Samples skipped because the oracle is partial and produced no comparable answer. */
  skippedOraclePartial: number;
  /** Compared symbols whose oracle accounted for every call site; precision is measured over these only. */
  completeOracleSymbols: number;
  /** Cheap-path answers in files outside every compiler project; the oracle cannot see them, so they are neither confirmed nor wrong. */
  outsideOracleCoverage: number;
  /** Cheap-path rows over the whole sample by evidence source; empty for the references question. */
  cheapSources: Record<string, number>;
}

export interface SelfAuditResult {
  /** False when no semantic or source-backed oracle is available. */
  available: boolean;
  sampleSize: number;
  /** Fraction of sampled symbols the oracle could answer at all. */
  oracleCoverage: number;
  /** Semantic means compiler-backed; source means language source-fact-backed. */
  oracleKind?: AuditOracleKind;
  scores: AuditQuestionScore[];
  /** Largest divergences — the actionable debugging targets. */
  topDisagreements: AuditDisagreement[];
}

/**
 * Accuracy oracle: score the cheap evidence paths (SCIP + source heuristics)
 * against the embedded TypeScript compiler (ts-morph) on a deterministic
 * sample of symbols.
 *
 * This measures *agreement with compiler semantics*, not absolute truth —
 * the compiler misses dynamic dispatch too. Comparison is at file-set
 * granularity ("which files reference/are called by this symbol") because
 * symbol-identity schemes differ between providers while file attribution
 * does not.
 *
 * The point: "make every command as accurate as possible" is only meaningful
 * once accuracy is a number you can track. This is that number.
 */
// scip-query: ignore-extract — one audit pass: sampling, dual-path
// questioning, tallying, and disagreement collection are a single
// measurement; splitting them would thread state through helpers.
export function selfAudit(
  db: ScipDatabase,
  opts: { samples?: number; scope?: string; maxDisagreements?: number } = {},
): SelfAuditResult {
  const { samples = 50, scope, maxDisagreements = 5 } = opts;
  const index = new ProjectIndex(db);

  const sampled = sampleDefinitions(
    index.productionCallableDefinitions({ scope, minLoc: 2, requireFunctionLikeSymbol: true }),
    samples,
  );
  const oracleKind = oracleKindForSample(db, sampled);
  if (sampled.length === 0 || !oracleKind) {
    return { available: false, sampleSize: sampled.length, oracleCoverage: 0, scores: [], topDisagreements: [] };
  }

  const tallies: Record<AuditQuestion, QuestionTally> = {
    references: emptyTally(),
    callees: emptyTally(),
    renders: emptyTally(),
  };
  const disagreements: AuditDisagreement[] = [];
  let oracleAnswered = 0;

  const semanticOracleCallees: ReturnType<typeof semanticCalleeMap> =
    oracleKind === 'semantic' ? semanticCalleeMap(db, sampled) : new Map();
  // The compiler names the call sites it could not bind; a definition with
  // none of those has a complete callee oracle, so cheap-only files there
  // are false positives rather than unverified answers.
  const semanticCoverage = oracleKind === 'semantic' ? semanticCalleeCoverage(db, sampled) : new Map();
  const compilerSees = (oracleKind === 'semantic' ? semanticCompilerVisibleFiles(db) : null) ?? (() => true);
  const sourceOracle = oracleKind === 'source' ? buildClojureSourceOracle(db, index, sampled) : null;
  for (const definition of sampled) {
    const oracleRefs = crossFileSet(
      definition,
      oracleKind === 'semantic'
        ? semanticReferences(db, definition).map((ref) => ref.file)
        : [...(sourceOracle?.referencesBySymbolId.get(definition.symbolId) ?? [])],
    );
    const oracleCalleeRows: ReadonlyArray<{ file: string; kind?: 'jsx-render' }> =
      oracleKind === 'semantic'
        ? (semanticOracleCallees.get(definition.symbolId) ?? [])
        : [...(sourceOracle?.calleesBySymbolId.get(definition.symbolId) ?? [])].map((file) => ({ file }));
    const oracleCals = crossFileSet(
      definition,
      oracleCalleeRows.filter((callee) => callee.kind !== 'jsx-render').map((callee) => callee.file),
    );
    const oracleRenders = crossFileSet(
      definition,
      oracleCalleeRows.filter((callee) => callee.kind === 'jsx-render').map((callee) => callee.file),
    );
    oracleAnswered += 1;

    const cheapRefs = crossFileSet(
      definition,
      referenceSitesForSymbol(db, definition, { semanticEvidence: symbolSemanticEvidence }).map((site) => site.file),
    );
    const cheapCalleeRows = index.calleeMap([definition], { semantic: false }).get(definition.symbolId) ?? [];
    for (const row of cheapCalleeRows) {
      const sources = (row.kind === 'jsx-render' ? tallies.renders : tallies.callees).sources;
      sources[row.source] = (sources[row.source] ?? 0) + 1;
    }
    const cheapCals = crossFileSet(
      definition,
      cheapCalleeRows.filter((callee) => callee.kind !== 'jsx-render').map((callee) => callee.file),
    );
    const cheapRenders = crossFileSet(
      definition,
      cheapCalleeRows.filter((callee) => callee.kind === 'jsx-render').map((callee) => callee.file),
    );

    // The compiler oracle only enumerates call shapes it resolved, so an
    // empty answer is ambiguous unless the body has no call or render site
    // at all; then "nothing" is the complete answer and the comparison holds.
    const sites = callSiteKindsInDefinition(db, definition);
    const coverage = semanticCoverage.get(definition.symbolId);
    const compilerAccountedForEverySite = coverage !== undefined && coverage.unresolved === 0;
    const referencesComplete = oracleComplete(oracleKind, 'references');
    const calleesComplete = oracleComplete(oracleKind, 'callees') || compilerAccountedForEverySite || sites.calls === 0;
    const rendersComplete =
      oracleComplete(oracleKind, 'renders') || compilerAccountedForEverySite || sites.renders === 0;
    scoreQuestion(
      tallies.references,
      definition,
      'references',
      cheapRefs,
      oracleRefs,
      referencesComplete,
      disagreements,
      compilerSees,
    );
    scoreQuestion(
      tallies.callees,
      definition,
      'callees',
      cheapCals,
      oracleCals,
      calleesComplete,
      disagreements,
      compilerSees,
    );
    scoreQuestion(
      tallies.renders,
      definition,
      'renders',
      cheapRenders,
      oracleRenders,
      rendersComplete,
      disagreements,
      compilerSees,
    );
  }

  disagreements.sort(
    (left, right) =>
      right.cheapOnly.length + right.oracleOnly.length - (left.cheapOnly.length + left.oracleOnly.length),
  );

  return {
    available: true,
    sampleSize: sampled.length,
    oracleCoverage: sampled.length > 0 ? round3(oracleAnswered / sampled.length) : 0,
    oracleKind,
    scores: (['references', 'callees', 'renders'] as const).map((question) =>
      finalizeScore(question, tallies[question], oracleKind),
    ),
    topDisagreements: disagreements.slice(0, maxDisagreements),
  };
}

interface QuestionTally {
  comparedSymbols: number;
  agreed: number;
  cheapTotal: number;
  oracleTotal: number;
  skippedOraclePartial: number;
  /** Subset of compared symbols whose oracle was complete, and the cheap rows and agreements among them. */
  completeSymbols: number;
  completeCheapTotal: number;
  completeAgreed: number;
  outsideCoverage: number;
  sources: Record<string, number>;
}

function emptyTally(): QuestionTally {
  return {
    comparedSymbols: 0,
    agreed: 0,
    cheapTotal: 0,
    oracleTotal: 0,
    skippedOraclePartial: 0,
    completeSymbols: 0,
    completeCheapTotal: 0,
    completeAgreed: 0,
    outsideCoverage: 0,
    sources: {},
  };
}

/** Deterministic stride sample — reproducible runs without randomness. */
function sampleDefinitions(definitions: IndexedDefinition[], samples: number): IndexedDefinition[] {
  const ordered = [...definitions].sort((left, right) => left.symbolId - right.symbolId);
  if (ordered.length <= samples) return ordered;
  const stride = ordered.length / samples;
  const picked: IndexedDefinition[] = [];
  for (let i = 0; i < samples; i++) {
    picked.push(ordered[Math.floor(i * stride)]!);
  }
  return picked;
}

function oracleKindForSample(db: ScipDatabase, sampled: readonly IndexedDefinition[]): AuditOracleKind | null {
  const probe = sampled[0];
  if (!probe) return null;
  if (canSourceAuditDefinition(db, probe)) return 'source';
  try {
    if (semanticEvidenceProduct(db).capability('semantic-references', probe.relativePath).available) return 'semantic';
  } catch {
    // Fall through to source-backed oracles below.
  }
  return sampled.some((definition) => canSourceAuditDefinition(db, definition)) ? 'source' : null;
}

function crossFileSet(definition: IndexedDefinition, files: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    if (file !== definition.relativePath) out.add(file);
  }
  return out;
}

function scoreQuestion(
  tally: QuestionTally,
  definition: IndexedDefinition,
  question: AuditQuestion,
  cheap: Set<string>,
  oracle: Set<string>,
  oracleComplete: boolean,
  disagreements: AuditDisagreement[],
  oracleSees: (file: string) => boolean = () => true,
): void {
  if (!oracleComplete && oracle.size === 0) {
    tally.skippedOraclePartial += 1;
    return;
  }
  // A cheap answer in a file the oracle cannot see is outside the comparison:
  // it is counted, but never as agreement or as a false positive.
  const outside = [...cheap].filter((file) => !oracle.has(file) && !oracleSees(file));
  tally.outsideCoverage += outside.length;
  const comparable = cheap.size - outside.length;
  tally.comparedSymbols += 1;
  tally.cheapTotal += comparable;
  tally.oracleTotal += oracle.size;
  if (oracleComplete) {
    tally.completeSymbols += 1;
    tally.completeCheapTotal += comparable;
  }
  const cheapOnly: string[] = [];
  const oracleOnly: string[] = [];
  for (const file of cheap) {
    if (oracle.has(file)) {
      tally.agreed += 1;
      if (oracleComplete) tally.completeAgreed += 1;
    } else if (oracleSees(file)) cheapOnly.push(file);
  }
  for (const file of oracle) {
    if (!cheap.has(file)) oracleOnly.push(file);
  }
  if (cheapOnly.length > 0 || oracleOnly.length > 0) {
    disagreements.push({ symbol: shortenSymbol(definition.symbol), question, cheapOnly, oracleOnly });
  }
}

// ts-morph findReferences enumerates all in-project references, so it is a
// complete oracle for `references` (precision + recall both valid). Its
// calleesFor only reports confidently-resolved call shapes — a PARTIAL
// oracle: cheap-only callees are unverified, not wrong, so only recall holds.
const SEMANTIC_ORACLE_COMPLETE: Record<AuditQuestion, boolean> = {
  references: true,
  callees: false,
  renders: false,
};

/** Call and render sites the source parser found inside one definition's range. */
function callSiteKindsInDefinition(
  db: ScipDatabase,
  definition: IndexedDefinition,
): { calls: number; renders: number } {
  const facts = getSourceFacts(db, definition.relativePath);
  let calls = 0;
  let renders = 0;
  for (const site of facts?.callSites ?? []) {
    if (site.line < definition.startLine || site.line > definition.endLine) continue;
    if (site.kind === 'jsx-render') renders += 1;
    else calls += 1;
  }
  return { calls, renders };
}

function finalizeScore(question: AuditQuestion, tally: QuestionTally, oracleKind: AuditOracleKind): AuditQuestionScore {
  const recall = tally.oracleTotal > 0 ? tally.agreed / tally.oracleTotal : 1;
  // Precision is defined only where the oracle was complete: a cheap-only
  // answer next to a partial oracle is unverified, not wrong.
  const precision = tally.completeCheapTotal > 0 ? round3(tally.completeAgreed / tally.completeCheapTotal) : null;
  const unverified = tally.cheapTotal - tally.agreed - (tally.completeCheapTotal - tally.completeAgreed);
  void oracleKind;
  return {
    question,
    comparedSymbols: tally.comparedSymbols,
    precision,
    recall: round3(recall),
    unverified,
    skippedOraclePartial: tally.skippedOraclePartial,
    completeOracleSymbols: tally.completeSymbols,
    outsideOracleCoverage: tally.outsideCoverage,
    cheapSources: tally.sources,
  };
}

function oracleComplete(oracleKind: AuditOracleKind, question: AuditQuestion): boolean {
  return oracleKind === 'semantic' ? SEMANTIC_ORACLE_COMPLETE[question] : false;
}

interface SourceOracle {
  referencesBySymbolId: Map<number, Set<string>>;
  calleesBySymbolId: Map<number, Set<string>>;
}

function canSourceAuditDefinition(db: ScipDatabase, definition: IndexedDefinition): boolean {
  return (
    detectAstLanguage(definition.relativePath) === 'clojure' && getSourceFacts(db, definition.relativePath) !== null
  );
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function buildClojureSourceOracle(
  db: ScipDatabase,
  index: ProjectIndex,
  sampled: readonly IndexedDefinition[],
): SourceOracle {
  const referencesBySymbolId = new Map<number, Set<string>>();
  const calleesBySymbolId = new Map<number, Set<string>>();
  const sampledClojure = sampled.filter((definition) => canSourceAuditDefinition(db, definition));
  const sampledByLeaf = new Map<string, IndexedDefinition[]>();
  for (const definition of sampledClojure) {
    const bucket = sampledByLeaf.get(definition.leaf) ?? [];
    bucket.push(definition);
    sampledByLeaf.set(definition.leaf, bucket);
  }

  for (const sourceFile of index.sourceFiles()) {
    if (detectAstLanguage(sourceFile) !== 'clojure') continue;
    const facts = getSourceFacts(db, sourceFile);
    if (!facts) continue;
    for (const leaf of facts.fileIdentifiers) {
      for (const definition of sampledByLeaf.get(leaf) ?? []) {
        addSetValue(referencesBySymbolId, definition.symbolId, sourceFile);
      }
    }
  }

  const clojureDefinitionsByLeaf = new Map<string, IndexedDefinition[]>();
  for (const definition of index.scopedDefinitions()) {
    if (detectAstLanguage(definition.relativePath) !== 'clojure') continue;
    const bucket = clojureDefinitionsByLeaf.get(definition.leaf) ?? [];
    bucket.push(definition);
    clojureDefinitionsByLeaf.set(definition.leaf, bucket);
  }

  for (const definition of sampledClojure) {
    const facts = getSourceFacts(db, definition.relativePath);
    if (!facts) continue;
    for (const site of facts.callSites) {
      if (site.line < definition.startLine || site.line > definition.endLine) continue;
      for (const callee of clojureDefinitionsByLeaf.get(site.calleeLeaf) ?? []) {
        addSetValue(calleesBySymbolId, definition.symbolId, callee.relativePath);
      }
    }
  }

  return { referencesBySymbolId, calleesBySymbolId };
}

function addSetValue(map: Map<number, Set<string>>, key: number, value: string): void {
  const existing = map.get(key);
  if (existing) {
    existing.add(value);
    return;
  }
  map.set(key, new Set([value]));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
