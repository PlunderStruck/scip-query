import { describe, expect, it, vi } from 'vitest';
import type { ScipDatabase } from '../../../src/storage/db.js';
vi.mock('../../../src/queries/graph/system-map.js', () => ({
  systemMapTopology: () => ({
    nodes: [
      { id: 'a', kind: 'source', label: 'a', location: { file: 'src/a.ts', startLine: 0, endLine: 0 } },
      { id: 'b', kind: 'source', label: 'b', location: { file: 'src/b.ts', startLine: 0, endLine: 0 } },
    ],
    anchors: [{ kind: 'symbol', query: 'a', status: 'matched', nodeIds: ['a'], omittedCandidates: 0 }],
    edges: [
      {
        id: 'a-b',
        fromNodeId: 'a',
        toNodeId: 'b',
        kind: 'call',
        disposition: 'emitted',
        semantics: [{ family: 'control', subtype: 'result-callback' }],
        evidence: [{ method: 'source-name-match', strength: 'candidate' }],
      },
    ],
    frontiers: [],
    coverage: { status: 'accounted', scope: 'fixture', blindSpots: [], explanation: 'All fixture edges present.' },
  }),
}));
import { graphEvidence } from '../../../src/queries/graph/graph-evidence.js';

describe('graph provider coverage', () => {
  it('discloses selected edges rejected by the provider instead of reporting an accounted empty graph', () => {
    const result = graphEvidence({} as ScipDatabase, { symbols: ['a'] }, { families: ['execution'], maxDepth: 1 });
    expect(result.edges).toEqual([]);
    expect(result.coverage.status).toBe('incomplete');
    expect(result.coverage.blindSpots.join(' ')).toContain('result-callback');
  });
});
