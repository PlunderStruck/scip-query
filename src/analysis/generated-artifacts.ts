/**
 * Generated artifacts — files a tool rewrites from another file in the same
 * repository: ORM migration journals and snapshots, emitted migration SQL,
 * `drizzle-kit pull` schema and relation dumps, and codegen output.
 *
 * Their exports are consumed by the generator's runtime, not by hand-written
 * imports, and their edits track their source by construction. A dead-code
 * verdict or a hidden-coupling verdict on such a file describes the
 * generator, not the project, so detectors disclose these paths instead of
 * counting them.
 */
import { normalizePathSeparators as normalizePath } from '../domain/path-normalization.js';

const GENERATED_ARTIFACT_PATTERN =
  /(?:^|\/)(?:migrations?\/meta\/|drizzle\/meta\/|prisma\/migrations\/|__generated__\/|generated\/)|(?:^|\/)(?:_journal\.json|migration_lock\.toml)$|(?:^|\/)[^/]*(?:snapshot|\.generated|\.gen)\.[a-z0-9]+$|(?:^|\/)(?:migrations?|drizzle)\/[^/]+\.sql$|(?:^|\/)(?:migrations?|drizzle)\/(?:schema|relations)\.[cm]?[jt]s$/i;

export function isGeneratedArtifactPath(file: string): boolean {
  return GENERATED_ARTIFACT_PATTERN.test(normalizePath(file));
}
