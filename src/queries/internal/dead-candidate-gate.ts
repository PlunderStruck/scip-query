import { TEST_FILE_PATTERNS, TEST_SUPPORT_PATH_PATTERNS } from '../../analysis/file-classifier.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { enclosingTypeNames } from '../../symbols/definition-catalog.js';
import {
  isCallableSymbol,
  isFunctionLikeSymbol,
  isInRustTestModule,
  isModuleLikeSymbol,
  isRustTraitImplMember,
} from '../../symbols/symbol-parser.js';

export type DeadCandidateRejectionReason =
  | 'ignored-file'
  | 'module-like-symbol'
  | 'non-value-symbol'
  | 'nested-non-callable-value'
  | 'test-file'
  | 'excluded-file-region'
  | 'rust-trait-impl-member'
  | 'rust-test-module'
  | 'member'
  | 'below-min-loc';

export interface DeadCandidateDecision {
  accepted: boolean;
  rejectionReason?: DeadCandidateRejectionReason;
}

// scip-query: ignore-extract — this is the ordered dead-candidate rejection
// gate; the first matching reason is part of the public diagnostic policy.
export function deadCandidateDecision(
  definition: Pick<IndexedDefinition,
    | 'relativePath'
    | 'startLine'
    | 'endLine'
    | 'symbol'
    | 'isFunctionLike'
    | 'enclosingSymbol'
    | 'parentTypeName'
  >,
  opts: {
    minLoc: number;
    includeTests: boolean;
    includeMembers: boolean;
    isIgnoredPath: (relativePath: string) => boolean;
    isExcludedRegion: (
      relativePath: string,
      startLine: number,
      symbol: string,
      parentTypeName: string | null,
    ) => boolean;
  },
): DeadCandidateDecision {
  if (opts.isIgnoredPath(definition.relativePath)) return rejectDeadCandidate('ignored-file');
  if (isModuleLikeSymbol(definition.symbol)) return rejectDeadCandidate('module-like-symbol');
  if (!looksValueLikeDefinition(definition.symbol)) return rejectDeadCandidate('non-value-symbol');
  if (
    !definition.isFunctionLike
    && definition.enclosingSymbol
    && looksValueLikeDefinition(definition.enclosingSymbol)
  ) return rejectDeadCandidate('nested-non-callable-value');
  if (!opts.includeTests && !passesDeadTestFileFilter(definition.relativePath)) return rejectDeadCandidate('test-file');
  if (
    !opts.includeTests
    && opts.isExcludedRegion(definition.relativePath, definition.startLine, definition.symbol, definition.parentTypeName)
  ) return rejectDeadCandidate('excluded-file-region');
  // rust-analyzer encodes trait impls as `impl#[Type][Trait]Member.` and
  // inherent impls as `impl#[Type]Member.`. Trait-impl members are reached
  // through the trait, which SCIP rarely traces accurately.
  if (isRustTraitImplMember(definition.symbol)) return rejectDeadCandidate('rust-trait-impl-member');
  // Inline test mods (`#[cfg(test)] mod tests`) live in regular source files
  // but the items inside them are not shippable code.
  if (isInRustTestModule(definition.symbol)) return rejectDeadCandidate('rust-test-module');
  if (!opts.includeMembers && !isTopLevelOrCallable(definition)) return rejectDeadCandidate('member');
  if ((definition.endLine - definition.startLine + 1) < opts.minLoc) return rejectDeadCandidate('below-min-loc');
  return { accepted: true };
}

export function passesDeadTestFileFilter(relativePath: string): boolean {
  const patterns = [...new Set([...TEST_FILE_PATTERNS, ...TEST_SUPPORT_PATH_PATTERNS])];
  return patterns.every((pattern) => !likeMatches(relativePath, pattern));
}

function rejectDeadCandidate(rejectionReason: DeadCandidateRejectionReason): DeadCandidateDecision {
  return { accepted: false, rejectionReason };
}

function likeMatches(value: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.')}$`);
  return regex.test(value);
}

function looksValueLikeDefinition(rawSymbol: string): boolean {
  return isFunctionLikeSymbol(rawSymbol) || rawSymbol.endsWith('().') || rawSymbol.endsWith('.');
}

function isTopLevelOrCallable(definition: { isFunctionLike: boolean; parentTypeName: string | null; symbol: string }): boolean {
  return isCallableSymbol(definition.symbol) || enclosingTypeNames(definition.symbol).length === 0;
}
