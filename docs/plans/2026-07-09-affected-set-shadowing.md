# Affected-Set Shadowing — Phase 2 Concrete Plan

Date: 2026-07-09
Status: ready for implementation
Roadmap phase: 2

## Goal

Prove which files can have compiler-derived graph or semantic answers changed
by an edit before scip-query uses that prediction to skip work. Phase 2 is done
when every clean-full-rebuild change in the fixture and selected corpus matrix
is contained by the predicted set, ordinary leaf edits predict fewer than 20%
of project files on at least two representative TypeScript projects, uncertain
inputs widen to the containing project, and prediction telemetry is persisted
without changing the authoritative full-rebuild output.

An **affected set** is the collection of indexed files whose compiler-resolved
answers may differ after a change; what distinguishes it from a changed-file
list is that it includes transitive consumers that can observe changed meaning.
A **change manifest** is a versioned comparison between two project input
snapshots; what distinguishes it from filesystem events is that it identifies
added, modified, deleted, configuration, and unreadable inputs from canonical
content identities rather than event order. **Shadowing** is a validation mode
whose defining behavior is that it records what an optimization would have
done while the existing full rebuild remains the only production writer.

The master contract and later phases remain in
[`2026-07-09-automatic-incremental-indexing-roadmap.md`](./2026-07-09-automatic-incremental-indexing-roadmap.md).

## Scope Boundary

Phase 2 does not skip an indexer, reuse a ts-morph Project, replace a SCIP
document, mutate SQLite incrementally, or default the durable Rust transport.
It computes and records a conservative prediction next to the existing full
reindex. The old database stays readable until the existing temporary SCIP,
SQLite, and metadata files are atomically promoted.

The prediction is allowed to over-invalidate. It is never allowed to omit a
document or fact changed by the clean full-rebuild oracle. Add/delete events,
compiler/configuration changes, ambient declarations, unresolved inputs,
malformed identities, and unavailable dependency evidence initially widen to
the full containing TypeScript project. Narrower behavior must earn its own
fixture and parity evidence before changing that rule.

## Current State

- `fingerprintProjectFiles()` already enumerates project inputs and records a
  canonical relative path, byte size, and SHA-256 for each readable file;
  unreadable files receive the explicit `size: -1` / `hash: 'unreadable'`
  identity. Source: `SCIP_QUERY_SKIP_WATCH_SERVICE=1 node dist/cli.js code
  fingerprintProjectFiles --json` (`src/reindex/project-files.ts:30-58`).
- `computeReindexFingerprint()` already combines those file identities with
  languages, workspace mode, explicit TypeScript projects, and Clojure config.
  The private `ReindexFingerprint` is the current whole-generation identity.
  Source: `... code ReindexFingerprint --json`; `... code
  computeReindexFingerprint --json` (`src/reindex/index.ts:1560-1589`).
- The published metadata keeps the preceding complete fingerprint and the
  per-TypeScript-project file fingerprints. This repository currently has one
  `.` TypeScript project with 478 fingerprinted inputs, so every TypeScript
  source edit still invalidates that entire shard. Source: the published
  `meta.json` control recorded on 2026-07-09; `... code ReindexMetadata --json`.
- `buildFileDepGraph()` already builds and durably caches file dependency edges
  from SCIP plus source imports. It is consumed by nine analysis/query modules;
  Phase 2 must reuse the product rather than introduce a second import graph.
  Source: `... code buildFileDepGraph --json`; `... refs buildFileDepGraph
  --json` (`src/symbols/graph/file-dep-graph.ts:43-126`).
- The existing `affected()` command computes a symbol-level consumer closure,
  not a file-level invalidation plan. No exported file reverse-closure or
  change-manifest unit exists. Source: `... code affected --json`; `... similar
  transitiveClosure --json --full` returned no reuse candidate.
