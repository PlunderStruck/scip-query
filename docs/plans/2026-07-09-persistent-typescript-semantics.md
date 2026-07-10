# Persistent TypeScript Semantics — Phase 3 Concrete Plan

Date: 2026-07-09
Status: in progress; steps 3.1–3.2 complete and step 3.3 next
Roadmap phase: 3

## Goal

Keep TypeScript compiler state alive in the repository's existing
demand-started service and persist semantic results under identities narrow
enough that an unrelated edit does not erase them. Phase 3 is complete when
separate CLI processes reuse one compatible ts-morph Project set, an ordinary
leaf edit preserves at least 95% of unaffected semantic fragments, warm
TypeScript-heavy commands meet the roadmap speed gate with exact output parity,
and every service/cache failure falls back to the current direct provider.

A **compiler session** is a long-lived owner of parsed source files, module
resolution, and the TypeScript type checker; what distinguishes it from a
result cache is that it preserves the compiler's live program state from which
new answers are computed. A **semantic fragment** is the complete set of one
kind of compiler-derived facts attributable to one source file; its file
ownership lets unchanged facts survive while another file is recomputed. A
**semantic identity** is a deterministic digest of a file, every transitive
input capable of changing that file's compiler answers, configuration, compiler
engine, and fragment schema; equal identities are the proof required to reuse a
fragment. A **mailbox** is a repository-local request/response directory whose
atomic files let a synchronous CLI process ask the asynchronous project service
for semantic work without sharing memory.

The master contract remains
[`2026-07-09-automatic-incremental-indexing-roadmap.md`](./2026-07-09-automatic-incremental-indexing-roadmap.md).
Phase 2's 100%-recall affected-set evidence is the prerequisite.

## Scope Boundary

Phase 3 does not emit partial SCIP documents, skip scip-typescript, mutate the
published graph database incrementally, default durable Rust routing, or add
concurrent writers. The current whole-project SCIP rebuild remains
authoritative. The service owns at most one compatible TypeScript session per
repository, sleeps after the existing clean-idle timeout, and is woken by the
same enabled CLI/hook paths already delivered in Phase 1.

The remote route is an optimization, never a new availability requirement. A
stopped, stale, incompatible, timed-out, malformed, or crashing service causes
the calling process to construct the existing in-process ts-morph provider and
return its answer. Configuration, ambient declaration, add/delete, unknown
dependency, unreadable input, or missing graph evidence invalidates the whole
TypeScript semantic namespace. No failed or partial computation is cached.

## Verified Starting Point

- `createTsMorphProvider()` discovers tsconfigs and calls
  `createTsMorphProjectBundles()` on every new CLI process. The current
  `SemanticSessionManager` is a `WeakMap<ScipDatabase,...>` and therefore
  reuses only within one process and one database object.
- `TsMorphSemanticProvider` already batches references and callees and keeps
  in-memory import, reference, callee, signature, definition-node, and
  source-file indexes. This provider remains the compiler-correct oracle.
- The Phase 1 watch service is already one repository-scoped writer with
  heartbeat, version identity, single-flight refresh, command/hook wake-up,
  crash recovery, and ten-minute clean-idle shutdown. It currently has no
  request protocol beyond activity/refresh files.
- TypeScript semantic-reference rows are keyed by the whole reindex
  fingerprint. Any source edit therefore misses every definition-centric row.
  TypeScript import usage and signatures are not durable; semantic callees use
  file content plus only direct dependency contents.
- Phase 2 now persists a canonical TypeScript input snapshot, dependency graph,
  conservative affected plan, and normalized old/new fact comparison. Its
  accepted leaf ratios were 0.328% on scip-query and 0.0395% on OpenCode with
  100% recall.
- `plan-context` reports two external consumers of
  `createTsMorphProvider()` and medium file-level risk. Co-change evidence
  identifies `provider-cache.ts`, `semantic/types.ts`, TypeScript status, CLI
  context, and package identity as the relevant boundaries.

