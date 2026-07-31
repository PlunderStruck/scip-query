# Reindex Metadata Compatibility

Reindex metadata is the persisted description in `meta.json` that identifies
the source-input fingerprint, indexed languages, completeness, and optional
reuse capabilities of one accepted index generation. It is a compatibility
record rather than an authority by itself: a consumer still verifies the
database, SCIP companion, immutable-generation state, or current source
fingerprint required by its operation.

`src/domain/reindex-metadata.ts` is the domain decoding boundary. It
classifies an input as:

- `legacy`: a structurally valid version 2 record;
- `supported`: a structurally valid current version 3 record;
- `unsupported`: an integer version outside the readable range, with older or
  future direction; or
- `malformed`: invalid JSON, a non-object, a missing/non-integer version, or an
  invalid field in a recognized version.

The decoder shares only dependency-free object-record, timestamp,
scalar-number, non-empty string, bounded one-line string, and
string-or-null-record predicates in `src/domain/record-validation.ts`; moving
those generic primitives out of individual decoders does not change any
version or capability decision.

No consumer may cast an unsupported or malformed record to the current model.
The decoder returns the original accepted v2/v3 object, so an authorized
best-effort update such as `lastRefresh` preserves unknown additive fields.
Future records are never rewritten.

## Version policy

| Wire version | Decoder result | Read policy                                                | Write policy                                                 |
| ------------ | -------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| 2            | `legacy`       | Supported by common capabilities; no v3 shard capabilities | Read-only compatibility; a rebuilt generation writes v3      |
| 3            | `supported`    | Current model                                              | All newly published metadata                                 |
| 4            | `unsupported`  | Reserved migration boundary; reported explicitly           | Never written until its migration and matrix are implemented |
| Other        | `unsupported`  | Fail closed for reuse/publication                          | Never rewritten                                              |

Recognized versions validate `status`, optional timestamp,
requested/indexed language sets, skipped-language rows, SCIP companion state,
the optional positive `sqliteLayoutVersion`, and v3 shard maps. A fingerprint
is an opaque JSON identity for evidence and stable-generation compatibility,
preserving the pre-decoder v2/v3 contract; freshness and publication
additionally require it to be an object. Language lists contain unique names
from the same
`SUPPORTED_LANGUAGES` catalog used by configuration.

When the fingerprint also decodes as the current versioned
`ProjectInputSnapshot`, a fixed-snapshot receipt projects it as
`scip-query:index-inputs`. This is a derived identity over the existing
fingerprint bytes, not a second persisted identity field. The receipt compares
that projection only with a current fixed snapshot built under the same
project-input version; malformed, older, or otherwise unrecognized fingerprint
shapes remain usable only for the capabilities above and do not acquire an
index-alignment claim.

The SQLite layout field is an additive v3 upgrade boundary rather than a wire
version migration. A v3 record without it remains queryable, evidence-usable,
and eligible for language-shard reuse. It is not eligible for whole-SQLite
unchanged reuse. The next refresh can therefore reuse unchanged language SCIP
shards, establish the current post-conversion indexes and planner statistics,
and publish a new generation without rerunning those indexers.

## Capability matrix

A capability is a named permission to interpret a decoded record for one
operation. It differs from version support because two consumers can accept
the same version while intentionally requiring different completeness.

| Capability                    | Required facts                                                                    | Partial status                            | v2  | v3  |
| ----------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------- | --- | --- |
| `usableForQuery`              | Valid indexed-language set                                                        | Yes                                       | Yes | Yes |
| `usableForEvidenceCache`      | Fingerprint value                                                                 | Yes; status is part of the cache key      | Yes | Yes |
| `publishableGeneration`       | Complete status, object fingerprint, indexed-language set                         | No                                        | Yes | Yes |
| `stableGenerationIdentity`    | Complete status, fingerprint, valid `updatedAt`; languages projected when present | No                                        | Yes | Yes |
| `languageShardReuse`          | Valid v3 `languageFingerprints` map                                               | Yes, for individually successful shards   | No  | Yes |
| `typescriptProjectShardReuse` | Valid v3 `typescriptProjectShards` map                                            | Yes, for individually successful projects | No  | Yes |

Consumer-specific comparisons happen only after this matrix accepts the
record:

- freshness compares a publishable fingerprint and sorted indexed languages
  with current inputs; whole-SQLite unchanged reuse additionally requires the
  current `sqliteLayoutVersion`;
- shared-generation publication additionally verifies the immutable artifact
  set, project root, and database integrity;
- evidence and TypeScript semantic cache keys accept complete or partial
  records and include status, so partial and complete results cannot collide;
- SQLite and TypeScript service generation identities use the same canonical
  projection, including `sqliteLayoutVersion` when present, and reject records
  without stable-identity capability;
- per-language and per-project reuse compare the decoded v3 shard
  fingerprints with current fingerprints and require the corresponding shard
  file to exist.

## Evolution procedure

Adding version 4 requires one reviewed change to the decoder and capability
matrix, explicit migration into a typed model, fixtures for every
version/status/capability row, and boundary tests for freshness, evidence,
generation identity, incremental reuse, semantic sessions, and shared
publication. A future version must remain visible as unsupported until those
conditions are met; silently treating it as v3 is a compatibility failure.