- `runLanguageIndexersForFreshReindex()` classifies whole-language and
  TypeScript project-shard reuse, runs every missed project indexer, merges the
  outputs, and reports shard diagnostics. It has no per-document prediction.
  Source: `... code runLanguageIndexersForFreshReindex --json`
  (`src/reindex/index.ts:488-588`).
- `publishFreshReindexArtifacts()` converts the candidate SCIP output to a
  temporary SQLite database and augments it before `promoteReindexArtifacts()`
  replaces the old SCIP, SQLite, and metadata files. This is the safe dual-DB
  comparison seam: both complete graph generations exist immediately before
  promotion. Source: `... code publishFreshReindexArtifacts --json`; `... code
  promoteReindexArtifacts --json` (`src/reindex/index.ts:879-925,1541-1552`).
- `Watcher.runReindex()` forks the existing worker with the current config and
  trigger; it does not need a second writer or a new daemon protocol for Phase
  2. Source: `... code Watcher:runReindex --json`
  (`src/runtime/watch.ts:266-306`).
- The freshly built repository CLI reports a fresh index and valid Phase 1
  config. The globally installed 0.15.0 binary is an older build with the same
  semver and rejects `watch.cooldownMs: 0` / `watch.idleTimeoutMs`; use
  `node dist/cli.js` for Phase 2 evidence and keep install/upgrade identity as a
  Phase 6 rollout gate. Source: paired `scip-query status --capabilities
  --json` and `node dist/cli.js status --capabilities --json` controls on
  2026-07-09.

## Reuse Audit

| Need | Existing unit to reuse | Decision |
| --- | --- | --- |
| Canonical file identities | `ProjectFileFingerprint`, `fingerprintProjectFiles()` | Reuse exactly; the manifest compares existing identities and does not re-hash files. |
| Project/config identity | `ReindexFingerprint`, `computeReindexFingerprint()` | Pass the existing previous/current structural values into the manifest core; do not create a second project fingerprint. |
| Project membership/dependencies | `assignFilesToProjects()`, `deriveProjectDependencies()`, `computeProjectShardFingerprints()` | Reuse for containing-project widening and workspace fixtures. |
| File dependency evidence | `buildFileDepGraph()` | Reuse the published graph as the prediction input; do not parse imports in the planner. |
| Indexed document inventory | `indexedDocumentPaths()` | Reuse for project universe and normalization. |
| Database access | `ScipDatabase` | Open the old and candidate databases through the existing wrapper and close both deterministically. |
| Atomic writer | `publishFreshReindexArtifacts()` / `promoteReindexArtifacts()` | Compare immediately before promotion; keep promotion authoritative and unchanged. |
| File-level reverse closure | None; symbol `affected()` is a different unit and no similar closure candidate was found | Add one pure planner in `src/reindex/affected-set.ts`; keep graph traversal independent of SQLite. |
| Old/new per-document graph digest | None; existing commands report aggregate/query views, not normalized document identity | Add a narrow oracle shell in `src/reindex/affected-shadow.ts`, using ordered SQLite rows and stable binary encodings. |
| Durable shadow telemetry | Existing metadata is the publication truth and version 3 is read by older installs | Write versioned `affected-shadow-latest.json` plus append-only JSONL beside `meta.json`; do not bump or overload reindex metadata. |

`src/reindex/affected-set.ts` is justified as the deterministic domain core:
identity comparison, path classification, conservative fallback, and reverse
closure have no filesystem/database dependency. `src/reindex/affected-shadow.ts`
is justified as the side-effect shell that opens two complete databases,
computes ordered graph digests, and writes telemetry. Keeping these units
separate prevents SQLite/process concerns from contaminating the safety rules.

## Testability Design

