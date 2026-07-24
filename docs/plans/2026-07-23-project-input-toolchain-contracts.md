# Project-Input and Toolchain Contract Extraction

Date: 2026-07-23

## Goal

Remove every `semantic -> reindex` import while preserving the intended
`reindex -> semantic` direction. Done means project-input facts have a stable
domain owner, filesystem fingerprinting and executable discovery have platform
owners, reindex retains index-construction and installation policy, and the
existing project scans, hashes, probes, fallback paths, and public reindex
exports behave exactly as before.

## Definitions and Invariants

A project-input snapshot is the versioned record of configuration identity and
file fingerprints used to decide whether two observations of a repository
describe the same indexing input. Its referents are
`ProjectInputSnapshot`, `ProjectFileFingerprint`, and persisted generation
metadata. What distinguishes it from reindex policy is that it records and
compares facts without deciding how to build or publish an index.

A project-input transition is the deterministic comparison between a prior
snapshot and a current snapshot. Its referents are
`buildProjectChangeManifest`, `ProjectFileChange`, and
`ProjectChangeManifest`. What distinguishes it from affected-set planning is
that it reports changed facts and uncertainty while making no decision about
whether to use a dependency closure or rebuild a full project.

A project-file fingerprinting mechanism is the host operation that enumerates
repository files and hashes their bytes or safe symlink targets. Its referents
are `listProjectFiles`, `fingerprintProjectFiles`, and
`buildProjectInputFingerprint`. What distinguishes it from the snapshot
contract is that it performs Git and filesystem I/O to produce the contract's
facts.

An indexer toolchain contract is the executable identity and resolution facts
needed to determine whether an external language indexer can run. Its
referents are accepted binary names, project-local paths, bundled package
metadata, .NET runtime requirements, and `IndexerDependencyStatus`. What
distinguishes it from reindex installation policy is that it observes the host
and reports a capability; it does not choose or execute an installation
method.

The following invariants must always hold:

- I1. A JSON value is accepted as a project-input snapshot if and only if the
  existing parser accepts it before extraction.
- I2. The project-change manifest must preserve its sorted change order,
  identity comparison, uncertainty reasons, and unreadable-file treatment.
- I3. Project-file enumeration must attempt the same single Git command, use
  the same filesystem fallback, exclusions, ordering, symlink containment
  check, read count, and SHA-256 inputs.
- I4. Reindex fingerprint construction must preserve version `2`, language
  ordering, workspace normalization, optional-path normalization, and file
  order.
- I5. Toolchain resolution must preserve binary candidate order, Windows
  spawnability rules, project-local precedence, bundled-package fallback, and
  .NET 9 runtime probing.
- I6. `tryInstallIndexer` must remain in reindex and preserve install-method
  order, prerequisite checks, timeouts, status messages, and manual recovery
  URLs.
- I7. Rust semantic status and Rust indexing must use one rust-analyzer
  executable identity and report the same availability, resolved binary, and
  reason as before.
- I8. The extraction must add no filesystem operation, Git process, hash,
  executable probe, index pass, retry, cache lookup, or forwarding function.
- I9. `domain` must remain dependency-free, and `platform` may depend only on
  `domain`.

## Premises

- P1. The index is fresh and TypeScript indexing, semantic evidence, compiler
  verification, cleanup analysis, and diff-gate are available. Source:
  `SCIP_QUERY_SKIP_WATCH_SERVICE=1 scip-query status --capabilities --json`.
- P2. The architecture graph maps 343 of 343 files, reports zero forbidden
  relationships, and contains one reciprocal `reindex <-> semantic` pair.
  The reverse `semantic -> reindex` direction consists of 9 file edges from 7
  semantic files to 4 reindex files. Source:
  `node dist/cli.js architecture --json`;
  `node dist/cli.js system src/semantic --json`.
