import { describe, expect, it } from 'vitest';

import {
  SYSTEM_MAP_RELATION_KINDS,
  systemMapRelationProgramSemantics,
  systemMapSyntheticEdgeProgramSemantics,
} from '../../../src/queries/graph/system-map-edge-semantics.js';

describe('system-map program edge semantics', () => {
  it('maps every declared relation kind into the closed semantic families', () => {
    expect(
      SYSTEM_MAP_RELATION_KINDS.map((kind) => [
        kind,
        systemMapRelationProgramSemantics({ kind }).map(({ family, subtype }) => `${family}:${subtype}`),
      ]),
    ).toEqual([
      ['call', ['control:call']],
      ['contract-symbol', ['contract:uses-contract-symbol']],
      ['import', ['identity:imports']],
      ['reference', ['identity:references']],
      ['runtime-boundary', ['control:runtime-handoff']],
    ]);
  });

  it('retains the exact runtime context without claiming unproved data or temporal edges', () => {
    expect(
      systemMapRelationProgramSemantics({
        kind: 'runtime-boundary',
        runtimeBoundaryKey: 'http\u0000POST\u0000/api/work-sessions',
        fromBoundaryParticipant: { protocol: 'http' },
        toBoundaryParticipant: { protocol: 'http' },
      }),
    ).toEqual([
      {
        family: 'control',
        subtype: 'runtime-handoff',
        context: {
          crossesRuntimeBoundary: true,
          protocol: 'http',
          runtimeKey: 'http\u0000POST\u0000/api/work-sessions',
        },
      },
    ]);
  });

  it('projects a carrier discriminator only when the runtime join proved data-mediated dispatch', () => {
    expect(
      systemMapRelationProgramSemantics({
        kind: 'runtime-boundary',
        evidence: 'runtime-boundary:carrier.discriminator',
        runtimeBoundaryKey: 'carrier\u0000work_session_stream_events',
        fromBoundaryParticipant: { protocol: 'http' },
        toBoundaryParticipant: { protocol: 'http' },
      }),
    ).toEqual([
      expect.objectContaining({ family: 'control', subtype: 'runtime-handoff' }),
      {
        family: 'data',
        subtype: 'serialized-discriminator-transfer',
        context: {
          crossesRuntimeBoundary: true,
          protocol: 'http',
          runtimeKey: 'carrier\u0000work_session_stream_events',
        },
        attributes: { joinRule: 'carrier.discriminator' },
      },
    ]);
  });

  it('maps system-map topology scaffolding while leaving unresolved frontiers outside the proved graph', () => {
    expect(systemMapSyntheticEdgeProgramSemantics('structural-membership')).toEqual([
      { family: 'identity', subtype: 'contains' },
    ]);
    expect(systemMapSyntheticEdgeProgramSemantics('boundary-observation')).toEqual([
      { family: 'identity', subtype: 'owns-runtime-observation' },
    ]);
    expect(systemMapSyntheticEdgeProgramSemantics('external-import')).toEqual([
      { family: 'identity', subtype: 'imports-external' },
    ]);
  });
});
