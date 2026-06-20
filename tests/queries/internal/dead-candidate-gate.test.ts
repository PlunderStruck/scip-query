import { describe, expect, it } from 'vitest';
import { deadCandidateDecision } from '../../../src/queries/internal/dead-candidate-gate.js';

type DeadCandidateDecisionOptions = Parameters<typeof deadCandidateDecision>[1];

const baseDefinition = {
  relativePath: 'src/domain.ts',
  startLine: 10,
  endLine: 15,
  symbol: 'scip-typescript npm fixture 1.0.0 src/`domain.ts`/buildDomain().',
  isFunctionLike: true,
  enclosingSymbol: null,
  parentTypeName: null,
};

const baseOptions: DeadCandidateDecisionOptions = {
  minLoc: 1,
  includeTests: false,
  includeMembers: false,
  isIgnoredPath: () => false,
  isExcludedRegion: () => false,
};

describe('dead candidate gate', () => {
  it('accepts a production top-level callable above the LOC threshold', () => {
    expect(deadCandidateDecision(baseDefinition, baseOptions)).toEqual({ accepted: true });
  });

  it('reports the first load-bearing rejection reason in gate order', () => {
    expect(
      deadCandidateDecision(
        {
          ...baseDefinition,
          relativePath: 'tests/domain.test.ts',
          symbol: 'scip-typescript npm fixture 1.0.0 src/`domain.ts`/outer().value.',
          isFunctionLike: false,
          enclosingSymbol: 'scip-typescript npm fixture 1.0.0 src/`domain.ts`/outer().',
        },
        baseOptions,
      ),
    ).toEqual({
      accepted: false,
      rejectionReason: 'nested-non-callable-value',
    });
  });

  it('keeps Rust trait impl members out of dead-code candidates', () => {
    expect(
      deadCandidateDecision(
        {
          ...baseDefinition,
          symbol: 'rust-analyzer cargo fixture 0.1.0 src/`lib.rs`/impl#[Service][Display]fmt().',
        },
        baseOptions,
      ),
    ).toEqual({
      accepted: false,
      rejectionReason: 'rust-trait-impl-member',
    });
  });

  it('keeps members out unless member scanning is requested', () => {
    const member = {
      ...baseDefinition,
      symbol: 'scip-typescript npm fixture 1.0.0 src/`domain.ts`/Model#value.',
      isFunctionLike: false,
      parentTypeName: 'Model',
    };

    expect(deadCandidateDecision(member, baseOptions)).toEqual({
      accepted: false,
      rejectionReason: 'member',
    });
    expect(
      deadCandidateDecision(member, {
        ...baseOptions,
        includeMembers: true,
      }),
    ).toEqual({ accepted: true });
  });
});
