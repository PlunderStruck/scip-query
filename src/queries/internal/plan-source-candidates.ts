import type { IndexedDefinition } from '../../domain/types.js';

export interface PlanSourceCandidate<TRole extends string> {
  definition: IndexedDefinition | null;
  role: TRole;
}

/** Keep module evidence only when the same role and file has no callable evidence. */
export function preferCallablePlanSourceCandidates<TRole extends string>(
  candidates: readonly PlanSourceCandidate<TRole>[],
): Array<{ definition: IndexedDefinition; role: TRole }> {
  const callableFiles = new Set(
    candidates
      .filter((candidate) => candidate.definition?.isFunctionLike)
      .map((candidate) => `${candidate.role}:${candidate.definition!.relativePath}`),
  );
  return candidates.flatMap((candidate) => {
    if (!candidate.definition) return [];
    if (
      !candidate.definition.isFunctionLike &&
      callableFiles.has(`${candidate.role}:${candidate.definition.relativePath}`)
    ) {
      return [];
    }
    return [{ definition: candidate.definition, role: candidate.role }];
  });
}