| Behavior | Test seam | Dependencies to inject | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Snapshot comparison | `buildProjectChangeManifest(previous, current)` | None | Stable sorted add/modify/delete/config classification | Existing fingerprint producer | Identical inputs yield an empty manifest; malformed/unreadable identity records uncertainty. |
| Conservative widening | `classifyAffectedSetFallback(manifest, context)` | Project membership and path policy values | Full-project/closure/no-index-work decision | None | Config, ambient, add/delete, unknown, or missing graph evidence never narrows. |
| Reverse dependency closure | `planAffectedFiles(manifest, graph, universe)` | Dependency map and indexed universe | Build reverse edges and traverse deterministically | `buildFileDepGraph()` supplies graph | Includes changed indexed files and all transitive consumers; cycles terminate; results sort canonically. |
| Graph oracle | `compareDocumentFactDigests(before, after)` | Ordered digest maps | Set comparison and recall calculation | `readDocumentFactDigests(db)` issues SQL | Every graph-bearing row is assigned to a document digest; binary fields use byte-stable encoding. |
| Recall gate | `evaluateAffectedSetShadow(predicted, actual)` | None | Missing/extra set calculation, recall, ratio | None | Any actual unit outside prediction produces `passed: false`; empty actual set has recall 1. |
| Reindex integration | `recordAffectedSetShadow(context)` | DB opener, clock, atomic writer, append writer | Manifest/planner/evaluator above | Old/new DB reads and telemetry files | Failures record a conservative error/fallback and never alter the production generation. |
| Status observability | existing status formatter/JSON envelope | Latest-record reader | Additive state selection | Read `affected-shadow-latest.json` | Missing/malformed telemetry reports unavailable; ordinary query JSON is unchanged. |
| Harness mutation | `scripts/affected-set-shadow-contract.mjs` | Fixture edit operations and built CLI | Expected containment/hash checks | Temp repos, full rebuilds, restoration | A deliberately omitted expected file makes the harness fail before green controls are trusted. |

## Pre-Registered Measurements

The Phase 1 run history remains the timing baseline. Phase 2 adds a distinct
`docs/benchmarks/runs/2026-07-09-affected-set-shadow.jsonl` history. Every real
timing scenario runs five times after one warm-up with alternating order.

| Scenario | Current baseline | Phase 2 acceptance |
| --- | ---: | --- |
| Local exact no-op | 329ms median / 348ms p95 internal | No shadow work on empty manifest; no-op median/p95 regression <=10%. |
| Local TypeScript leaf edit | 4.543s median / 4.885s p95 to fresh | 100% document/fact recall; predicted project ratio <20%; shadow overhead median <=10%, p95 <=20%. |
| Twenty writes over 500ms | 5.065s median / 5.229s p95 | One authoritative refresh remains; one shadow record corresponds to its final manifest. |
| Export/signature edit | Not yet isolated | 100% graph and semantic-output recall/hash parity against clean rebuild. |
| Import-edge edit | Not yet isolated | Changed file plus all observed consumers contained; zero misses. |
| Add/delete/ambient/config edit | Whole project today | Prediction explicitly widens to containing project; zero misses. |
| Missing/malformed prior state | Whole project today | Full fallback with reason; production full rebuild succeeds. |
| Second representative TS project | Not yet selected in the run history | Five leaf edits at 100% recall and median predicted ratio <20%. |

The stable output contract includes normalized document graph digests plus the
existing command/fact controls used by the campaign: documents, symbols,
definitions, references, kind counts, TypeScript references, callees,
signatures, and import usage where available. A command output may be hashed
only after timestamps, ordering, and cache-disposition fields that do not
describe facts are normalized.

## Implementation Steps

Each numbered step is one commit. The arithmetic gate is strict: completed
steps must equal Phase 2 implementation commits before the next step starts.

### 2.1 — Define canonical manifest and fallback contracts

- [x] **Create:** `src/reindex/affected-set.ts`,
      `tests/reindex/affected-set.test.ts`
- [x] **Edit:** `src/reindex/project-files.ts`
- **Source:** `... code fingerprintProjectFiles --json`; `... code
  ReindexFingerprint --json`; `... refs fingerprintProjectFiles --json`.
