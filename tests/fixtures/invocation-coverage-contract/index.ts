import type {
  CommandAgentContract,
  InvocationCoverage,
} from '../../../src/runtime/command-kit/command-descriptor-types.js';

const complete: InvocationCoverage = {
  complete: true,
  totalKnown: true,
  returned: 2,
  total: 2,
  omitted: 0,
};
const knownIncomplete: InvocationCoverage = {
  complete: false,
  totalKnown: true,
  returned: 2,
  total: 4,
  omitted: 2,
  continuation: { cursor: 'next', indexGeneration: 'generation' },
};
const unknown: InvocationCoverage = {
  complete: null,
  totalKnown: false,
  returned: 2,
};

// @ts-expect-error complete coverage cannot have a continuation
const completeWithContinuation: InvocationCoverage = {
  complete: true,
  totalKnown: true,
  returned: 2,
  total: 2,
  omitted: 0,
  continuation: { cursor: 'next', indexGeneration: 'generation' },
};
// @ts-expect-error complete coverage cannot omit results
const completeWithOmissions: InvocationCoverage = {
  complete: true,
  totalKnown: true,
  returned: 2,
  total: 4,
  omitted: 2,
};
// @ts-expect-error known incomplete coverage must set complete to false
const nullKnownTotal: InvocationCoverage = { complete: null, totalKnown: true, returned: 2, total: 4, omitted: 2 };
// @ts-expect-error unknown coverage cannot claim totals
const unknownWithTotal: InvocationCoverage = { complete: false, totalKnown: false, returned: 2, total: 4, omitted: 2 };
// @ts-expect-error unknown coverage cannot claim omitted identities
const unknownWithIdentities: InvocationCoverage = {
  complete: false,
  totalKnown: false,
  returned: 2,
  omittedIdentities: ['a'],
};

const completeAgentContract: CommandAgentContract = {
  answers: ['What does this explicit test analysis establish?'],
  returns: ['one typed result'],
  inputs: ['symbol'],
  coverage: 'complete',
  operation: { defaultRole: 'repository-observation' },
  semantic: {
    kind: 'analysis',
    analysis: 'Exercise the compile-time semantic contract.',
    resultMeaning: 'One typed result.',
    nonClaims: ['The fixture establishes no repository fact.'],
    outputCost: 'small',
    frontierClosure: [],
  },
};

// @ts-expect-error every agent-visible command must own an explicit semantic contract
const missingSemanticAgentContract: CommandAgentContract = {
  answers: ['What does this incomplete test analysis establish?'],
  returns: ['one untyped result'],
  inputs: ['symbol'],
  coverage: 'complete',
  operation: { defaultRole: 'repository-observation' },
};

void [
  complete,
  knownIncomplete,
  unknown,
  completeWithContinuation,
  completeWithOmissions,
  nullKnownTotal,
  unknownWithTotal,
  unknownWithIdentities,
  completeAgentContract,
  missingSemanticAgentContract,
];