- P3. Five TypeScript semantic files consume only snapshot, transition, and
  dependency-graph facts from `reindex/affected-set.ts`; that module also owns
  the higher-level affected-set fallback and closure policy. Source:
  `scip-query imports` for
  `semantic/typescript/reference-fragment-shadow.ts`,
  `semantic-identity-context.ts`, `semantic-identity.ts`,
  `session-host.ts`, and `session-service.ts`.
- P4. `ProjectInputSnapshot` is also consumed by reindex incremental planning,
  affected-set shadow evaluation, and persisted snapshot recovery.
  `buildProjectChangeManifest` has exactly three production consumer groups:
  affected-set shadow evaluation, TypeScript incremental planning, and the
  TypeScript semantic session transition. Source:
  `scip-query refs ProjectInputSnapshot --json`;
  `scip-query dataflow buildProjectChangeManifest --json`.
- P5. `fingerprintProjectFiles` is consumed by reindex fingerprinting, Vue
  augmentation, and Rust semantic project identity. It is produced from one
  project-file listing plus the existing language and caller filters. Source:
  `scip-query dataflow fingerprintProjectFiles --json`.
- P6. `buildProjectInputFingerprint` is consumed by reindex generation
  construction, shared-generation publication, and runtime freshness checks.
  Those are the complete production authors of current snapshot observations.
  Source: `scip-query refs buildProjectInputFingerprint --json`;
  `scip-query dataflow buildProjectInputFingerprint --json`.
- P7. Rust semantic status imports the Rust indexer configuration and generic
  indexer dependency probe solely to resolve rust-analyzer. The Rust
  configuration has one binary name, no alias, no project-local binary, no
  bundled npm package, and no .NET runtime requirement. Source:
  `scip-query imports src/semantic/rust/status.ts --json`;
  `scip-query code src/reindex/indexers.ts:87-101 --json`.
- P8. `getIndexerDependencyStatus` is also consumed by runtime project
  readiness and setup. Its producers are executable resolution, binary
  labeling, and the .NET runtime probe; installation is a separate
  `tryInstallIndexer` operation. Source:
  `scip-query dataflow getIndexerDependencyStatus --json`;
  `scip-query outline src/reindex/install.ts --json`.
- P9. Existing focused tests cover snapshot parsing and transitions,
  affected-set planning, project enumeration/fingerprinting, Git fallback,
  symlink containment, TypeScript project normalization, index freshness,
  executable aliases, bundled npm binaries, Windows spawnability, .NET
  runtime fallback, project setup, and Rust semantic consumers. Tests are not
  in the production SCIP index, so this inventory uses the narrow filesystem
  fallback. Source: `rg` under `tests/reindex`, `tests/runtime`, and
  `tests/semantic/rust`.

### State-authority premise

- P10. Reindex generation construction, shared-generation publication, and
  runtime freshness inspection are the complete production authors of current
  project-input observations. The parser readers are reindex snapshot
  recovery and TypeScript semantic identity/session code. The extraction
  moves their common record and pure transition logic; it does not introduce a
  new writer, persistence path, or snapshot version. Source: P4 and P6.

## Current State

`reindex/affected-set.ts` combines a stable, pure snapshot transition with the
reindex decision to widen a change into a full-project plan (P3-P4).
`reindex/project-files.ts` combines pure path classification with Git and
filesystem fingerprint production used outside reindex (P5-P6).
`reindex/install.ts` combines read-side host discovery with the write-side
installation workflow, while Rust semantic status imports the entire reindex
configuration to name one executable (P7-P8). These mixed owners create all
nine reverse file edges (P2).

## Reuse Audit

- Move the snapshot record, path classification, checked parser, change
  manifest, and file-dependency graph type together to
  `domain/project-input.ts`. Keep affected-set widening and reverse-dependency
  closure in reindex.
- Move the project-file enumeration, hashing, and fingerprint builder intact to
  `platform/project-files.ts`. Reuse domain classification; do not create a
  semantic-specific scanner or a second exclusion list.