- **What:** Current fingerprints prove whole-generation equality but do not
  expose a versioned change list or an uncertainty classification.
- **Change:** Add structural snapshot input types, stable added/modified/deleted
  comparison, source/config/ambient/other path classification, and explicit
  full-project fallback reasons. Accept the existing fingerprint shape rather
  than reading files.
- **Testability:** Pure functions only; table tests cover ordering, multiple
  changes, unreadable records, config identity changes, ambient declarations,
  add/delete, and empty manifests. Plant one unsafe narrow expectation first
  and observe it fail before making the conservative rule green.
- **Validation:** `npx vitest run tests/reindex/affected-set.test.ts`;
  `SCIP_QUERY_SKIP_WATCH_SERVICE=1 node dist/cli.js recent-duplicates --json
  --full`.
- **Why:** Every later traversal and oracle depends on a deterministic statement
  of what changed. Landing the pure contract first is deployable and has no
  runtime behavior.
- **Outcome:** The pure manifest now emits canonically sorted add/modify/delete
  records from existing fingerprints and separates ordinary source changes from
  ambient, config, unclassified, unreadable, duplicate, version-mismatched, and
  missing-prior-state fallbacks. Ten focused tests pass. The required verifier
  probe was observed red: checking source extension before ambient suffix made
  `globals.d.ts` classify as ordinary source and produced two failing tests,
  including an unsafe `fullProject: false`; ambient precedence then made the
  suite green. No production caller consumes the new contract yet.

### 2.2 — Plan the conservative file closure from existing graph evidence

- [ ] **Edit:** `src/reindex/affected-set.ts`,
      `tests/reindex/affected-set.test.ts`
- **Source:** `... code buildFileDepGraph --json`; `... refs
  buildFileDepGraph --json`; `... code affected --json`; `... code
  deriveProjectDependencies --json`.
- **What:** The dependency graph maps a file to its dependencies; no file-level
  reverse-closure API or affected-set policy exists.
- **Change:** Add deterministic reverse adjacency and transitive consumer
  traversal. Combine it with manifest fallback rules and an injected project
  universe. Missing graph evidence, changed source outside the indexed
  universe, add/delete, ambient, config, or unknown input widens to the project.
- **Testability:** Pure graph maps and universes; fixtures cover leaf, chain,
  diamond, cycle, multi-change, disconnected indexed file, missing edge data,
  and workspace project widening.
- **Validation:** Focused tests plus `SCIP_QUERY_SKIP_WATCH_SERVICE=1 node
  dist/cli.js similar planAffectedFiles --json --full` after reindex.
- **Why:** The safety policy must be proved without opening SQLite before a
  side-effect shell can consume it.

### 2.3 — Build the clean-full document/fact oracle and prove the verifier

- [ ] **Create:** `src/reindex/affected-shadow.ts`,
      `tests/reindex/affected-shadow.test.ts`,
      `scripts/affected-set-shadow-contract.mjs`
- **Source:** `... outline src/storage/scip-documents.ts --json`; `... outline
  src/storage/db.ts --json`; `... code publishFreshReindexArtifacts --json`.
- **What:** Old and candidate SQLite files coexist before promotion, but no
  normalized per-document graph comparison exists.
- **Change:** Read ordered document, chunk/occurrence, mention/symbol,
  relationship, and definition-range rows into per-document SHA-256 digests;
  compare digest maps; calculate misses, extras, recall, and affected ratio.
  Add a bounded fixture harness that performs a real full rebuild and restores
  every edited file/cache/service state in `finally`.
- **Testability:** Inject ordered row arrays into digest normalization; use tiny
  temporary SQLite fixtures for the shell. First mutate the expected actual set
  so the recall gate demonstrably fails, record the failure, then restore the
  correct expectation.
- **Validation:** Focused tests, one red/green verifier probe, and a built fixture
  smoke whose before/after graph digests differ exactly where expected.
