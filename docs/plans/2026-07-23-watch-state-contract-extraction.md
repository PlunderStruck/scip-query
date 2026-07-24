# Watch-State Contract Extraction

Date: 2026-07-23

## Goal

Move the persisted watch-service state contract below `runtime` so reindex and
semantic clients can read the shared record without depending on delivery
orchestration. Done means the two remaining reverse edges into `runtime` are
gone, the existing writer remains atomic, every previously accepted or
rejected JSON value produces the same result, and no polling, heartbeat,
fallback, or process-lifecycle behavior changes.

## Definitions and Invariants

A persisted watch-state contract is a cross-process data format whose referent
is `watch-state.json`; what distinguishes it from runtime lifecycle policy is
that it defines how every process locates and validates one stored service
record without deciding whether to start, stop, replace, or report the
service. Source: `node dist/cli.js code readWatchServiceState --json`; `node
dist/cli.js refs readWatchServiceState --json`.

A service-status snapshot is the nested semantic or index status stored inside
the outer watch-state record; what distinguishes it from the mailbox protocol
that produced it is that the outer parser validates its persisted fields while
the corresponding client independently decides whether its protocol version
is usable. Source: `node dist/cli.js code parseWatchServiceState --json`;
`node dist/cli.js code usableServiceState --json`.

Runtime lifecycle policy is the process-control logic that chooses start,
reuse, replacement, stop, cleanup, and reporting actions. Its referents are
`ensureWatchService`, `stopWatchService`, `classifyWatchServiceState`, and
`planWatchServiceAction`; what distinguishes it from the stored contract is
that it acts on a validated record and live process facts. Source: `node
dist/cli.js plan-context src/runtime/watch-service.ts --json`.

The following invariants must always hold:

- I1. A JSON value is accepted as `WatchServiceState` if and only if the
  existing parser accepts it before the extraction.
- I2. The lock, state, and activity paths must always use the same cache
  directory and filenames.
- I3. The sole production writer must always use the existing atomic JSON
  writer and emit the same versioned shape.
- I4. Reindex and semantic requesters must decide service usability from the
  same PID, project root, heartbeat, busy deadline, and nested protocol facts.
- I5. Runtime must remain the sole owner of start, stop, replacement, activity,
  lock, and process-control policy.
- I6. The extraction must add no wrapper call, filesystem operation, parse,
  timer, poll, process probe, or fallback attempt.
- I7. `platform` must depend only on its already allowed `domain` boundary.

## Premises

- P1. The index is fresh and TypeScript indexing, semantic evidence, diff-gate,
  and compiler verification are available. Source: `node dist/cli.js status
--capabilities --json`.
- P2. The architecture graph maps 342 of 342 files and reports one
  `reindex -> runtime` edge from `typescript-index-requester.ts` to
  `watch-service.ts` plus one `semantic -> runtime` edge from
  `remote-provider.ts` to the same file. Source: `node dist/cli.js architecture
--json`.
- P3. `readWatchServiceState` has three production reader groups: runtime
  inspection/stop logic, the TypeScript index requester, and the TypeScript
  semantic requester. Its producer is `parseWatchServiceState`. Source: `node
dist/cli.js refs readWatchServiceState --json`; `node dist/cli.js dataflow
readWatchServiceState --json`.
- P4. `writeWatchServiceState` has one production caller,
  `runtime/watch-server.ts`, and writes through `writeJsonAtomic`. Source:
  `node dist/cli.js refs writeWatchServiceState --json`; `node dist/cli.js code
writeWatchServiceState --json`.
- P5. `watchServicePaths` has consumers in runtime, reindex, and semantic and
  derives exactly three filenames from one cache directory. Source: `node
dist/cli.js refs watchServicePaths --json`; `node dist/cli.js code
watchServicePaths --json`.
- P6. The state parser validates the outer record, watcher status, refresh
  metadata, semantic status, and index status, returning `null` on any parse,
  read, or validation failure. Source: `node dist/cli.js code
parseWatchServiceState --json`; `node dist/cli.js code
readWatchServiceState --json`.
- P7. Nested protocol usability remains requester-owned: each requester checks
  its own protocol constant after the shared parser accepts a numeric nested
  protocol version. Source: `node dist/cli.js code usableServiceState --json`
  for `src/reindex/typescript-index-requester.ts` and
  `src/semantic/typescript/remote-provider.ts`.
- P8. Existing focused tests cover malformed state, lifecycle classification,
  process liveness, atomic writer use, index mailbox use, semantic mailbox use,
  and worktree watch integration. Tests are not indexed, so this inventory uses
  the narrow filesystem fallback. Source: `rg -n
"parseWatchServiceState|writeWatchServiceState|watchServicePaths"
tests`.

### State-authority premise

- P9. `runtime/watch-server.ts` is the complete production writer of
  `watch-state.json`. Readers are runtime inspection/stop logic,
  `reindex/typescript-index-requester.ts`, and
  `semantic/typescript/remote-provider.ts`. Path consumers additionally use
  the lock and activity paths but do not write the state record. Source: P3,
  P4, and P5.

