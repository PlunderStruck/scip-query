import type { ScipDatabase } from '../../storage/db.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { ProjectIndex } from '../../core/project-index.js';
import { getSemanticProvider } from '../../semantic/index.js';
import { semanticCalleeMap, semanticReferences } from '../../semantic/shared-primitives.js';
import { getResolvedReferenceSites } from '../../symbols/references/reference-sites.js';
import { shortenSymbol } from '../../symbols/symbol-parser.js';

export type AuditQuestion = 'references' | 'callees';

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
}

export interface SelfAuditResult {
  /** False when no semantic provider is available — nothing to audit against. */
  available: boolean;
  sampleSize: number;
  /** Fraction of sampled symbols the oracle could answer at all. */
  oracleCoverage: number;
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
  if (sampled.length === 0 || !oracleAvailable(db, sampled)) {
    return { available: false, sampleSize: sampled.length, oracleCoverage: 0, scores: [], topDisagreements: [] };
  }

  const tallies: Record<AuditQuestion, QuestionTally> = {
    references: emptyTally(),
    callees: emptyTally(),
  };
  const disagreements: AuditDisagreement[] = [];
  let oracleAnswered = 0;

  const oracleCallees = semanticCalleeMap(db, sampled);
  for (const definition of sampled) {
    const oracleRefs = crossFileSet(
      definition,
      semanticReferences(db, definition).map((ref) => ref.file),
    );
    const oracleCals = crossFileSet(
      definition,
      (oracleCallees.get(definition.symbolId) ?? []).map((callee) => callee.file),
    );
    if (oracleRefs.size === 0 && oracleCals.size === 0) continue; // oracle had nothing to say
    oracleAnswered += 1;

    const cheapRefs = crossFileSet(
      definition,
      getResolvedReferenceSites(db, definition).map((site) => site.file),
    );
    const cheapCals = crossFileSet(
      definition,
      (index.calleeMap([definition], { semantic: false }).get(definition.symbolId) ?? []).map((callee) => callee.file),
    );

    scoreQuestion(tallies.references, definition, 'references', cheapRefs, oracleRefs, disagreements);
    scoreQuestion(tallies.callees, definition, 'callees', cheapCals, oracleCals, disagreements);
  }

  disagreements.sort(
    (left, right) =>
      right.cheapOnly.length + right.oracleOnly.length - (left.cheapOnly.length + left.oracleOnly.length),
  );

  return {
    available: true,
    sampleSize: sampled.length,
    oracleCoverage: sampled.length > 0 ? round3(oracleAnswered / sampled.length) : 0,
    scores: (['references', 'callees'] as const).map((question) => finalizeScore(question, tallies[question])),
    topDisagreements: disagreements.slice(0, maxDisagreements),
  };
}

interface QuestionTally {
  comparedSymbols: number;
  agreed: number;
  cheapTotal: number;
  oracleTotal: number;
}

function emptyTally(): QuestionTally {
  return { comparedSymbols: 0, agreed: 0, cheapTotal: 0, oracleTotal: 0 };
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

function oracleAvailable(db: ScipDatabase, sampled: readonly IndexedDefinition[]): boolean {
  const probe = sampled[0];
  if (!probe) return false;
  try {
    return getSemanticProvider(db, probe.relativePath).availability().available;
  } catch {
    return false;
  }
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
  disagreements: AuditDisagreement[],
): void {
  if (cheap.size === 0 && oracle.size === 0) return;
  tally.comparedSymbols += 1;
  tally.cheapTotal += cheap.size;
  tally.oracleTotal += oracle.size;
  const cheapOnly: string[] = [];
  const oracleOnly: string[] = [];
  for (const file of cheap) {
    if (oracle.has(file)) tally.agreed += 1;
    else cheapOnly.push(file);
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
const ORACLE_COMPLETE: Record<AuditQuestion, boolean> = {
  references: true,
  callees: false,
};

function finalizeScore(question: AuditQuestion, tally: QuestionTally): AuditQuestionScore {
  const recall = tally.oracleTotal > 0 ? tally.agreed / tally.oracleTotal : 1;
  const unverified = tally.cheapTotal - tally.agreed;
  return {
    question,
    comparedSymbols: tally.comparedSymbols,
    precision: ORACLE_COMPLETE[question] && tally.cheapTotal > 0 ? round3(tally.agreed / tally.cheapTotal) : null,
    recall: round3(recall),
    unverified,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