- **Why:** A prediction cannot be calibrated against aggregate counts; the
  verifier must identify the specific document/fact unit it would have missed.

### 2.4 — Record shadow results at the existing atomic publication seam

- [ ] **Edit:** `src/reindex/index.ts`, `src/reindex/affected-shadow.ts`,
      `src/runtime/config.ts`, focused reindex reliability/JSON tests
- **Source:** `... code publishFreshReindexArtifacts --json`; `... code
  promoteReindexArtifacts --json`; `... code buildPublishedReindexMetadata
  --json`; `... co-change src/reindex/index.ts --json`.
- **What:** Full reindex currently converts/augments the candidate DB, writes
  metadata, then promotes all artifacts; no shadow comparison is recorded.
- **Change:** Before promotion, build the manifest from prior/current
  fingerprints, read the existing dependency graph, plan the set, and compare
  old/candidate digests. After successful promotion, atomically write the latest
  versioned record and append JSONL. Keep metadata v3 and all full indexer/write
  decisions unchanged. On oracle/telemetry failure, publish the full generation
  and record/emit a conservative unavailable reason where possible.
- **Testability:** Inject DB opener, clock, path resolver, and record writers into
  the orchestrator. Reliability tests force old-DB absence, malformed metadata,
  digest failure, telemetry write failure, and promotion failure.
- **Validation:** Reindex focused tests, `npm run typecheck`, built manual edit
  smoke, and exact output hashes before/after integration.
- **Why:** This is the first runtime step and remains reversible because it only
  observes the two already-complete generations.

### 2.5 — Make shadow evidence observable without changing query contracts

- [ ] **Edit:** `src/runtime/commands/command-handlers.ts`,
      `src/runtime/commands/command-descriptors.ts` only if a dedicated option
      is justified, `README.md`, focused status/CLI tests, generated docs
- **Source:** `... plan-context src/runtime/commands/command-handlers.ts --json`;
  `... code formatStatus --json`; `... co-change
  src/runtime/commands/command-descriptors.ts --json`.
- **What:** Status reports freshness and service state but cannot report the
  last affected prediction, fallback reason, recall, or telemetry path.
- **Change:** Add an `affectedSetShadow` object to status JSON and a compact
  human summary. Missing/malformed/old records are `unavailable`, not success.
  Ordinary navigation/health/query JSON remains byte-for-byte unchanged.
- **Testability:** Inject latest-record reads into the formatter/handler and
  cover absent, malformed, passing, failing, and fallback records.
- **Validation:** Focused status and CLI contract tests; regenerate command docs
  only if the public command surface changes; built JSON smoke.
- **Why:** Shadow evidence must be diagnosable before a maintainer can trust or
  reject narrowing rules.

### 2.6 — Calibrate on fixtures and two representative TypeScript projects

- [ ] **Edit:** `scripts/affected-set-shadow-contract.mjs`, Phase 2 tests,
      `docs/benchmarks/runs/2026-07-09-affected-set-shadow.jsonl`, campaign
      ledger, this plan, and the master roadmap
- **Source:** this plan's pre-registered table; campaign output contract;
  `... status --capabilities --json` for every corpus before measurement.
- **What:** Phase 2 cannot become authoritative from local happy-path tests.
- **Change:** Run leaf, export/signature, import-edge, multi-file, add/delete,
  ambient declaration, tsconfig/package, malformed-state, sleeping-service,
  and alternating-order controls. Use scip-query plus the selected large
  TypeScript corpus; record why the second corpus is representative. Hash graph
  and semantic fact outputs and report every miss/fallback/ratio.
- **Testability:** Harness copies/restores exact bytes, verifies clean Git state,
  stops services in `finally`, and never writes run history while a measured
  daemon is live. A planted under-prediction must fail the harness.
- **Validation:** 100% recall on every fixture/corpus; leaf median predicted
  ratio <20% on both projects; timing/overhead gates above; no output mismatch.
  Then run typecheck, build, lint, full tests, package dry run, matching SCIP
  postchecks, repository-build reindex/diff-gate, and installed-package smoke.
