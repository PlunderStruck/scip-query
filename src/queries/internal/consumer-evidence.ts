import type { ProjectIndex } from '../../core/project-index.js';
import type { IndexedDefinition } from '../../domain/types.js';

export interface DefinitionConsumerEvidenceOptions {
  semantic: boolean;
  sourceFallback?: boolean;
}

/**
 * Consumer evidence for detector queries: cross-file callers plus optional
 * source fallback, keyed by definition symbol id. This names the policy that
 * "consumer" means more than raw SCIP caller rows.
 */
export function definitionConsumerFileMap(
  index: ProjectIndex,
  definitions: readonly IndexedDefinition[],
  opts: DefinitionConsumerEvidenceOptions,
): Map<number, Set<string>> {
  return index.callerFileMap(definitions, {
    semantic: opts.semantic,
    sourceFallback: opts.sourceFallback,
  });
}