- Move the read-side executable resolution and dependency-status functions
  intact to `platform/indexer-toolchain.ts`. Keep `tryInstallIndexer` in
  reindex.
- Name rust-analyzer once as a platform toolchain descriptor. Reindex adds SCIP
  invocation and installation policy around that descriptor; semantic asks
  the platform probe for its status.
- Remove non-public internal facades once every consumer imports the owner.
  Preserve the published `scip-query/reindex` names with direct compile-time
  re-exports from their owners, so no runtime forwarding call is introduced.

## Testability Design

| Behavior            | Test seam                    | Dependencies                         | Pure core                       | Side-effect shell                         | Contract                    |
| ------------------- | ---------------------------- | ------------------------------------ | ------------------------------- | ----------------------------------------- | --------------------------- |
| Snapshot validation | `projectInputSnapshotOrNull` | None                                 | Checked `unknown` guards        | None                                      | Same snapshot or `null`     |
| Change comparison   | `buildProjectChangeManifest` | None                                 | Sorted map/set comparison       | None                                      | Same manifest               |
| Affected planning   | Existing reindex planners    | Dependency graph                     | Existing closure/fallback logic | None                                      | Same plan                   |
| File listing        | `listProjectFiles`           | Git and filesystem                   | Existing exclusions/order       | One Git attempt or fallback walk          | Same paths                  |
| File hashing        | `fingerprintProjectFiles`    | Filesystem and crypto                | Existing filters                | One realpath plus one read/lstat per file | Same records                |
| Tool discovery      | Existing mocked module seam  | PATH, package resolution, filesystem | Candidate order                 | Existing probes only                      | Same resolved binary/status |
| Installation        | `tryInstallIndexer`          | Child process                        | Existing method order           | Existing installer call                   | Same messages/result        |
| Rust readiness      | `getRustSemanticStatus`      | Tool discovery                       | Existing status projection      | Existing probes only                      | Same capability payload     |

## Implementation Checklist

### 1. Extract the project-input domain contract

- [x] **Files**: new `src/domain/project-input.ts`,
      `src/reindex/affected-set.ts`
- **Premises**: P3, P4, P10
- **Deployable**: no — part of the single-deploy import migration.
- **Change**: Move the snapshot, file-change, manifest, dependency-graph, path
  classification, parser, and manifest builder to domain. Keep affected-set
  fallback and closure policy in reindex; update tests and production code to
  import the owner of each concept.
- **Testability**: Pure functions retain their existing inputs and outputs;
  domain-local checked guards replace the upward storage helper dependency
  without changing accepted values.
- **Validation**: Affected-set tests, typecheck, and dependency-row check.

### 2. Extract the platform fingerprint mechanism

- [x] **Files**: new `src/platform/project-files.ts`, remove
      `src/reindex/project-files.ts`, direct runtime/reindex/semantic consumers
- **Premises**: P5, P6
- **Deployable**: no — part of the single-deploy import migration.
- **Change**: Move enumeration, hashing, normalization, and fingerprint
  construction without branch changes. Import pure input classifiers and file
  records from domain; keep the former reindex path as direct re-exports.
- **Testability**: Existing Git/fs and temporary-project tests exercise the
  unchanged side-effect shell.
- **Validation**: Project-file, freshness, shared-cache, Vue, and Rust
  fingerprint tests; inspect the diff for unchanged I/O and hashing order.

### 3. Extract the read-side toolchain capability

- [x] **Files**: new `src/platform/indexer-toolchain.ts`,
      `src/reindex/install.ts`, `src/reindex/indexers.ts`,
      `src/semantic/rust/status.ts`, direct runtime/reindex consumers
