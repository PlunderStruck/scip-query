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
  observations: number;
  links: number;
  frontiers: number;
  filesScanned: number;
  errors: number;
}

export function runtimeBoundaryAugmentationStage(
  opts: { indexPath?: string; reuseExisting?: boolean } = {},
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
      try {
        const stored = opts.reuseExisting ? readRuntimeBoundaryGraph(index) : null;
        if (stored?.extractorVersion === RUNTIME_BOUNDARY_EXTRACTOR_VERSION) {
          graph = stored;
          reused = true;
        } else {
          graph = collectRuntimeBoundaryGraph(index);
        }
      } finally {
        index.close();
      }
      if (!reused) writeRuntimeBoundaryGraph(dbPath, graph);
      const result = {
        reused,
        observations: graph.observations.length,
        links: graph.links.length,
        frontiers: graph.frontiers.length,
        filesScanned: graph.coverage.filesScanned,
        errors: graph.coverage.extractionErrors.length,
      };
      onStatus?.(
        result.reused
          ? `Reused ${result.observations} cached runtime-boundary observation(s) and ${result.links} link(s).`
          : `Extracted ${result.observations} runtime-boundary observation(s), ${result.links} link(s), and ${result.frontiers} unresolved frontier(s).`,
      );
      return result;
    },
  };
}
