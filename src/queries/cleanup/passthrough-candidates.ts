import { basename, extname } from 'node:path';
import { isExportedDefinition } from '../internal/exported-definition.js';
import { isRootedSymbol } from '../../analysis/file-classifier.js';
import { isPackageSurfaceFile } from '../../analysis/package-surface.js';
import type { ScipDatabase } from '../../storage/db.js';
import { isClojureMacroDefinition, isLiteralPassthrough } from '../../source/ast.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { isFunctionLikeSymbol, shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../internal/project-index.js';
import { compareDefinitionsBySmallestLoc, definitionLoc } from '../query-utils.js';
import { runCandidateAnalysis } from '../internal/candidate-scan.js';
import { boundaryEvidenceForSurfaces } from './boundary-evidence.js';

export type PassthroughActionTier = 'direct' | 'signal';

export interface PassthroughCandidate {
  symbol: string;
  shortName: string;
  file: string;
  startLine: number;
  endLine: number;
  loc: number;
  forwardsTo: string;
  forwardsToShort: string;
  forwardsToFile: string;
  actionTier: PassthroughActionTier;
  boundaryEvidence: string[];
  publicFacadeEvidence: string[];
  recommendation: string;
}

/**
 * Find passthrough candidates: functions that just forward to one
 * other function.
 *
 * A function with exactly 1 callee and small LOC is likely a thin
 * wrapper that adds no value — it just passes arguments through to
 * the real implementation.
 */
// scip-query: ignore-extract — this is the passthrough-candidate command
// pipeline: production symbols, callee map, per-symbol scoring, sorting, and
// summary are one result contract.
export function passthroughCandidates(
  db: ScipDatabase,
  opts?: { scope?: string; maxLoc?: number; limit?: number; scanLimit?: number; semantic?: boolean },
): PassthroughCandidate[] {
  const { scope, maxLoc = 15, limit = 30, scanLimit } = opts ?? {};
  const index = new ProjectIndex(db);
  const results = runCandidateAnalysis({
    candidates: () => getPassthroughCandidateSymbols(db, index, scope, maxLoc),
    orderCandidates: compareDefinitionsBySmallestLoc,
    scanLimit,
    profile: { name: 'passthrough-candidates' },
    prepare: (symbols) => index.calleeMap(symbols, { semantic: opts?.semantic !== false }),
    evaluate: (sym, calleeMap) => passthroughCandidateForSymbol(db, sym, calleeMap.get(sym.symbolId) ?? []),
    orderResults: (a, b) => a.loc - b.loc || a.file.localeCompare(b.file),
  });
  return applyFacadeEvidence(results).slice(0, limit === undefined ? results.length : limit);
}

/** Sibling forwards from one file to one target file that make the file a deliberate facade. */
const FACADE_SIBLING_FORWARDS = 3;

/**
 * A file whose methods forward one by one to the same collaborator is a
 * facade: it exists to keep one public surface over a module that was split
 * behind it (a service composed of sub-services, a package entry over its
 * internals). Inlining any single forward would breach that surface, so the
 * whole family is a boundary signal rather than direct inline advice.
 */
export function applyFacadeEvidence(candidates: readonly PassthroughCandidate[]): PassthroughCandidate[] {
  const siblingForwards = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.file === candidate.forwardsToFile) continue;
    const key = `${candidate.file}\u0000${candidate.forwardsToFile}`;
    siblingForwards.set(key, (siblingForwards.get(key) ?? 0) + 1);
  }
  return candidates.map((candidate) => {
    const siblings = siblingForwards.get(`${candidate.file}\u0000${candidate.forwardsToFile}`) ?? 0;
    if (siblings < FACADE_SIBLING_FORWARDS) return candidate;
    const evidence = `facade: ${siblings} sibling forwards from this file to ${candidate.forwardsToFile}`;
    const boundaryEvidence = [...candidate.boundaryEvidence, evidence];
    return {
      ...candidate,
      boundaryEvidence,
      actionTier: 'signal',
      recommendation: passthroughRecommendation('signal', boundaryEvidence, candidate.publicFacadeEvidence),
    };
  });
}

