import { classifyFile } from '../../analysis/file-classifier.js';
import type { IndexedDefinition } from '../../domain/types.js';
import { enclosingTypeNames } from '../../symbols/definition-catalog.js';
import {
  isCallableSymbol,
  isFunctionLikeSymbol,
  isInRustTestModule,
  isModuleLikeSymbol,
  isRustTraitImplMember,
  leafName,
} from '../../symbols/symbol-parser.js';

export type DeadCandidateRejectionReason =
  | 'ignored-file'
  | 'module-like-symbol'
  | 'non-value-symbol'
  | 'nested-non-callable-value'
  | 'test-file'
  | 'excluded-file-region'
  | 'implicit-constructor'
  | 'python-protocol-member'
  | 'python-runtime-metadata'
  | 'declaration-only-callable'
  | 'framework-contract-member'
  | 'rust-trait-impl-member'
  | 'rust-test-module'
  | 'member'
  | 'below-min-loc';

export interface DeadCandidateDecision {
  accepted: boolean;
  rejectionReason?: DeadCandidateRejectionReason;
}

type DeadCandidateDefinition = Parameters<typeof deadCandidateDecision>[0];
type DeadCandidateOptions = Parameters<typeof deadCandidateDecision>[1];

function deadDefinitionShapeRejection(
  definition: DeadCandidateDefinition,
  opts: DeadCandidateOptions,
): DeadCandidateRejectionReason | undefined {
  if (opts.isIgnoredPath(definition.relativePath)) return 'ignored-file';
  if (isModuleLikeSymbol(definition.symbol)) return 'module-like-symbol';
  if (!looksValueLikeDefinition(definition.symbol)) return 'non-value-symbol';
  if (!definition.isFunctionLike && definition.enclosingSymbol && looksValueLikeDefinition(definition.enclosingSymbol))
    return 'nested-non-callable-value';
  return undefined;
}

function deadFileRegionRejection(
  definition: DeadCandidateDefinition,
  opts: DeadCandidateOptions,
): DeadCandidateRejectionReason | undefined {
  if (!opts.includeTests && !passesDeadTestFileFilter(definition.relativePath)) return 'test-file';
  if (
    !opts.includeTests &&
    opts.isExcludedRegion(definition.relativePath, definition.startLine, definition.symbol, definition.parentTypeName)
  )
    return 'excluded-file-region';
  return undefined;
}

function deadImplicitInvocationRejection(
  definition: DeadCandidateDefinition,
): DeadCandidateRejectionReason | undefined {
  // Constructors are invoked through instances/subclasses; Python protocol members
  // and __all__ are consumed by the language without direct SCIP call edges.
  const leaf = leafName(definition.symbol);
  if (leaf === '<constructor>') return 'implicit-constructor';
  if (!definition.symbol.startsWith('scip-python ')) return undefined;
  if (leaf === '__all__') return 'python-runtime-metadata';
  if (/^__[^_].*__$/.test(leaf)) return 'python-protocol-member';
  return undefined;
}

function deadContractRejection(
  definition: DeadCandidateDefinition,
  opts: DeadCandidateOptions,
): DeadCandidateRejectionReason | undefined {
  // Abstract/interface contracts and Rust trait impl members can be consumed
  // through dispatch without a direct call to the indexed declaration.
  if (opts.isDeclarationOnlyCallable()) return 'declaration-only-callable';
  if (opts.isFrameworkContractCallable()) return 'framework-contract-member';
  if (isRustTraitImplMember(definition.symbol)) return 'rust-trait-impl-member';
  return undefined;
}

function deadCandidateScopeRejection(
  definition: DeadCandidateDefinition,
  opts: DeadCandidateOptions,
): DeadCandidateRejectionReason | undefined {
  if (isInRustTestModule(definition.symbol)) return 'rust-test-module';
  if (!opts.includeMembers && !isTopLevelOrCallable(definition)) return 'member';
  if (definition.endLine - definition.startLine + 1 < opts.minLoc) return 'below-min-loc';
  return undefined;
}

// scip-query: ignore-extract — this is the ordered dead-candidate rejection
// gate; the first matching reason is part of the public diagnostic policy.
export function deadCandidateDecision(
  definition: Pick<
    IndexedDefinition,
    'relativePath' | 'startLine' | 'endLine' | 'symbol' | 'isFunctionLike' | 'enclosingSymbol' | 'parentTypeName'
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
    isDeclarationOnlyCallable: () => boolean;
    isFrameworkContractCallable: () => boolean;
  },
): DeadCandidateDecision {
  const reason =
    deadDefinitionShapeRejection(definition, opts) ??
    deadFileRegionRejection(definition, opts) ??
    deadImplicitInvocationRejection(definition) ??
    deadContractRejection(definition, opts) ??
    deadCandidateScopeRejection(definition, opts);
  return reason === undefined ? { accepted: true } : rejectDeadCandidate(reason);
}

/**
 * One test-file policy for the whole detector family: `classifyFile` is the
 * single owner of "is this a test file?". This used to re-implement the
 * answer with SQL LIKE patterns, which drifted from the classifier.
 */
// scip-query: ignore-wrapper — dead.ts depends on the detector policy name;
// classifyFile remains the test-file authority.
export function passesDeadTestFileFilter(relativePath: string): boolean {
  return classifyFile(relativePath) !== 'test';
}

function rejectDeadCandidate(rejectionReason: DeadCandidateRejectionReason): DeadCandidateDecision {
  return { accepted: false, rejectionReason };
}

// scip-query: ignore-wrapper — dead.ts reads this as candidate-shape policy;
// keep the symbol-shape rule named beside the other dead candidate gates.
export function looksValueLikeDefinition(rawSymbol: string): boolean {
  return isFunctionLikeSymbol(rawSymbol) || rawSymbol.endsWith('().') || rawSymbol.endsWith('.');
}

function isTopLevelOrCallable(definition: {
  isFunctionLike: boolean;
  parentTypeName: string | null;
  symbol: string;
}): boolean {
  return isCallableSymbol(definition.symbol) || enclosingTypeNames(definition.symbol).length === 0;
}
