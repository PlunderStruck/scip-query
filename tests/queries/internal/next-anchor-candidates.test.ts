import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  coverageDiverseNextAnchors,
  systemMapNextAnchorPacket,
  type RankedNextAnchor,
} from '../../../src/queries/internal/next-anchor-candidates.js';
import type { ConnectedBehaviorStep } from '../../../src/queries/internal/connected-behavior.js';
import { createExplorationTopology } from '../../../src/queries/internal/exploration-topology.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const SOURCE_SYMBOL = 'scip-typescript npm fixture 1.0.0 src/`registry.ts`/exposeHandler().';
const HANDLER_SYMBOL = 'scip-typescript npm fixture 1.0.0 src/`handler.ts`/handleEvent().';

describe('next-anchor target selection', () => {
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
        signals: ['call'],
        calleeLeaf: id,
      },
      alternatives: [{ symbol: id, label: id, file: 'src/target.ts', line: 0, endLine: 0 }],
      alternativeCount: 1,
      evidence: [],
    },
  };
}