## Current State

`runtime/watch-service.ts` mixes the stored record schema and parser with
process lifecycle orchestration (P3-P6). The two external clients need only
the former, but importing the mixed file creates both reverse architecture
edges (P2). The writer already belongs to runtime because the runtime watch
server authors the record and uses the shared atomic storage mechanism (P4,
P9).

## Reuse Audit

- Extract the existing constants, state/path types, path calculation, reader,
  parser, and validators intact into one named platform module. Do not add a
  second parser or a client-specific partial state shape (P5-P7).
- Model the two nested values as platform-owned persisted snapshots with the
  exact fields the existing parser validates. Their `protocolVersion` remains
  numeric because compatibility is deliberately decided by each client (P7).
- Keep `writeWatchServiceState` and every lifecycle function in runtime (P4,
  P9).
- Preserve the prior runtime import surface with compile-time re-exports, not
  forwarding functions. Internal production consumers import the platform
  owner directly.

## Testability Design

| Behavior          | Test seam                    | Dependencies       | Pure core                    | Side-effect shell               | Contract                |
| ----------------- | ---------------------------- | ------------------ | ---------------------------- | ------------------------------- | ----------------------- |
| State validation  | `parseWatchServiceState`     | None               | Existing guards              | None                            | Same value or `null`    |
| State reading     | `readWatchServiceState`      | Filesystem         | Parser above                 | One existing read/JSON parse    | Same state or `null`    |
| Path layout       | `watchServicePaths`          | None               | Existing joins               | None                            | Same three paths        |
| Atomic writing    | `writeWatchServiceState`     | Filesystem         | State type                   | Existing `writeJsonAtomic` call | Same stored bytes/shape |
| Client usability  | Existing requester tests     | Clock and PID seam | Existing client predicate    | Existing mailbox loop           | Same accept/fallback    |
| Runtime lifecycle | Existing watch-service tests | Injected runtime   | Existing classification/plan | Existing process shell          | Same action             |

## Implementation Checklist

### 1. Extract the persisted read contract

- [x] **Files**: new `src/platform/watch-service-state.ts`,
      `src/runtime/watch-service.ts`
- **Premises**: P3-P7, P9
- **Deployable**: no — part of the single-deploy import migration.
- **Change**: Move the five public constants, `WatchServiceState`,
  `WatchServicePaths`, path calculation, reader, parser, and all parser-only
  guards into platform without changing branches or literals. Export one
  timestamp guard for the remaining runtime activity/lock parsers. Keep the
  writer and lifecycle logic in runtime and re-export the established read
  surface directly for compatibility.
- **Testability**: The parser remains pure; the reader remains a one-read
  side-effect shell; no dependency injection or wrapper is added.
- **Validation**: Typecheck and focused state/lifecycle tests.

### 2. Reroute every direct consumer

- [x] **Files**: `src/reindex/typescript-index-requester.ts`,
      `src/semantic/typescript/remote-provider.ts`, runtime path consumers,
      `src/runtime/watch-server.ts`, focused tests
- **Premises**: P2, P3, P5, P8, P9
- **Deployable**: yes with step 1.
- **Change**: Import read-contract values and types directly from platform.
  Keep runtime writer/lifecycle imports pointed at runtime. Move the pure
  parser test to `tests/platform/watch-service-state.test.ts`; retain runtime
  lifecycle assertions under `tests/runtime`.
- **Testability**: Existing requester clock/PID seams and runtime fake remain
  unchanged.
- **Validation**: Watch-state, watch-service, TypeScript index mailbox,
  TypeScript semantic mailbox, runtime config, and worktree watch tests.

### 3. Reconcile the architecture ledger

- [x] **Files**: `docs/architecture/scip-query-target-architecture.md`
- **Premises**: P2
- **Deployable**: yes after architecture measurement.
- **Change**: Record the host-mechanism step complete only if both reverse
  edges disappear; update measured files, relationships, reciprocal pairs,
  and the next migration step from actual command output.
- **Validation**: Architecture, architecture drift, and doc drift.

### 4. Verify behavior and performance neutrality

- [x] **Files**: no production edit
- **Premises**: P1-P9
- **Deployable**: verification only.
- **Change**: Run focused and full tests, build, typecheck, lint, matching
  migration postchecks, reindex, architecture, drift, diff impact, and the
  architecture-aware diff gate. Inspect the extraction diff for unchanged
  literals, validation branches, and I/O count.
- **Validation**: Commands above; the full suite and final diff gate are the
  shipping oracles.

## Attack Record

### A1. I7 via upward type imports

- Attack: the new platform parser imports semantic and reindex status types,
  replacing two reverse edges with forbidden `platform -> semantic/reindex`
  edges.
- Outcome: HOLE — repaired by step 1: the persisted snapshot shapes live with
  the platform state record and keep requester compatibility checks in their
  owning clients (P6, P7).

### A2. I1 via a partial client parser

- Attack: a malformed nested index status passes a new client-specific parser,
  so reindex accepts a state runtime previously rejected.
