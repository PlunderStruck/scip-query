import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  coverageDiverseNextAnchors,
  deduplicateRankedAnchors,
  nextAnchorInspectSafe,
  nextAnchorSelectionTermRank,
  systemMapNextAnchorPacket,
  type RankedNextAnchor,
  writesThroughObjectIdentity,
} from '../../../src/queries/internal/next-anchor-candidates.js';
import type { ConnectedBehaviorStep } from '../../../src/queries/internal/connected-behavior.js';
import { createExplorationTopology } from '../../../src/queries/internal/exploration-topology.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const SOURCE_SYMBOL = 'scip-typescript npm fixture 1.0.0 src/`registry.ts`/exposeHandler().';
const HANDLER_SYMBOL = 'scip-typescript npm fixture 1.0.0 src/`handler.ts`/handleEvent().';

describe('next-anchor target selection', () => {
  it('distinguishes reachable object-state writes from local scalar bookkeeping', () => {
    expect(writesThroughObjectIdentity('cur = c;')).toBe(false);
    expect(writesThroughObjectIdentity('quote = null;')).toBe(false);
    expect(writesThroughObjectIdentity('info.status = "exited";')).toBe(true);
    expect(writesThroughObjectIdentity('this.nextId++;')).toBe(true);
    expect(writesThroughObjectIdentity('state[key] ??= createValue();')).toBe(true);
  });

  it('reserves a semantic continuation for a causal connector and prevents one anchor from monopolizing the budget', () => {
    const steps = [
      step('anchor-a', 'anchor'),
      step('connector', 'connector'),
      step('anchor-b', 'anchor'),
      step('junction', 'junction'),
    ];
    const candidates = [
      candidate('a-1', 'anchor-a', 200),
      candidate('a-2', 'anchor-a', 190),
      candidate('a-3', 'anchor-a', 180),
      candidate('b-1', 'anchor-b', 170),
      candidate('junction-1', 'junction', 160),
      candidate('connector-1', 'connector', 150),
      candidate('connector-2', 'connector', 140),
    ];

    expect(coverageDiverseNextAnchors(candidates, steps, 4).map((item) => item.anchor.id)).toEqual([
      'connector-1',
      'a-1',
      'b-1',
      'a-2',
    ]);
  });

  it('reserves upstream causes and result-producing callbacks before ordinary downstream breadth', () => {
    const steps = [step('anchor-a', 'anchor'), step('anchor-b', 'anchor')];
    const candidates = [
      candidate('a-ordinary', 'anchor-a', 300),
      candidate('b-ordinary', 'anchor-b', 290),
      candidate('upstream-caller', 'anchor-a', 80, { direction: 'upstream', causalRole: 'caller' }),
      candidate('result-callback', 'anchor-b', 70, {
        direction: 'downstream',
        causalRole: 'result-callback',
      }),
    ];

    expect(coverageDiverseNextAnchors(candidates, steps, 4).map((item) => item.anchor.id)).toEqual([
      'upstream-caller',
      'result-callback',
      'a-ordinary',
      'b-ordinary',
    ]);
  });

  it('reserves exact causal targets for distinct rare locator terms inside the fixed budget', () => {
    const steps = [step('anchor-a', 'anchor')];
    const prune = candidate('prune', 'anchor-a', 40);
    prune.selectionTermMatches = ['prun'];
    const history = candidate('entries-for-runner', 'anchor-a', 30);
    history.selectionTermMatches = ['history'];
    const candidates = [
      candidate('ordinary-1', 'anchor-a', 300),
      candidate('ordinary-2', 'anchor-a', 290),
      prune,
      history,
    ];

    expect(coverageDiverseNextAnchors(candidates, steps, 4, ['prun', 'history']).map((item) => item.anchor.id)).toEqual(
      ['prune', 'entries-for-runner', 'ordinary-1', 'ordinary-2'],
    );
  });

  it('prefers a locator term in symbol identity over the same term in an incidental filename', () => {
    const identityMatch = candidate('filter-compacted', 'anchor-a', 40);
    identityMatch.anchor.callsite.calleeLeaf = 'filterCompactedEffect';
    identityMatch.anchor.alternatives[0]!.label = 'filterCompactedEffect';
    identityMatch.anchor.alternatives[0]!.file = 'packages/opencode/src/session/message-v2.ts';
    const filenameMatch = candidate('estimate', 'anchor-a', 300);
    filenameMatch.anchor.alternatives[0]!.label = 'estimate';
    filenameMatch.anchor.alternatives[0]!.file = 'packages/opencode/src/session/compaction.ts';

    expect(nextAnchorSelectionTermRank(identityMatch, 'compaction')).toBe(0);
    expect(nextAnchorSelectionTermRank(filenameMatch, 'compaction')).toBe(1);
    expect(nextAnchorSelectionTermRank(identityMatch, 'retain', { oneHop: 'let retain = tail_start_id;' })).toBe(4);

    identityMatch.selectionTermMatches = ['compaction'];
    identityMatch.selectionTermRanks = { compaction: 0 };
    filenameMatch.selectionTermMatches = ['compaction'];
    filenameMatch.selectionTermRanks = { compaction: 1 };
    expect(
      coverageDiverseNextAnchors([filenameMatch, identityMatch], [step('anchor-a', 'anchor')], 1, ['compaction']).map(
        (item) => item.anchor.id,
      ),
    ).toEqual(['filter-compacted']);
  });

  it('does not let a high-priority ambiguous occurrence replace an exact target identity', () => {
    const exact = candidate('filter-compacted', 'connector', 80);
    exact.anchor.status = 'exact';
    exact.anchor.alternatives[0]!.symbol = 'filter-compacted';
    const ambiguous = candidate('ambiguous-filter', 'anchor', 300);
    ambiguous.anchor.status = 'ambiguous';
    ambiguous.anchor.alternatives = [
      { ...ambiguous.anchor.alternatives[0]!, symbol: 'filter-compacted' },
      { ...ambiguous.anchor.alternatives[0]!, symbol: 'other-filter' },
    ];
    ambiguous.anchor.alternativeCount = 2;

    expect(deduplicateRankedAnchors([ambiguous, exact])).toEqual([exact]);
  });

  it('keeps an oversized target recoverable but out of a one-shot inspect batch', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-next-anchor-inspect-safe-'));
    writeFixtureFiles(root, {
      'src/compact.ts': 'export function compact() { return true; }',
      'src/oversized.ts': `export function oversized() { /* ${'x'.repeat(20_100)} */ return true; }`,
    });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/compact.ts')
      .document(2, 'typescript', 'src/oversized.ts')
      .write();
    const db = new ScipDatabase({ dbPath, indexPath: join(root, 'index.scip'), projectRoot: root });
    try {
      const compact = candidate('compact', 'anchor', 1);
      compact.anchor.alternatives[0]!.file = 'src/compact.ts';
      compact.anchor.alternatives[0]!.line = 0;
      compact.anchor.alternatives[0]!.endLine = 0;
      const oversized = candidate('oversized', 'anchor', 1);
      oversized.anchor.alternatives[0]!.file = 'src/oversized.ts';
      oversized.anchor.alternatives[0]!.line = 0;
      oversized.anchor.alternatives[0]!.endLine = 0;

      expect(nextAnchorInspectSafe(db, compact)).toBe(true);
      expect(nextAnchorInspectSafe(db, oversized)).toBe(false);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reserves upstream causes from distinct repository areas for parallel implementations', () => {
    const steps = [step('anchor-a', 'anchor'), step('anchor-b', 'anchor')];
    const coreCaller = candidate('core-caller', 'anchor-a', 90, { direction: 'upstream', causalRole: 'caller' });
    coreCaller.anchor.alternatives[0]!.file = 'packages/core/src/session.ts';
    const legacyCaller = candidate('legacy-caller', 'anchor-b', 80, {
      direction: 'upstream',
      causalRole: 'caller',
    });
    legacyCaller.anchor.alternatives[0]!.file = 'packages/legacy/src/session.ts';
    const sameCoreCaller = candidate('same-core-caller', 'anchor-a', 70, {
      direction: 'upstream',
      causalRole: 'caller',
    });
    sameCoreCaller.anchor.alternatives[0]!.file = 'packages/core/src/runner.ts';
    const resultCallback = candidate('result-callback', 'anchor-b', 60, {
      direction: 'downstream',
      causalRole: 'result-callback',
    });
    const candidates = [
      candidate('a-ordinary', 'anchor-a', 300),
      candidate('b-ordinary', 'anchor-b', 290),
      coreCaller,
      legacyCaller,
      sameCoreCaller,
      resultCallback,
    ];

    expect(coverageDiverseNextAnchors(candidates, steps, 6).map((item) => item.anchor.id)).toEqual([
      'core-caller',
      'legacy-caller',
      'result-callback',
      'a-ordinary',
      'b-ordinary',
      'same-core-caller',
    ]);
  });

  it('preserves distinct downstream evidence dimensions inside the fixed packet budget', () => {
    const steps = [step('anchor-a', 'anchor')];
    const candidates = [
      candidate('ordinary-1', 'anchor-a', 500),
      candidate('ordinary-2', 'anchor-a', 490),
      candidate('ordinary-3', 'anchor-a', 480),
      candidate('control', 'anchor-a', 100, {}, ['call', 'branch']),
      candidate('effect', 'anchor-a', 90, {}, ['call', 'await']),
      candidate('result', 'anchor-a', 80, {}, ['call', 'return']),
      candidate('value', 'anchor-a', 70, {}, ['call', 'binding']),
    ];

    expect(coverageDiverseNextAnchors(candidates, steps, 6).map((item) => item.anchor.id)).toEqual([
      'ordinary-1',
      'control',
      'effect',
      'result',
      'value',
      'ordinary-2',
    ]);
  });

  it('does not reserve ambiguous identity candidates as evidence coverage', () => {
    const steps = [step('anchor-a', 'anchor')];
    const ambiguous = candidate('ambiguous-control', 'anchor-a', 200, {}, ['call', 'branch']);
    ambiguous.anchor.status = 'ambiguous';
    ambiguous.anchor.alternativeCount = 2;
    ambiguous.anchor.alternatives.push({
      symbol: 'ambiguous-control-2',
      label: 'ambiguous-control-2',
      file: 'src/other-target.ts',
      line: 0,
      endLine: 0,
    });
    const candidates = [
      candidate('ordinary-1', 'anchor-a', 300),
      candidate('ordinary-2', 'anchor-a', 290),
      ambiguous,
      candidate('result', 'anchor-a', 100, {}, ['call', 'return']),
    ];

    expect(coverageDiverseNextAnchors(candidates, steps, 3).map((item) => item.anchor.id)).toEqual([
      'ordinary-1',
      'result',
      'ordinary-2',
    ]);
  });

  it('reserves a callee proven to own state effects even when the caller only binds its result', () => {
    const steps = [step('anchor-a', 'anchor')];
    const effectOwner = candidate('effect-owner', 'anchor-a', 50);
    effectOwner.coverageDimensions = ['callee-state-effect'];
    const candidates = [
      candidate('ordinary-1', 'anchor-a', 300),
      candidate('ordinary-2', 'anchor-a', 290),
      candidate('returned-result', 'anchor-a', 100, {}, ['call', 'return']),
      effectOwner,
    ];

    expect(coverageDiverseNextAnchors(candidates, steps, 3).map((item) => item.anchor.id)).toEqual([
      'ordinary-1',
      'returned-result',
      'effect-owner',
    ]);
  });

  it('keeps an exact outgoing call target when behavior compression omitted its callsite line', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-next-anchor-omitted-call-'));
    writeFixtureFiles(root, {
      'src/registry.ts': [
        "import { handleEvent } from './handler.js';",
        'export function exposeHandler() {',
        '  handleEvent();',
        '  return true;',
        '}',
      ],
      'src/handler.ts': ['export function handleEvent() { return true; }'],
    });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/registry.ts')
      .document(2, 'typescript', 'src/handler.ts')
      .symbol(1, SOURCE_SYMBOL, 'exposeHandler')
      .symbol(2, HANDLER_SYMBOL, 'handleEvent')
      .definition(1, 1, 1, 1, 0, 4, 1)
      .definition(2, 2, 2, 0, 0, 0, 54)
      .write();
    const db = new ScipDatabase({ dbPath, indexPath: join(root, 'index.scip'), projectRoot: root });
    const sourceNodeId = `symbol:${encodeURIComponent(SOURCE_SYMBOL)}`;
    const handlerNodeId = `symbol:${encodeURIComponent(HANDLER_SYMBOL)}`;
    try {
      const topology = createExplorationTopology({
        anchors: [
          {
            id: 'anchor:source',
            kind: 'symbol',
            query: 'exposeHandler',
            status: 'matched',
            nodeIds: [sourceNodeId],
            candidateNodeIds: [],
            omittedCandidates: 0,
          },
        ],
        nodes: [
          {
            id: sourceNodeId,
            kind: 'symbol',
            label: 'src:registry:exposeHandler()',
            disposition: 'emitted',
            location: { file: 'src/registry.ts', line: 1, endLine: 4 },
            anchorIds: ['anchor:source'],
            attributes: { leaf: 'exposeHandler' },
          },
          {
            id: handlerNodeId,
            kind: 'symbol',
            label: 'src:handler:handleEvent()',
            disposition: 'folded',
            location: { file: 'src/handler.ts', line: 0, endLine: 0 },
            anchorIds: [],
            attributes: { leaf: 'handleEvent' },
          },
        ],
        edges: [
          {
            id: 'edge:call',
            kind: 'call',
            fromNodeId: sourceNodeId,
            toNodeId: handlerNodeId,
            directed: true,
            disposition: 'folded',
            evidence: [
              {
                method: 'scip-occurrence-callsite',
                strength: 'exact',
                identity: HANDLER_SYMBOL,
                location: { file: 'src/registry.ts', line: 2 },
              },
            ],
          },
        ],
        scope: 'fixture omitted callsite',
      });
      const packet = systemMapNextAnchorPacket(db, topology, {
        status: 'connected',
        steps: [
          {
            id: 'step:source',
            nodeId: sourceNodeId,
            order: 0,
            role: 'anchor',
            kind: 'symbol',
            label: 'src:registry:exposeHandler()',
            location: { file: 'src/registry.ts', line: 1, endLine: 4 },
            behavior: {
              kind: 'outline',
              constructKind: 'module function',
              signature: 'export function exposeHandler()',
              lines: [
                {
                  line: 3,
                  endLine: 3,
                  depth: 0,
                  signals: ['return'],
                  text: 'return true;',
                  copied: true,
                },
              ],
              coverage: { sourceStatements: 2, representedStatements: 1, copiedStatements: 1, omittedStatements: 1 },
              rawCharacters: 32,
              renderedCharacters: 12,
            },
          },
        ],
        transitions: [],
        paths: [],
        coverage: {
          candidateNodes: 2,
          returnedNodes: 1,
          omittedNodeIds: [handlerNodeId],
          returnedTransitions: 0,
          withheldStatements: 1,
          requestedFocusLocations: [],
          matchedFocusLocations: [],
          unmatchedFocusLocations: [],
        },
        behaviorCommand: null,
        exactSourceCommand: null,
      });

      expect(packet.anchors).toEqual([
        expect.objectContaining({
          status: 'exact',
          direction: 'downstream',
          causalRole: 'callee',
          relationKind: 'call',
          alternatives: [expect.objectContaining({ symbol: HANDLER_SYMBOL })],
        }),
      ]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps a non-call registry function value as a callable reference instead of dropping the edge', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-next-anchor-reference-'));
    writeFixtureFiles(root, {
      'src/registry.ts': [
        "import { handleEvent } from './handler.js';",
        'export function exposeHandler() {',
        '  return { handler: handleEvent };',
        '}',
      ],
      'src/handler.ts': ['export function handleEvent() { return true; }'],
    });
    const dbPath = join(root, 'index.db');
    evidenceFixtureDb(dbPath)
      .document(1, 'typescript', 'src/registry.ts')
      .document(2, 'typescript', 'src/handler.ts')
      .symbol(1, SOURCE_SYMBOL, 'exposeHandler')
      .symbol(2, HANDLER_SYMBOL, 'handleEvent')
      .definition(1, 1, 1, 1, 0, 3, 1)
      .definition(2, 2, 2, 0, 0, 0, 54)
      .write();
    const db = new ScipDatabase({ dbPath, indexPath: join(root, 'index.scip'), projectRoot: root });
    const sourceNodeId = `symbol:${encodeURIComponent(SOURCE_SYMBOL)}`;
    const handlerNodeId = `symbol:${encodeURIComponent(HANDLER_SYMBOL)}`;
    try {
      const topology = createExplorationTopology({
        anchors: [
          {
            id: 'anchor:source',
            kind: 'symbol',
            query: 'exposeHandler',
            status: 'matched',
            nodeIds: [sourceNodeId],
            candidateNodeIds: [],
            omittedCandidates: 0,
          },
        ],
        nodes: [
          {
            id: sourceNodeId,
            kind: 'symbol',
            label: 'src:registry:exposeHandler()',
            disposition: 'emitted',
            location: { file: 'src/registry.ts', line: 1, endLine: 3 },
            anchorIds: ['anchor:source'],
            attributes: { leaf: 'exposeHandler' },
          },
          {
            id: handlerNodeId,
            kind: 'symbol',
            label: 'src:handler:handleEvent()',
            disposition: 'folded',
            location: { file: 'src/handler.ts', line: 0, endLine: 0 },
            anchorIds: [],
            attributes: { leaf: 'handleEvent' },
          },
        ],
        edges: [
          {
            id: 'edge:reference',
            kind: 'reference',
            fromNodeId: sourceNodeId,
            toNodeId: handlerNodeId,
            directed: true,
            disposition: 'folded',
            evidence: [
              {
                method: 'scip-occurrence-reference',
                strength: 'exact',
                identity: HANDLER_SYMBOL,
                location: { file: 'src/registry.ts', line: 2 },
              },
            ],
          },
        ],
        scope: 'fixture callable reference',
      });
      const packet = systemMapNextAnchorPacket(db, topology, {
        status: 'connected',
        steps: [
          {
            id: 'step:source',
            nodeId: sourceNodeId,
            order: 0,
            role: 'anchor',
            kind: 'symbol',
            label: 'src:registry:exposeHandler()',
            location: { file: 'src/registry.ts', line: 1, endLine: 3 },
            behavior: {
              kind: 'outline',
              constructKind: 'module function',
              signature: 'export function exposeHandler()',
              lines: [
                {
                  line: 2,
                  endLine: 2,
                  depth: 0,
                  signals: ['return', 'shape'],
                  text: 'return { handler: handleEvent };',
                  copied: true,
                },
              ],
              coverage: { sourceStatements: 1, representedStatements: 1, copiedStatements: 1, omittedStatements: 0 },
              rawCharacters: 40,
              renderedCharacters: 40,
            },
          },
        ],
        transitions: [],
        paths: [],
        coverage: {
          candidateNodes: 2,
          returnedNodes: 1,
          omittedNodeIds: [handlerNodeId],
          returnedTransitions: 0,
          withheldStatements: 0,
          requestedFocusLocations: [],
          matchedFocusLocations: [],
          unmatchedFocusLocations: [],
        },
        behaviorCommand: null,
        exactSourceCommand: null,
      });

      expect(packet.resultCandidates).toBe(0);
      expect(packet.anchors).toEqual([
        expect.objectContaining({
          direction: 'downstream',
          causalRole: 'callable-reference',
          relationKind: 'reference',
          alternatives: [expect.objectContaining({ symbol: HANDLER_SYMBOL })],
        }),
      ]);
      expect(packet.inspectCommand).toContain("--at 'src/handler.ts:1'");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function step(id: string, role: ConnectedBehaviorStep['role']): ConnectedBehaviorStep {
  return { id, nodeId: id, order: 0, role, kind: 'symbol', label: id, location: null, behavior: null };
}

function candidate(
  id: string,
  fromStepId: string,
  priority: number,
  causal: Pick<RankedNextAnchor['anchor'], 'direction' | 'causalRole'> = {},
  signals: RankedNextAnchor['anchor']['callsite']['signals'] = ['call'],
): RankedNextAnchor {
  return {
    priority,
    anchor: {
      id,
      status: 'exact',
      source: 'graph-call',
      ...causal,
      fromStepId,
      fromLabel: fromStepId,
      callsite: {
        file: 'src/example.ts',
        line: 0,
        endLine: 0,
        text: `${id}()`,
        signals,
        calleeLeaf: id,
      },
      alternatives: [{ symbol: id, label: id, file: 'src/target.ts', line: 0, endLine: 0 }],
      alternativeCount: 1,
      evidence: [],
    },
  };
}