// scip-query: ignore-extract — reviewed E1 workflow owner; ordered policy and shared state stay in this named operation.
function passthroughCandidateForSymbol(
  db: ScipDatabase,
  sym: IndexedDefinition,
  rawCallees: readonly { symbol: string; file: string }[],
): PassthroughCandidate | null {
  const uniqueCallees = uniquePassthroughCallees(rawCallees);
  if (uniqueCallees.size !== 1) return null;
  // Body-shape gate: must be `return inner(args)` where args === params,
  // not a type guard / partial application / defaulted wrapper that happens
  // to call exactly one function.
  if (!isLiteralPassthrough(db, sym.relativePath, sym.startLine, sym.endLine)) return null;

  const [, callee] = [...uniqueCallees.entries()][0]!;
  const boundaryEvidence = passthroughBoundaryEvidence(db, sym, callee);
  const publicFacadeEvidenceItems = publicFacadeEvidence(db, sym);
  const actionTier: PassthroughActionTier =
    boundaryEvidence.length > 0 || publicFacadeEvidenceItems.length > 0 ? 'signal' : 'direct';
  return {
    symbol: sym.symbol,
    shortName: shortenSymbol(sym.symbol),
    file: sym.relativePath,
    startLine: sym.startLine,
    endLine: sym.endLine,
    loc: definitionLoc(sym),
    forwardsTo: callee.symbol,
    forwardsToShort: shortenSymbol(callee.symbol),
    forwardsToFile: callee.file,
    actionTier,
    boundaryEvidence,
    publicFacadeEvidence: publicFacadeEvidenceItems,
    recommendation: passthroughRecommendation(actionTier, boundaryEvidence, publicFacadeEvidenceItems),
  };
}

function passthroughBoundaryEvidence(
  db: ScipDatabase,
  sym: IndexedDefinition,
  callee: { symbol: string; file: string },
): string[] {
  return boundaryEvidenceForSurfaces(
    db,
    sym.relativePath,
    sym.startLine,
    'passthrough',
    'explicit ignore-passthrough comment',
    [
      { label: 'passthrough name', value: shortenSymbol(sym.symbol) },
      { label: 'callee name', value: shortenSymbol(callee.symbol) },
      { label: 'passthrough module', value: basename(sym.relativePath, extname(sym.relativePath)) },
      { label: 'callee module', value: basename(callee.file, extname(callee.file)) },
    ],
  );
}

function passthroughRecommendation(
  actionTier: PassthroughActionTier,
  boundaryEvidence: readonly string[],
  publicFacadeEvidence: readonly string[],
): string {
  if (actionTier === 'signal') {
    if (publicFacadeEvidence.length > 0) {
      return `Review the public API before inlining; public-facade evidence: ${publicFacadeEvidence.slice(0, 2).join('; ')}.`;
    }
    const publicSurfaceEvidence = boundaryEvidence.filter(isPublicSurfaceEvidence);
    if (publicSurfaceEvidence.length > 0) {
      return `Review the public API before inlining; public-surface evidence: ${publicSurfaceEvidence.slice(0, 2).join('; ')}.`;
    }
    return `Review the boundary before inlining; boundary evidence: ${boundaryEvidence.slice(0, 2).join('; ')}.`;
  }
  return 'Inline or remove this passthrough unless an external API or runtime registration depends on the forwarding name.';
}

function publicFacadeEvidence(db: ScipDatabase, sym: IndexedDefinition): string[] {
  if (!isExportedDefinition(db, sym)) return [];
  if (isPackageSurfaceFile(db, sym.relativePath)) {
    return ['exported passthrough is declared on the package public surface'];
  }
  if (isRootedSymbol(db, sym.symbol, sym.relativePath)) {
    return ['exported passthrough matches configured or framework public entry surface'];
  }
  return [];
}

/**
 * Textual export check: does `sym`'s declaration line carry an `export`
 * keyword, or does the file re-export its leaf name via `export { name }`?
 * Reused by `twin-ab` to refuse scaffolding a test against a symbol that
 * cannot actually be imported.
 */
export { isExportedDefinition } from '../internal/exported-definition.js';

function isPublicSurfaceEvidence(evidence: string): boolean {
  return evidence.includes('public surface');
}

function uniquePassthroughCallees(
  rawCallees: readonly { symbol: string; file: string }[],
): Map<string, { symbol: string; file: string }> {
  const callees = rawCallees.some((c) => isFunctionLikeSymbol(c.symbol))
    ? rawCallees.filter((c) => isFunctionLikeSymbol(c.symbol))
    : rawCallees;
  const uniqueCallees = new Map<string, { symbol: string; file: string }>();
  for (const c of callees) {
    if (!uniqueCallees.has(c.symbol)) uniqueCallees.set(c.symbol, c);
  }
  return uniqueCallees;
}

function getPassthroughCandidateSymbols(
  db: ScipDatabase,
  index: ProjectIndex,
  scope: string | undefined,
  maxLoc: number,
): IndexedDefinition[] {
  return index
    .productionCallableDefinitions({
      scope,
      minLoc: 3,
      maxLoc,
      requireFunctionLikeSymbol: true,
      // Rooted literal passthroughs still matter, but as public-facade signals
      // rather than direct inline/delete advice.
      excludeRustTraitImplMembers: true,
    })
    .filter((definition) => !isClojureMacroDefinition(db, definition));
}