- Outcome: HOLE — repaired by step 1: move the complete parser and every
  parser-only guard as one unit (P6).

### A3. I3 via moving the writer below runtime

- Attack: the extraction replaces `writeJsonAtomic` with a direct write or
  gives platform an undeclared storage dependency.
- Outcome: HELD — step 1 leaves the sole writer in runtime unchanged (P4,
  P9).

### A4. I2 via changed filenames

- Attack: a requester looks for a renamed or differently joined state file and
  silently falls back to local work.
- Outcome: HELD — step 1 moves the three literals and existing join function
  intact; focused mailbox tests exercise the result (P5, P8).

### A5. I4 via weakened nested compatibility

- Attack: the shared parser begins enforcing the current nested protocol
  version, rejecting an otherwise valid outer record before the owning client
  can decide compatibility.
- Outcome: HELD — snapshot protocol versions remain numeric and requester
  predicates retain their exact constant comparisons (P6, P7).

### A6. I5 via lifecycle leakage

- Attack: start/stop/classification logic moves into platform merely because it
  consumes the state type, turning platform into delivery policy.
- Outcome: HELD — step 1 lists the exact read-contract symbols to move and
  keeps every lifecycle operation in runtime (P3, P9).

### A7. I6 via compatibility wrappers

- Attack: runtime forwarding functions add a call to every state read or path
  lookup.
- Outcome: HELD — step 1 permits only compile-time re-exports; all internal
  consumers import platform directly (P3, P5).

### A8. I1 via invalid JSON and filesystem failure

- Attack: a missing, unreadable, or malformed state file throws after the move
  instead of returning `null`.
- Outcome: HELD — the reader's existing `try/catch`, JSON parse, and pure
  parser move together; focused tests and a new read probe cover failure (P6,
  P8).

### A9. Completion claim with surviving reverse imports

- Attack: tests pass while one type-only or test-adjacent production import
  still points at runtime, leaving a reciprocal pair.
- Outcome: HELD — step 2 updates all production consumers from P3/P5 and step
  3 requires measured absence from the architecture graph (P2, P3, P5).

## Coverage Matrix

| Surface or lens            | Attacks        |
| -------------------------- | -------------- |
| State writer: watch server | A3             |
| Runtime readers            | A4, A6, A8     |
| Reindex readers            | A2, A4, A5, A9 |
| Semantic readers           | A2, A4, A5, A9 |
| Path-only consumers        | A4, A9         |
| Valid intermediate state   | A1, A9         |
| Failure behavior           | A2, A8         |
| Boundaries                 | A1, A6, A9     |
| Data integrity             | A2-A5, A8      |
| Efficiency                 | A7             |
| Reuse                      | A2, A7         |
| Testability                | A2, A4, A8     |

## Execution and Ship Order

Steps 1-2 form one import-migration group. Step 3 records only measured graph
facts. Step 4 must pass before handoff. The change has no persistent data
migration and is reversible by restoring the extracted block and imports.

## Implementation Results

- The complete persisted-state schema, path calculation, reader, parser, and
  parser-only guards now live in `platform/watch-service-state.ts`.
- Runtime retains the atomic writer, activity and lock mutation, process
  lifecycle, classification, and command policy. Its old read-side exports are
  direct compile-time re-exports rather than forwarding calls.
- Reindex and semantic production code no longer import runtime. The measured
  graph maps 343 of 343 files, has 58 cross-boundary relationships, reports
  zero forbidden relationships, and contains two reciprocal pairs in one
  five-boundary connected group.
- Build, declarations, typecheck, formatting, lint, all focused suites, and all
  1,410 tests pass. The compiler-verified cleanup plan reports no residue.
- `incomplete-migration`, scoped `recent-duplicates`, `co-change`, `doc-drift`,
  `wrapper-candidates`, `passthrough-candidates`, and
  `redundant-reexports` report no actionable findings. Similarity output is
  limited to trivial local validators and does not justify a new shared
  dependency.
- The final unchanged-input reindex reuses the existing TypeScript and Rust
  index in 0.4 seconds. The architecture-aware diff gate exits 0 with no
  advisory findings.
- The broader health baseline remains intentionally unchanged: it reports 106
  unratcheted findings across the accumulated working-tree feature. The two
  signals introduced by this slice are accepted design evidence, not cleanup
  defects: `WatchServicePaths` preserves the established public contract, and
  the exported timestamp guard keeps runtime activity/lock validation
  identical to persisted-state validation without duplicating the predicate.

## Verdict

A plan is `PLANNED-COMPLETE` iff every coverage row names an attack, every
attack ends in a cited held outcome or recorded hole, and no premise fails
reverification.

Result: **PLANNED-COMPLETE** — 9 attacks, 2 holes repaired, 0 holes accepted.

## File Summary

- Add `src/platform/watch-service-state.ts`.
- Add `tests/platform/watch-service-state.test.ts`.
- Edit runtime, reindex, semantic, and focused test imports.
- Edit the target architecture ledger after measurement.
- Delete no behavior and add no runtime forwarding function.