## Reuse and Architecture Decisions

| Need                            | Existing unit                                                   | Decision                                                                                                         |
| ------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Project owner                   | Phase 1 `runWatchServiceServer()`                               | Extend this process; do not add a second TypeScript daemon.                                                      |
| Compiler oracle                 | `TsMorphSemanticProvider` and `createTsMorphProjectBundles()`   | Reuse and inject existing bundles; never fork semantic rules.                                                    |
| Sync cross-process request      | durable Rust atomic mailbox pattern                             | Reuse the protocol shape and atomic writer in a TypeScript-specific module under the watch cache directory.      |
| Change safety                   | Phase 2 snapshot, dependency graph, affected plan               | Derive one conservative per-file semantic identity; uncertainty widens to a whole-project digest.                |
| Persistent storage              | rebuildable sibling `evidence.db` and evidence-product manifest | Add versioned TypeScript file-evidence products; avoid a second database or Phase 5 generation schema.           |
| References                      | current definition-centric batches                              | Store origin-file fragments keyed by origin identity, then assemble requested definitions by stable SCIP symbol. |
| Import usage/signatures/callees | current provider methods and callee cache                       | Store file-owned batches under the same semantic identity; retain old reads during rollout.                      |
| Fallback                        | `createTsMorphProvider()`                                       | Remote provider lazily constructs this exact provider after any request failure.                                 |

Reference facts must be owned by the file containing the reference, not the
file defining the target symbol. A consumer edit can add a reference to an
otherwise unchanged definition; a definition-keyed row cannot stay valid
without hashing the whole project. An origin-file fragment changes when that
consumer or its compiler dependencies change and can be assembled by stable
SCIP target symbol after a new index generation assigns new numeric IDs.

The semantic identity includes the source file, its complete forward dependency
closure, every TypeScript configuration/ambient input, sorted project
membership, ts-morph/TypeScript engine identity, and payload schema. Cycles are
visited once. Missing, unreadable, or unclassified evidence returns a
whole-project identity or no cache key; it never returns an unjustifiably
narrow key.

## Testability Design

| Behavior           | Pure decision core                           | Injected shell                                | Discriminating contract                                                                  |
| ------------------ | -------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Semantic key       | ordered dependency/config/member digest      | metadata/graph reader                         | unrelated leaf preserves other keys; export/config/add/delete changes every required key |
| Session transition | retain/refresh/add/delete/replace plan       | ts-morph Project adapter                      | ordinary edit creates zero replacement Projects; config/unknown replaces all             |
| Fragment assembly  | stable-symbol grouping/deduplication         | provider and evidence products                | origin fragment equals the legacy definition-centric oracle                              |
| Mailbox            | request/response parser and state classifier | atomic files, process liveness, clock         | malformed/stale/wrong-version response cannot be accepted                                |
| Remote fallback    | route/failure decision                       | service requester and direct provider factory | timeout/crash returns byte-identical direct answer                                       |
| Lifecycle          | activity/idle decision                       | existing watch loop                           | semantic request wakes/extends activity; pending work blocks idle exit                   |

Every verifier is planted red before it is trusted: omit one origin fragment
from assembly, reuse a key across an export dependency change, and inject a
wrong-generation mailbox response. Each must fail with the exact missing or
rejected unit.

## Pre-Registered Measurements

Machine history:
`docs/benchmarks/runs/2026-07-09-typescript-semantic-session.jsonl`.
All accepted timing series use one warm-up plus five alternating runs from the
same built CLI, corpus commit, cache state, and service state.

The pre-change scip-query `unused-imports
src/semantic/shared-primitives.ts --json` series produced the stable SHA-256
`de4ce6c21a7d9100288e663c7a02b12e94df85d0b773a36b353609ddc224be0b`.
Its five process-wall samples were 1,307/920/908/927/931ms: 927ms median and
1,307ms p95. Each process constructed Projects in 206–218ms (212ms median) and
spent 424–451ms computing import usage (432ms median).

