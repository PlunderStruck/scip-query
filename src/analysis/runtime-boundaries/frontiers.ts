import type { BoundaryFrontier } from './types.js';

export function deduplicateFrontiers(frontiers: readonly BoundaryFrontier[]): BoundaryFrontier[] {
  return [...new Map(frontiers.map((frontier) => [frontier.observationId, frontier])).values()].sort((left, right) =>
    left.observationId.localeCompare(right.observationId),
  );
}
