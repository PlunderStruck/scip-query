import { createHash } from 'node:crypto';
import type { BoundaryObservation } from './types.js';

/**
 * Promote only a proved insert/skip-locked-claim pair on the same resource to
 * a traversable queue. Ordinary database reads and writes remain structural
 * persistence facts and never imply runtime control flow.
 */
export function deriveDatabaseWorkQueueObservations(
  observations: readonly BoundaryObservation[],
): BoundaryObservation[] {
  const claimsByResource = observationsByResource(
    observations.filter(
      (observation) =>
        observation.action === 'database.read' && observation.evidence === 'persistence-skip-locked-claim',
    ),
  );
  const insertsByResource = observationsByResource(
    observations.filter(
      (observation) => observation.action === 'database.write' && observation.evidence === 'persistence-insert',
    ),
  );

  return observations.flatMap((observation) => {
    if (observation.action === 'database.write' && observation.evidence === 'persistence-insert') {
      return resourceValues(observation).flatMap((resource) => {
        const counterpart = claimsByResource.get(resource)?.[0];
        return counterpart ? [databaseQueueObservation(observation, counterpart, resource, 'queue.send')] : [];
      });
    }
    if (observation.action === 'database.read' && observation.evidence === 'persistence-skip-locked-claim') {
      return resourceValues(observation).flatMap((resource) => {
        const counterpart = insertsByResource.get(resource)?.[0];
        return counterpart ? [databaseQueueObservation(observation, counterpart, resource, 'queue.consume')] : [];
      });
    }
    return [];
  });
}

function observationsByResource(
  observations: readonly BoundaryObservation[],
): ReadonlyMap<string, BoundaryObservation[]> {
  const byResource = new Map<string, BoundaryObservation[]>();
  for (const observation of observations) {
    for (const resource of resourceValues(observation)) {
      const existing = byResource.get(resource);
      if (existing) existing.push(observation);
      else byResource.set(resource, [observation]);
    }
  }
  for (const entries of byResource.values()) entries.sort((left, right) => left.id.localeCompare(right.id));
  return byResource;
}

function resourceValues(observation: BoundaryObservation): string[] {
  return observation.keyParts.filter((part) => part.name === 'resource').map((part) => part.value);
}

function databaseQueueObservation(
  source: BoundaryObservation,
  counterpart: BoundaryObservation,
  resource: string,
  action: 'queue.send' | 'queue.consume',
): BoundaryObservation {
  const address = `database:${resource}`;
  const evidence = action === 'queue.send' ? 'database-queue-insert' : 'database-queue-skip-locked-claim';
  const identity = [source.id, action, address, evidence].join('\0');
  return {
    ...source,
    id: `boundary:${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`,
    extractor: 'builtin.database-queue',
    action,
    keyParts: [
      {
        name: 'address',
        value: address,
        evidence: 'identifier',
        term: { kind: 'symbol', symbol: resource },
        derivation: {
          kind: 'mechanically-derived',
          rule: 'database-work-queue.resource',
          ruleVersion: '1',
          inputFactIds: [source.id, counterpart.id],
          sourceSpans: [source.source, counterpart.source],
        },
      },
    ],
    evidence,
    strength: 'derived',
    protocol: 'queue',
    role: action === 'queue.send' ? 'producer' : 'consumer',
    derivation: {
      kind: 'mechanically-derived',
      rule: 'database-work-queue.insert-skip-locked',
      ruleVersion: '1',
      inputFactIds: [source.id, counterpart.id],
      sourceSpans: [source.source, counterpart.source],
    },
    valuePrecision: 'symbolic',
    resolution: 'unresolved',
  };
}
