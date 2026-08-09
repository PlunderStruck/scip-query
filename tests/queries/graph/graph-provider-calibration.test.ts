import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { graphRelationProviderFor } from '../../../src/domain/graph-relation-providers.js';
import { programControlElementsForTopologyNodes } from '../../../src/queries/graph/program-control-edges.js';
import { programStateTemporalElementsForTopologyNodes } from '../../../src/queries/graph/program-state-temporal-edges.js';
import {
  systemMapRelationProgramSemantics,
  systemMapSyntheticEdgeProgramSemantics,
} from '../../../src/queries/graph/system-map-edge-semantics.js';
import type {
  ExplorationEvidenceStrength,
  ExplorationTopologyEdge,
  ExplorationTopologyNode,
  ProgramEdgeSemantic,
} from '../../../src/queries/internal/exploration-topology.js';
import { behaviorSkeleton } from '../../../src/source/facts/behavior-skeleton.js';
import { ScipDatabase } from '../../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../../fixtures/evidence-fixture.js';

const LANGUAGE_FIXTURES = [
  {
    language: 'typescript',
    file: 'src/flow.ts',
    source: [
      'export async function update(state: State, ready: boolean, value: string) {',
      '  if (!ready) return;',
      '  state.value = value;',
      '  await persist(state.value);',
      '  state.version += 1;',
      '  return state.value;',
      '}',
    ],
  },
  {
    language: 'rust',
    file: 'src/flow.rs',
    source: [
      'async fn update(state: &mut State, ready: bool, value: String) {',
      '    if !ready { return; }',
      '    state.value = value;',
      '    persist(&state.value).await;',
      '    state.version += 1;',
      '}',
    ],
  },
] as const;

describe('cross-language graph provider calibration', () => {
  for (const fixture of LANGUAGE_FIXTURES) {
    it(`keeps exact indexed relationships exact for ${fixture.language}`, () => {
      withLanguageFixture(fixture, () => {
        expectCalibrated(
          'contract',
          systemMapRelationProgramSemantics({ kind: 'contract-symbol' })[0]!,
          'exact',
          'exact',
        );
        expectCalibrated('identity', systemMapRelationProgramSemantics({ kind: 'reference' })[0]!, 'exact', 'exact');
        expectCalibrated(
          'ownership',
          systemMapSyntheticEdgeProgramSemantics('structural-membership')[0]!,
          'exact',
          'exact',
        );
      });
    });

    it(`emits only partial-ceiling execution, data, state, and temporal facts for ${fixture.language}`, () => {
      withLanguageFixture(fixture, (db, owner) => {
        const control = programControlElementsForTopologyNodes(db, [owner]);
        const stateTemporal = programStateTemporalElementsForTopologyNodes(db, [owner]);
        const behavior = behaviorSkeleton(db, fixture.file, 0, fixture.source.length - 1, [], {
          requireSavings: false,
        });
        const edges = [...control.edges, ...stateTemporal.edges].filter((edge) => edge.disposition !== 'unsupported');

        expect(behavior).toMatchObject({ representation: 'outline', coverage: { omittedStatements: 0 } });
        expect(behavior?.coverage.representedStatements).toBe(behavior?.coverage.sourceStatements);
        expectFamily(edges, 'execution', 'partial');
        expectFamily(edges, 'dataflow', 'partial');
        expectFamily(edges, 'state', 'partial');
        expectFamily(edges, 'temporal', 'partial');
        expectFamily(edges, 'ownership', 'exact');
      });
    });
  }
});

function expectFamily(
  edges: readonly ExplorationTopologyEdge[],
  family: 'execution' | 'dataflow' | 'state' | 'temporal' | 'ownership',
  ceiling: 'exact' | 'partial',
): void {
  const observations = edges.flatMap((edge) =>
    (edge.semantics ?? []).flatMap((semantic) =>
      calibratedFamily(semantic) === family ? [{ semantic, strength: combinedStrength(edge) }] : [],
    ),
  );
  expect(observations.length, family).toBeGreaterThan(0);
  for (const observation of observations) {
    expectCalibrated(family, observation.semantic, observation.strength, ceiling);
  }
}

function expectCalibrated(
  family: 'execution' | 'dataflow' | 'state' | 'temporal' | 'contract' | 'identity' | 'ownership',
  semantic: ProgramEdgeSemantic,
  strength: ExplorationEvidenceStrength,
  ceiling: 'exact' | 'partial',
): void {
  const resolved = graphRelationProviderFor(family, semantic.subtype);
  expect(resolved, `${family}/${semantic.subtype}`).not.toBeNull();
  expect(resolved?.relation.supportCeiling, `${family}/${semantic.subtype}`).toBe(ceiling);
  expect(resolved?.relation.evidenceStrengths, `${family}/${semantic.subtype}`).toContain(strength);
}

function calibratedFamily(
  semantic: ProgramEdgeSemantic,
): 'execution' | 'dataflow' | 'state' | 'temporal' | 'contract' | 'identity' | 'ownership' {
  switch (semantic.family) {
    case 'control':
      return 'execution';
    case 'data':
      return 'dataflow';
    case 'state':
    case 'temporal':
    case 'contract':
      return semantic.family;
    case 'identity':
      return semantic.subtype.startsWith('contains') || semantic.subtype.startsWith('owns-') ? 'ownership' : 'identity';
  }
}

function combinedStrength(edge: ExplorationTopologyEdge): ExplorationEvidenceStrength {
  const strengths = [...new Set(edge.evidence.map((evidence) => evidence.strength))];
  return strengths.length === 1 ? strengths[0]! : 'mixed';
}

function withLanguageFixture(
  fixture: (typeof LANGUAGE_FIXTURES)[number],
  run: (db: ScipDatabase, owner: ExplorationTopologyNode) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), `scip-provider-${fixture.language}-`));
  const projectRoot = join(root, 'project');
  const dbPath = join(root, 'index.db');
  try {
    writeFixtureFiles(projectRoot, { [fixture.file]: fixture.source });
    evidenceFixtureDb(dbPath).document(1, fixture.language, fixture.file).write();
    const db = new ScipDatabase({ projectRoot, dbPath, indexPath: join(root, 'index.scip') });
    const owner: ExplorationTopologyNode = {
      id: `${fixture.language}:update`,
      kind: 'source-construct',
      label: 'update',
      disposition: 'emitted',
      location: { file: fixture.file, line: 0, endLine: fixture.source.length - 1 },
      anchorIds: [],
      attributes: {},
    };
    try {
      run(db, owner);
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