- **Why:** Only the corpus matrix can close Phase 2 and permit Phase 3 to key
  semantic caches by affected identity. Any miss blocks closure and becomes a
  regression fixture.

## Stress-Test Findings

| Case | Required response |
| --- | --- |
| Duplicate/missed/reordered file events | Ignore event identity; compare canonical snapshots. |
| Edit during refresh | The existing dirty follow-up produces a later manifest; never merge observations across published generations. |
| Add or delete | Full containing-project fallback until an unresolved-import/deletion oracle proves narrower behavior. |
| Ambient `.d.ts`, tsconfig, package/lock/compiler config | Full containing-project fallback. |
| Source file absent from indexed universe | Full containing-project fallback with reason. |
| Dependency graph missing/malformed/stale | Full containing-project fallback; never return only the changed file. |
| Cycle/diamond | Visited-set traversal terminates and de-duplicates deterministically. |
| Old database missing | Record unavailable/full fallback; production full rebuild remains valid. |
| Candidate conversion/augmentation failure | Existing publish path fails; no shadow success record and old generation remains readable. |
| Telemetry write failure after promotion | Generation stays valid; surface degraded telemetry without rolling back correct index artifacts. |
| Older installed CLI reads metadata | Metadata remains v3; shadow state is an independent additive file. |
| Non-index document/config edit | Initially conservative fallback unless the manifest policy has an exact verified non-input classification. |
| Graph digest unchanged but semantic output changes | Semantic command oracle makes the miss visible; Phase 3 cannot use graph equality as semantic equality. |

## Execution and Ship Order

1. Commit this plan and roadmap baseline update.
2. Land 2.1–2.3 as testable contracts with no product behavior.
3. Land 2.4 shadow integration; full rebuild stays authoritative.
4. Land 2.5 observability only after real records exist.
5. Run 2.6 calibration; fix every miss before closing Phase 2.
6. Do not start Phase 3 cache-key migration until Phase 2 reports 100% recall.

Steps 2.1–2.5 are two-way doors because removing the new files/reads returns to
the existing full reindex. Making the predicted set authoritative is the
one-way behavioral door and is explicitly deferred beyond Phase 2. Metadata
version remains unchanged to preserve installed-binary rollback.

## Deviation Protocol

### 2026-07-09 — Reuse the existing path-policy constants

The reuse audit found that `COMMON_INDEX_INPUTS` and
`LANGUAGE_SOURCE_EXTENSIONS` already define the path policy needed by step 2.1,
but both are private to `project-files.ts`. Step 2.1 therefore also edits that
file to export `classifyProjectInputPath()` over the existing constants. This
avoids a second extension/config table and does not change
`isLanguageRelevantPath()` or any current fingerprint behavior. Rollback is
deleting the new export and the new shadow-only caller.

## File Summary

### Create

- `src/reindex/affected-set.ts`
- `src/reindex/affected-shadow.ts`
- `tests/reindex/affected-set.test.ts`
- `tests/reindex/affected-shadow.test.ts`
- `scripts/affected-set-shadow-contract.mjs`
- `docs/benchmarks/runs/2026-07-09-affected-set-shadow.jsonl`

### Edit

- `src/reindex/project-files.ts`
- `src/reindex/index.ts`
- status/CLI files only for additive observability
- focused reindex/runtime tests
- `README.md`
- campaign ledger
- master roadmap and this phase plan

### Delete

- None. Phase 2 is additive shadow infrastructure.

## Phase-Close Self-Report Contract

The closing commit must record the six implementation commits, the planted
verifier failure and observed red result, every corpus/scenario median and p95,
predicted/actual sets, fallback reasons, recall and ratios, output hashes/fact
counts, all deviations and deferrals, package/install smoke, full gate results,
and the exact first Phase 3 planning command.