| Gate                        | Acceptance                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-process Project reuse | After the first semantic request, five fully warm CLI processes cause zero new unchanged Project constructions in the caller or service.                         |
| Unaffected fragments        | After one ordinary leaf edit, at least 95% of eligible unchanged TypeScript file fragments hit; changed/affected fragments miss.                                 |
| Speed                       | TypeScript-heavy command median improves at least 20% (local target <=742ms) or measured Project/semantic span improves at least 50%; p95 must not regress >10%. |
| Parity                      | Remote/direct and fragment/legacy outputs have identical normalized facts and command SHA-256 on fixture, scip-query, and OpenCode.                              |
| No-op cost                  | Existing exact reindex no-op median/p95 regress no more than 10%; non-semantic CLI commands do not eagerly construct a Project.                                  |
| Lifecycle                   | Cold start, sleeping wake, idle exit, crash, timeout, wrong protocol/version, concurrent requests, config replacement, and direct fallback all pass.             |
| Packaging                   | Packed install includes the watch server and every semantic helper; installed binary passes remote and fallback smoke.                                           |

OpenCode is retained as the independent TypeScript-heavy 29-tsconfig corpus.
Its baseline target will be selected and recorded before step 3.2 changes
runtime behavior.

## Implementation Steps

Each step is one surgical commit with focused tests and matching SCIP
postchecks.

### 3.1 — Define conservative per-file semantic identities

- [x] **Create:** `src/semantic/typescript/semantic-identity.ts` and focused
      tests.
- Parse the published TypeScript language snapshot, derive project membership
  and config/ambient identities, traverse the existing dependency graph, and
  return a versioned key or explicit unkeyed reason.
- Cover leaf, chain, cycle, export dependency, add/delete membership,
  config/ambient, unreadable, missing graph, engine version, and stable ordering.
- Validate with focused tests and `recent-duplicates`.
- **Outcome:** `buildTypeScriptSemanticIdentity()` now produces an ordered
  dependency-closure key from the target, all transitive dependencies, every
  TypeScript config/ambient input, sorted project membership, TypeScript project
  mode, engine identity, and fragment schema. Missing graph evidence safely
  selects a readable whole-project key. Missing/duplicate/unreadable required
  inputs return an explicit unkeyed result. Eight tests cover leaf isolation,
  export propagation, cycles, ordering, config/ambient, add membership,
  missing evidence, engine/schema, and project identity. The required unsafe
  verifier was observed red: forcing a consumer key to remain equal across a
  dependency export change failed with the exact before/after digests; restoring
  the invalidation expectation made all controls green.

### 3.2 — Add origin-file fragment contracts and shadow storage

- [x] **Edit:** semantic types/provider, TypeScript provider, evidence-product
      manifest/cache, shared primitives, and real SQLite/provider tests.
- Add reference fragment shapes keyed by stable symbols and the step 3.1
  identity. Produce fragments from the existing provider and
  compare assembled results against its legacy definition-centric answers.
- Dual-write accepted fragments while legacy reads remain authoritative.
  Record hit/miss/parity telemetry. The planted omitted-origin verifier must be
  observed red.
- Validate schema/evidence manifest and recent-duplicate/incomplete-migration
  checks.
- **Outcome:** The provider can now invert its existing compiler-correct
  definition answers into canonical origin-file fragments and reassemble any
  requested definition set by stable SCIP symbol. A new evidence product writes
  all accepted file fragments in one SQLite transaction under the semantic
  identity. The legacy definition-centric map remains authoritative; the
  shadow recorder writes only after exact missing/extra comparison passes and
  converts every exception into unavailable telemetry. The generated fixture
  persisted and reread a real consumer fragment. Twenty-seven focused
  provider/storage/manifest tests pass. The discriminating omitted-origin
  control reported `passed: false` with the two exact missing symbol/file/line/
  column facts before the complete fragment set passed.

  Import usage, signatures, and callees were deliberately left in step 3.5.
  Reference ownership is the non-obvious safety boundary and needed its own
  shadow oracle; mixing simpler file-owned caches into this commit would have
  hidden whether failures came from fragment inversion or ordinary key reuse.
  This changes sequencing, not Phase 3 scope or gates.

