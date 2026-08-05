import { dirname, join } from 'node:path';
import {
  collectRuntimeBoundaryGraph,
  readRuntimeBoundaryGraph,
  RUNTIME_BOUNDARY_EXTRACTOR_VERSION,
  writeRuntimeBoundaryGraph,
} from '../analysis/runtime-boundaries/index.js';
import { ScipDatabase } from '../storage/db.js';
import type { PostIndexAugmentationStage } from './augmentation/post-index-augmentation.js';

export interface RuntimeBoundaryAugmentationResult {
  reused: boolean;
  incrementallyUpdated: boolean;
  observations: number;
  links: number;
  frontiers: number;
  filesScanned: number;
  errors: number;
  phases: NonNullable<ReturnType<typeof readRuntimeBoundaryGraph>>['coverage']['phases'];
}

export function runtimeBoundaryAugmentationStage(
  opts: { indexPath?: string; reuseExisting?: boolean; affectedFiles?: readonly string[] } = {},
): PostIndexAugmentationStage<RuntimeBoundaryAugmentationResult> {
  return {
    id: 'runtime-boundaries',
    facts: ['runtime-boundary-observation', 'runtime-boundary-link'],
    run: ({ projectRoot, dbPath, onStatus }) => {
      const index = new ScipDatabase({
        projectRoot,
        dbPath,
        indexPath: opts.indexPath ?? join(dirname(dbPath), 'index.scip'),
      });
      let graph;
      let reused = false;
      let incrementallyUpdated = false;
      try {
        const stored = opts.reuseExisting || opts.affectedFiles ? readRuntimeBoundaryGraph(index) : null;
        if (opts.reuseExisting && stored?.extractorVersion === RUNTIME_BOUNDARY_EXTRACTOR_VERSION) {
          graph = stored;
          reused = true;
        } else {
          graph = collectRuntimeBoundaryGraph(index, {
            ...(stored ? { previousGraph: stored } : {}),
            ...(opts.affectedFiles ? { affectedFiles: opts.affectedFiles } : {}),
          });
          incrementallyUpdated = (graph.coverage.filesReused ?? 0) > 0;
        }
      } finally {
        index.close();
      }
      if (!reused) writeRuntimeBoundaryGraph(dbPath, graph);
      const result = {
        reused,
        incrementallyUpdated,
        observations: graph.observations.length,
        links: graph.links.length,
        frontiers: graph.frontiers.length,
        filesScanned: graph.coverage.filesScanned,
        errors: graph.coverage.extractionErrors.length,
        phases: graph.coverage.phases,
      };
      onStatus?.(
        result.reused
          ? `Reused ${result.observations} cached runtime-boundary observation(s) and ${result.links} link(s).`
          : result.incrementallyUpdated
            ? `Incrementally refreshed runtime-boundary observations (${result.filesScanned - (graph.coverage.filesReused ?? 0)} file(s) extracted, ${graph.coverage.filesReused ?? 0} reused) and rebuilt ${result.links} link(s).`
            : `Extracted ${result.observations} runtime-boundary observation(s), ${result.links} link(s), and ${result.frontiers} unresolved frontier(s).`,
      );
      if (!reused && graph.coverage.phases) {
        onStatus?.(
          `Runtime-boundary phases: ${graph.coverage.phases
            .map((phase) => `${phase.id} ${phase.durationMs.toFixed(0)}ms`)
            .join(', ')}.`,
        );
      }
      return result;
    },
  };
}