- **Premises**: P7, P8
- **Deployable**: yes with steps 1 and 2.
- **Change**: Move executable description, candidate resolution,
  project-local/bundled resolution, dependency status, execution environment,
  and .NET probes to platform. Keep installation in reindex. Introduce one
  rust-analyzer descriptor reused by Rust SCIP configuration and semantic
  readiness.
- **Testability**: Preserve the existing module-mocking seam and exact process
  probes; add no availability cache because that would change freshness.
- **Validation**: Install/toolchain, project readiness/setup, Windows command,
  and Rust semantic tests.

### 4. Reroute all production consumers

- [x] **Files**: the 7 semantic importers plus touched reindex/runtime modules
- **Premises**: P2-P8
- **Deployable**: yes with steps 1-3.
- **Change**: Point every production consumer at the domain or platform owner.
  Preserve published reindex exports through direct re-exports from those
  owners; remove unused internal compatibility modules.
- **Testability**: TypeScript compiler resolution proves every moved type and
  value is imported from its owner; existing behavior tests remain the oracle.
- **Validation**: `rg` finds no production semantic import from reindex;
  architecture reports no `semantic -> reindex` relationship.

### 5. Reconcile architecture and verify neutrality

- [x] **Files**: `docs/architecture/scip-query-target-architecture.md`
- **Premises**: P1-P10
- **Deployable**: verification only.
- **Change**: Record the migration complete only from rebuilt architecture
  evidence. Run focused and full tests, build, typecheck, lint, matching
  migration postchecks, reindex, architecture, architecture drift, diff
  impact, and default diff-gate.
- **Validation**: The full suite and final diff gate are the shipping oracles;
  the production diff must show relocation and direct imports, not additional
  work.

## Attack Record

### A1. I9 via storage guards

- Attack: moving `projectInputSnapshotOrNull` to domain keeps its import from
  `storage/evidence-payload.ts`, creating a forbidden upward dependency.
- Outcome: HOLE — repaired by step 1 with small domain-local checked
  `unknown` guards that preserve the old string-array and record predicates.

### A2. I3 via a second semantic scanner

- Attack: Rust semantic fingerprinting receives a local file walker to avoid
  importing reindex, duplicating exclusions and silently changing symlink or
  unreadable-file behavior.
- Outcome: HOLE — repaired by step 2: all consumers reuse the one platform
  fingerprint mechanism (P5).

### A3. I5 via simplified rust-analyzer lookup

- Attack: semantic status changes to a raw `which rust-analyzer` call and
  diverges from Windows spawnability or future shared toolchain behavior.
- Outcome: HOLE — repaired by step 3: semantic and reindex reuse the same
  platform descriptor and resolver (P7).

### A4. I6 via moving installation into platform

- Attack: a lower host-mechanism boundary starts choosing package-manager
  commands and emitting workflow status.
- Outcome: HELD — step 3 leaves `tryInstallIndexer`, configured install
  methods, and user-facing install messages in reindex.

### A5. I8 via compatibility wrappers

- Attack: former module paths call new functions through forwarding bodies,
  adding stack frames to hot fingerprint or transition paths and producing
  redundant APIs.
- Outcome: HELD — internal callers import owners directly, and only the
  published reindex entry uses direct ECMAScript re-exports.

### A6. I4 via snapshot type consolidation

- Attack: the extraction opportunistically changes mutable fingerprint arrays,
  snapshot version literals, or `TypeScriptProjectMode` validation and alters
  persisted compatibility.
- Outcome: HELD — the slice relocates the current interfaces without
  redesigning or tightening the schema.

### A7. I8 via availability caching

- Attack: the new platform toolchain module caches a failed or successful PATH
  probe, making setup/install rechecks stale.
- Outcome: HELD — no cache is introduced; each existing caller performs the
  same probes at the same time as before.

## Rollback Boundary

The extraction is one deployable unit. If any invariant fails, restore the
original module ownership and imports together; do not keep parallel project
scanners, duplicate rust-analyzer descriptors, or forwarding functions as a
partial fallback.
