import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  callableReferenceCausalRole,
  deduplicateNextAnchorCandidates,
  nextAnchorInspectSafe,
  systemMapNextAnchorPacket,
  type NextAnchorCandidate,
} from '../../../src/queries/internal/next-anchor-candidates.js';
import { createExplorationTopology } from '../../../src/queries/internal/exploration-topology.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const SOURCE_SYMBOL = 'scip-typescript npm fixture 1.0.0 src/`registry.ts`/exposeHandler().';
const HANDLER_SYMBOL = 'scip-typescript npm fixture 1.0.0 src/`handler.ts`/handleEvent().';

describe('next-anchor target selection', () => {
  it('distinguishes result-producing callbacks from ordinary callable references', () => {
    expect(callableReferenceCausalRole(['call', 'return'])).toBe('result-callback');
    expect(callableReferenceCausalRole(['call', 'mutation'])).toBe('result-callback');
    expect(callableReferenceCausalRole(['return', 'shape'])).toBe('callable-reference');
  });

  it('keeps exact target identity when an ambiguous occurrence names the same target', () => {
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

    expect(deduplicateNextAnchorCandidates([ambiguous, exact])).toEqual([exact]);
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

      const inlineBehavior = connectedFixtureBehavior(sourceNodeId);
      const packetWithInlineSupport = systemMapNextAnchorPacket(db, topology, {
        ...inlineBehavior,
        steps: [
          {
            ...inlineBehavior.steps[0]!,
            behavior: {
              ...inlineBehavior.steps[0]!.behavior!,
              supportingDeclarations: [
                {
                  kind: 'focused-causal-target',
                  symbol: 'source-fallback:src/handler.ts:handleEvent',
                  label: 'handleEvent',
                  file: 'src/handler.ts',
                  line: 0,
                  endLine: 0,
                  text: 'export function handleEvent() { return true; }',
                },
              ],
            },
          },
        ],
      });

      expect(packetWithInlineSupport.anchors).toEqual([]);
      expect(packetWithInlineSupport.inspectCommand).toBeNull();
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

function connectedFixtureBehavior(nodeId: string): Parameters<typeof systemMapNextAnchorPacket>[2] {
  return {
    status: 'connected',
    steps: [
      {
        id: 'step:source',
        nodeId,
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
      omittedNodeIds: [],
      returnedTransitions: 0,
      withheldStatements: 1,
      requestedFocusLocations: [],
      matchedFocusLocations: [],
      unmatchedFocusLocations: [],
    },
    behaviorCommand: null,
    exactSourceCommand: null,
  };
}

function candidate(
  id: string,
  fromStepId: string,
  _legacyPriority: number,
  causal: Pick<NextAnchorCandidate['anchor'], 'direction' | 'causalRole'> = {},
  signals: NextAnchorCandidate['anchor']['callsite']['signals'] = ['call'],
): NextAnchorCandidate {
  return {
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
