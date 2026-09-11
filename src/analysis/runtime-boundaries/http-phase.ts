import type { ScipDatabase } from '../../storage/db.js';
import type { RuntimeBoundaryProfileSpan } from './extractors.js';
import { deduplicateFrontiers } from './frontiers.js';
import { httpSummarySeeds, propagateCompilerResolvedHttpSummaries } from './http-summaries.js';
import { materializeRuntimePhase, runtimePhaseSeeds } from './phase-inputs.js';
import type { BoundaryObservation, HttpPhasePartition, HttpSummaryPropagationResult } from './types.js';

const MAX_PARTITIONS = 32;

/**
 * Retain independently verified propagation work when new terminal operations
 * are added. Any shared callable owner reconnects the partitions and requires
 * the original single ordered worklist, including its merged provenance.
 */
export function materializeHttpPropagation(opts: {
  db: ScipDatabase;
  scope: string;
  observations: readonly BoundaryObservation[];
  compilerFactsUnchanged: boolean;
  previous?: readonly HttpPhasePartition[];
  profileSpan?: RuntimeBoundaryProfileSpan;
}): {
  result: HttpSummaryPropagationResult;
  partitions?: HttpPhasePartition[];
  reused: boolean;
  filesVisited: number;
} {
  const seeds = httpSummarySeeds(opts.observations);
  const inputs = partitionInputs(seeds, opts.previous);
  const compute = (observations: readonly BoundaryObservation[], previous?: HttpPhasePartition) =>
    materializeRuntimePhase({
      db: opts.db,
      scope: opts.scope,
      seeds: runtimePhaseSeeds(observations),
      compilerFactsUnchanged: opts.compilerFactsUnchanged,
      previous: previous?.record,
      compute: (reader) => propagateCompilerResolvedHttpSummaries(reader, observations, opts.profileSpan),
    });
  const completed = inputs.map((input) => ({ ...input, phase: compute(input.seeds, input.previous) }));
  if (!independentResults(completed.map((entry) => entry.phase.result))) {
    const phase = compute(seeds);
    return {
      result: phase.result,
      partitions: phase.record ? [{ observationIds: seeds.map((seed) => seed.id), record: phase.record }] : undefined,
      reused: false,
      filesVisited: phase.result.filesInspected,
    };
  }
  const results = completed.map((entry) => entry.phase.result);
  const files = new Set(results.flatMap((result) => result.inspectedFiles));
  const result: HttpSummaryPropagationResult = {
    observations: results.flatMap((entry) => entry.observations),
    frontiers: deduplicateFrontiers(results.flatMap((entry) => entry.frontiers)),
    summaries: results.reduce((sum, entry) => sum + entry.summaries, 0),
    filesInspected: files.size,
    errors: results.flatMap((entry) => entry.errors),
    summarySymbols: results.flatMap((entry) => entry.summarySymbols).sort(),
    inspectedFiles: [...files].sort(),
  };
  return {
    result,
    partitions: completed.every((entry) => entry.phase.record)
      ? completed.map((entry) => ({
          observationIds: entry.seeds.map((seed) => seed.id),
          record: entry.phase.record!,
        }))
      : undefined,
    reused: completed.every((entry) => entry.phase.reused),
    filesVisited: new Set(
      completed.filter((entry) => !entry.phase.reused).flatMap((entry) => entry.phase.result.inspectedFiles),
    ).size,
  };
}

function partitionInputs(seeds: BoundaryObservation[], previous: readonly HttpPhasePartition[] | undefined) {
  if (!seeds.length)
    return [{ seeds, previous: previous?.find((partition) => partition.observationIds?.length === 0) }];
  if (!previous?.length || previous.length >= MAX_PARTITIONS) return [{ seeds, previous: undefined }];
  const remaining = new Map(seeds.map((seed) => [seed.id, seed]));
  const result: Array<{ seeds: BoundaryObservation[]; previous?: HttpPhasePartition }> = [];
  for (const partition of previous) {
    if (!Array.isArray(partition?.observationIds)) return [{ seeds, previous: undefined }];
    const ids = new Set(partition.observationIds);
    const retained = seeds.filter((seed) => remaining.has(seed.id) && ids.has(seed.id));
    for (const seed of retained) remaining.delete(seed.id);
    if (retained.length) result.push({ seeds: retained, previous: partition });
  }
  if (remaining.size || !result.length) result.push({ seeds: [...remaining.values()] });
  return result;
}

function independentResults(results: readonly HttpSummaryPropagationResult[]): boolean {
  if (results.length === 1) return true;
  const seen = new Set<string>();
  for (const result of results) {
    if (result.errors.length || !Array.isArray(result.summarySymbols) || !Array.isArray(result.inspectedFiles))
      return false;
    for (const symbol of result.summarySymbols) {
      if (seen.has(symbol)) return false;
      seen.add(symbol);
    }
  }
  return true;
}
