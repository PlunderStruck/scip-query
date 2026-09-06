import { describe, expect, it } from 'vitest';

import type { RepositoryContextResult } from '../../src/queries/impact/context.js';
import { repositoryContextDecisionSections } from '../../src/runtime/query-commands/planning.js';

describe('context decision packet', () => {
  it('keeps the default packet focused on decisions and names opt-in expansion routes', () => {
    const sections = repositoryContextDecisionSections(result(), 'runTask', 20, 3, 3);
    const titles = sections.map((section) => section.title);
    const output = sections.flatMap((section) => section.rows).join('\n');

    expect(titles).toEqual([
      'TARGET',
      'CURRENT RELATIONSHIPS',
      'AFFECTED CONSUMERS',
      'SIMILARITY CANDIDATES',
      'CHANGE CONSTRAINTS',
      'RELATED SOURCE IDENTITIES',
      'SOURCE PACKET',
      'COVERAGE AND RECOVERY',
    ]);
    expect(output).toContain('src/run-task.ts:11-14');
    expect(output).toContain('direct  src/consumer.ts:8');
    expect(output).toContain('src/existing-owner.ts');
    expect(output).toContain('Current wiring or reachability alone does not justify separate ownership');
    expect(output).toContain('scip-query refs runTask --full');
    expect(output).toContain('scip-query context runTask --detail');
    expect(output).toContain('Source packet: 1/1 slice(s)');
    expect(output).toContain('src/run-task.ts:11');
    expect(output).not.toContain('sharedCallees');
    expect(sections.find((section) => section.title === 'RELATED SOURCE IDENTITIES')?.rows).not.toContain('  ');
    expect(output).not.toContain('decide');
  });
});

function result(): RepositoryContextResult {
  return {
    target: 'runTask',
    matched: { symbol: true, file: true, module: true },
    history: {
      available: false,
      file: null,
      churn: null,
      coChangePartners: [],
      suppressionsInFile: 0,
    },
    trace: {
      definitions: [
        {
          relativePath: 'src/run-task.ts',
          startLine: 10,
          endLine: 13,
          signature: 'runTask()',
          source: 'export function runTask() {}',
        },
      ],
      referencedBy: [
        {
          relativePath: 'src/consumer.ts',
          line: 7,
          enclosingSymbol: 'consumer',
          enclosingShort: 'consumer()',
        },
      ],
    },
    callGraph: {
      symbol: 'runTask',
      shortName: 'runTask()',
      callers: [{ symbol: 'consumer', shortName: 'consumer()', file: 'src/consumer.ts' }],
      callees: [{ symbol: 'persist', shortName: 'persist()', file: 'src/store.ts' }],
    },
    complexity: null,
    dataflow: null,
    backwardSlice: null,
    forwardSlice: null,
    affected: [{ symbol: 'consumer', shortName: 'consumer()', file: 'src/consumer.ts', depth: 1 }],
    changeSurface: null,
    deps: [],
    rdeps: [],
    system: { files: ['src/run-task.ts'], symbols: [], dependsOn: [], dependedOnBy: [] },
    surface: [],
    reuseCandidates: [
      {
        symbolA: 'runTask',
        shortNameA: 'runTask()',
        fileA: 'src/run-task.ts',
        symbolB: 'existingOwner',
        shortNameB: 'existingOwner()',
        fileB: 'src/existing-owner.ts',
        similarity: 0.8,
        similarityBasis: 'callees',
        sharedCallees: ['persist'],
        uniqueToA: [],
        uniqueToB: [],
        evidenceClass: 'domain-behavior',
        actionTier: 'direct',
        evidenceClassReasons: ['same effect'],
        recommendation: 'Reuse the existing owner.',
      },
      {
        symbolA: 'runTask',
        shortNameA: 'runTask()',
        fileA: 'src/run-task.ts',
        symbolB: 'anonymousOwner',
        shortNameB: 'anonymousOwner()',
        fileB: '',
        similarity: 0.7,
        similarityBasis: 'callees',
        sharedCallees: ['persist'],
        uniqueToA: [],
        uniqueToB: [],
        evidenceClass: 'domain-behavior',
        actionTier: 'review',
        evidenceClassReasons: ['missing source path'],
        recommendation: 'Review before reuse.',
      },
    ],
    affectedConsumerReuse: {
      candidates: [],
      coverage: {
        totalConsumers: 1,
        analyzedConsumers: 1,
        omittedConsumers: 0,
        perConsumerSearchLimit: 10,
        perConsumerCandidateLimit: 3,
        candidateLimit: 8,
        returnedCandidates: 0,
      },
    },
    sourcePacket: {
      slices: [
        {
          role: 'target',
          symbol: 'runTask',
          shortName: 'runTask()',
          file: 'src/run-task.ts',
          startLine: 10,
          endLine: 10,
          source: 'export function runTask() {}',
          omittedLines: 0,
        },
      ],
      candidateSlices: 1,
      omittedSlices: 0,
      maxSlices: 8,
      maxLinesPerSlice: 40,
      maxTotalLines: 200,
    },
    warnings: [],
  };
}
