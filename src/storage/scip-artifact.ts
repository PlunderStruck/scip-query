import { deserializeSCIP } from '@c4312/scip';
import { readFileWithinLimit, SCIP_ARTIFACT_MAX_BYTES } from '../platform/bounded-file.js';

/** Read and decode one SCIP artifact through the repository's bounded-file contract. */
export function readScipArtifact(path: string, inputKind: string): ReturnType<typeof deserializeSCIP> {
  return deserializeSCIP(readFileWithinLimit(path, { inputKind, maxBytes: SCIP_ARTIFACT_MAX_BYTES }));
}