### 3.3 — Keep ts-morph Projects alive across compatible generations

- [ ] **Create:** a TypeScript semantic host with an injected Project factory,
      source updater, and database/provider rebinder.
- Refresh modified source files, add/delete source files, and retain compatible
  bundles. Replace the session on tsconfig/package/compiler/project identity or
  uncertain change.
- Prove ordinary edits create zero replacement Projects and config edits replace
  exactly once. Preserve direct provider construction unchanged.

### 3.4 — Route synchronous CLI semantics through the existing service

- [ ] **Create/Edit:** TypeScript mailbox requester/host integration, watch
      protocol/state, remote provider, CLI status, build entries, and lifecycle
      tests.
- Lazily create the host on the first semantic request; process one request at
  a time under the existing single project owner; count created/reused/
  refreshed/replaced sessions and requests.
- A semantic request records service activity. Idle shutdown disposes Projects;
  the next eligible command wakes a new service. Every requester failure lazily
  falls back to the direct provider.
- Prove stale/wrong-version responses, crash, timeout, concurrent requests,
  sleep/wake, package installation, and no eager construction for ordinary
  commands.

### 3.5 — Make verified fragments authoritative with dual-read rollback

- [ ] **Edit:** shared semantic/callee materialization and evidence storage.
- Read TypeScript origin fragments first, assemble requested definitions by
  stable symbol, and fall back to legacy rows/provider on any absent, malformed,
  unkeyed, or parity-failing unit. Continue old definition-centric reads and
  writes for one rollout phase.
- Apply the same semantic identity to TypeScript import usage, signatures, and
  callees. Batch all SQLite work. Expose per-kind eligible/hit/miss/fallback
  counts.
- Prove >=95% unaffected hits after a leaf edit and exact full-rebuild parity.

### 3.6 — Calibrate, package, and close Phase 3

- [ ] **Create/Edit:** a bounded session/fragment harness, machine JSONL,
      campaign ledger, this plan, and the master roadmap.
- Run cold/warm, separate-process, edit, config, sleeping wake, service restart,
  crash/fallback, and alternating corpus controls on scip-query and OpenCode.
- Run typecheck, build, lint, full tests, package dry-run/install smoke,
  relevant SCIP postchecks, repository-build reindex, and diff-gate.
- Close only if all gates pass. Otherwise keep the direct route authoritative,
  record the measured boundary, and do not begin Phase 4.

## Stress and Rollback Rules

| Case                                    | Required result                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Command races a refresh                 | Request binds to one published database generation; retry or direct fallback after promotion, never mix IDs.          |
| Edit during semantic request            | Current request completes against its bound generation; queued transition applies before the next generation request. |
| Project/config identity changes         | Dispose and replace the session; whole-project semantic keys change.                                                  |
| Service or requester crashes            | Atomic mailbox leaves no accepted partial response; caller uses direct provider.                                      |
| Mailbox response arrives late           | Request ID plus protocol/generation identity rejects it and cleanup removes it.                                       |
| Evidence DB is locked/corrupt/read-only | Existing disable-on-error behavior yields cache misses and direct computation.                                        |
| Multiple CLI commands                   | One service processes deterministic request order; callers have independent response files.                           |
| Service goes idle                       | Only clean idle exits; active/pending semantic requests count as activity and prevent exit.                           |
| Installed CLI version changes           | Existing service is incompatible, replaced, and its in-memory Projects are discarded.                                 |

The mailbox route is a two-way door because the direct provider remains. New
evidence rows are rebuildable and ignored by older installs. The only harder
door—removing legacy reads—is explicitly deferred beyond Phase 3.

## Exact Next Action

```sh
SCIP_QUERY_SKIP_WATCH_SERVICE=1 node dist/cli.js plan-context src/reindex/affected-set.ts --json
```
