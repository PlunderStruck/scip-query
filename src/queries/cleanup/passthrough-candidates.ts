import { basename, extname } from 'node:path';
import { isRootedSymbol } from '../../analysis/file-classifier.js';
import { isPackageSurfaceFile } from '../../analysis/package-surface.js';
import type { ScipDatabase } from '../../storage/db.js';
import { isClojureMacroDefinition, isLiteralPassthrough } from '../../source/ast.js';
import { getSourceLines } from '../../source/source-text.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { isFunctionLikeSymbol, leafName, shortenSymbol } from '../../symbols/symbol-parser.js';
import { ProjectIndex } from '../../core/project-index.js';
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
  return runCandidateAnalysis({
      candidates: () => getPassthroughCandidateSymbols(db, index, scope, maxLoc),
      orderCandidates: compareDefinitionsBySmallestLoc,
      scanLimit,
      profile: { name: 'passthrough-candidates' },
      prepare: (symbols) => index.calleeMap(symbols, { semantic: opts?.semantic !== false }),
      evaluate: (sym, calleeMap) => passthroughCandidateForSymbol(db, sym, calleeMap.get(sym.symbolId) ?? []),
    orderResults: (a, b) => a.loc - b.loc || a.file.localeCompare(b.file),
    limit,
  });
}

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

function isExportedDefinition(db: ScipDatabase, sym: IndexedDefinition): boolean {
  const lines = getSourceLines(db, sym.relativePath);
  if (lines.length === 0) return false;
  const declarationWindow = lines.slice(Math.max(0, sym.startLine - 2), sym.startLine + 1).join('\n');
  if (EXPORTED_DEFINITION_PATTERN.test(declarationWindow)) return true;
  return hasNamedExport(lines, leafName(sym.symbol));
}

function hasNamedExport(lines: readonly string[], name: string): boolean {
  if (!name) return false;
  const pattern = new RegExp(`^\\s*export\\s*\\{[^}\\n]*\\b${escapeRegExp(name)}\\b`);
  return lines.some((line) => pattern.test(line));
}

function isPublicSurfaceEvidence(evidence: string): boolean {
  return evidence.includes('public surface');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

const EXPORTED_DEFINITION_PATTERN = /^\s*export\s+(?:default\s+)?(?:(?:async\s+)?function\b|(?:const|let|var)\b)/m;
