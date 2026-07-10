# Dead TypeScript Mailbox Batching

Date: 2026-07-10
Mode: QUICK optimization
Status: Complete

## Goal

Make `scip-query dead --json --full` use the existing bulk semantic-reference
route before synchronous TypeScript mailbox round trips dominate runtime. Done
means the persistent-service command is materially faster, same-revision
service/direct JSON is byte-identical, pre-edit classifications remain stable,
the direct-provider path does not regress materially, and small/non-semantic
projects keep their current path.

## Current State

- **Source:** `scip-query status --capabilities`; the index is fresh and both
  TypeScript and Rust semantic providers are available.
- **Source:** `scip-query plan-context dead --json`, `scip-query trace dead`,
  and `scip-query code supplementReferencesFromCallerMap`; `dead()` narrows to
  caller candidates and then selects either a per-symbol caller loop or the
  existing bulk mention/semantic route.
- **Source:** `scip-query code 'src/queries/cleanup/dead.ts:1-95'`; bulk mode
  currently requires at least 3,000 definitions and 1,000 indexed files.
- **Source:** the completed work-identity run history; this corpus stayed below
  both thresholds, issued 2,077 synchronous semantic-service requests, and took
  25,765ms versus 3,216ms through the direct provider with identical output.
- **Source:** the live-service profile; 2,076
  `typescript.references-map.file` spans totaled 3,927ms inside a 29,505ms
  caller-map stage. The dominant excess is the repeated mailbox boundary, not
  TypeScript reference computation.
- **Source:** `scip-query code semanticCallerMap` and `scip-query code
  semanticReferenceMap`; the existing batch product groups definitions by
  provider and invokes `referencesForDefinitions()` once per provider. No new
  service request or response schema is required.
- **Source:** `docs/plans/2026-06-27-cli-performance-pass.md`; the adaptive split
  was introduced when this repository's small direct-provider path was about
  0.15s faster, while the bulk path improved Vega by roughly 3.6x. The new
  default persistent service changes that crossover because every scalar call
  now crosses a polled filesystem mailbox.

## Reuse Audit

- Reuse `callerRowsForSymbol(..., { semantic: false })` for the exact resolved
  reference evidence already used by the scalar path.
- Reuse the provider's `referencesForDefinitions()` transport, with an exact
  option that keeps precise per-definition lookup inside one service request.
- Keep `callerRowsForSymbol()` as the small/non-semantic fallback.
- Do not add a mailbox request kind, cache schema, command option, or
  environment flag. The TypeScript mailbox protocol version advances because
  older daemons do not understand the exact-batch option.

## Testability Design

| Behavior | Test seam | Dependencies | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Medium candidate sets select batched caller work | profile span names from real `dead --full` | indexed DB and profiler | existing threshold comparison | SQLite, semantic provider, profile JSONL | `dead.caller-map.per-symbol-non-semantic` appears and `dead.caller-map.per-symbol` does not |
| Mailbox calls collapse | watch-service status before/after | project watcher and mailbox | request count subtraction | watcher process and request files | one bulk request or a small bounded count, not one request per definition |
| Detector output stays identical | CLI stdout bytes, SHA-256, and structured pre-edit diff | current index | existing dead classification | CLI rendering | same-revision modes are byte-identical; pre-edit category/symbol membership is unchanged |
| Direct fallback remains acceptable | `SCIP_QUERY_SKIP_WATCH_SERVICE=1` CLI run | direct ts-morph provider | same caller-file recording | in-process TypeScript project | no material regression and identical output |

## Design Phases

### 1. Recalibrate the existing adaptive crossover

- [x] **File:** `src/queries/cleanup/dead.ts:85-86`
- **Source:** `scip-query code 'src/queries/cleanup/dead.ts:1-95'` and the
  2,077-request live profile.
- **What:** The current 3,000-definition / 1,000-file gate leaves a medium
  TypeScript repository on the scalar mailbox path.
- **Change:** Lower the conservative crossover to 1,000 definitions and 300
  indexed files. Above that crossover, retain scalar resolved-reference
  attribution without semantic calls and issue one exact TypeScript reference
  batch for the remaining candidates. This admits the measured 2,075/325
  workload while leaving the historical tiny-project path unchanged.
- **Testability:** Use the real profile span/request-count seams above; no new
  production test hook or option is added.
- **Validation:** focused dead and TypeScript semantic tests, profiled service
  command, direct-provider control, output SHA-256 comparison.
- **Why:** At 1,000 scalar requests, the requester's 5ms polling interval alone
  creates an approximately 5s lower bound. That is already much larger than the
  historical small-repo bulk overhead, while the two-dimensional gate limits
  the behavior change to medium/large indexed projects.

### 2. Preserve exact scalar semantics

- [x] **Files:** `src/semantic/types.ts`, `src/semantic/shared-primitives.ts`,
  and `src/semantic/typescript/{remote-provider,session-protocol,session-service,ts-morph-provider}.ts`
- **Source:** the first threshold-only run took 2,550ms but changed four symbol
  classifications because the existing fragment/inverted-scan bulk product is
  intentionally approximate.
- **Change:** Add an exact batch option. The requester sends one batch; the
  daemon performs the same precise reference lookup used by scalar calls. The
  direct fallback honors the same option. Advance the mailbox protocol to 2 so
  a new client cannot silently use an older approximate daemon.
- **Validation:** mailbox forwarding unit test, exact caller-map fixture, and a
  reconstructed pre-edit structured diff.
- **Why:** batching the process boundary is safe only when it preserves the
  detector's evidence contract.

### 3. Accept or reject from measured controls

- [x] **File:** `docs/benchmarks/runs/2026-07-10-dead-typescript-mailbox-batching.jsonl`
- **Source:** pre-edit and post-edit CLI/profile/status runs.
- **Change:** Record persistent-service cold/warm timing, service request count,
  profile spans, direct-provider timing, bytes, and SHA-256.
- **Validation:** accepted: final cold service fell from 30,035ms to 3,650ms; warm
  service is 1,010ms; TypeScript service requests fell from 2,075 to 2; direct
  control is 3,390ms. All same-revision outputs are byte-identical. Relative to
  the reconstructed pre-edit source, total/dead/file-internal symbol counts are
  unchanged; only source line ranges and LOC moved with the implementation.
- **Why:** Threshold calibration is reversible; output or cross-mode regression
  rejects the edit without requiring a compatibility migration.

### 4. Run repository verification

- [x] **Files:** changed source, tests selected by the edit, campaign ledger,
  and this plan.
- **Source:** `scip-query change-surface src/queries/cleanup/dead.ts --json
  --full`; `dead()` has six external consumers and medium risk.
- **Change:** Run typecheck, focused tests, full tests/lint/build, routed
  postchecks, `scip-query reindex`, and `scip-query diff-gate --json`.
- **Validation:** all checks pass or every accepted advisory has a recorded
  reason.

## Verification Result

- 1,249 tests across 181 files passed.
- Lint, Prettier, typecheck, build, and compiler-verified cleanup passed.
- Focused exact-caller and mailbox tests passed (14 tests across three files).
- Fresh reindex reused both valid TypeScript and Rust shards in 746ms.
- Diff gate passed with zero blocking findings. The remaining advisories are
  intentional twins (TypeScript semantic versus TypeScript indexing/Rust
  transport), an unchanged README configuration example, and an unchanged
  cache-invalidation ownership table.
- Baseline health remains an independent stale repository baseline: it reported
  167 deltas and one fixed finding. This change does not rewrite or ratchet
  that baseline.

## Stress-Test Findings

- `DeadSummary` observes caller file presence, not the enclosing caller symbol or
  exact reference line. Both current routes feed the same
  `recordReferenceAtLeast(..., callerFile, 1, 'caller-map')` effect.
- The bulk branch still applies ignored-file, inactive-barrel, same-file, and
  test-file filters through the existing `recordCallerFile()` closure.
- Service failure remains safe because the service-backed provider already
  falls back to the direct provider; no protocol or retry behavior changes.
- Direct mode must be timed because the older adaptive gate existed to protect
  small in-process workloads. The 1,000/300 crossover intentionally does not
  change those tiny fixtures.
- Semantic caches and persisted index schemas do not change. Rollback is the
  two constant values.

## Ship Order

1. Record the current-commit service baseline.
2. Change only the two adaptive thresholds.
3. Run focused correctness checks.
4. Restart the project watcher and measure cold/warm service behavior.
5. Measure direct-provider behavior and compare exact output.
6. Keep or revert, then verify and update the roadmap.

## Files

- Create: this plan and one JSONL run history.
- Edit if accepted: `src/queries/cleanup/dead.ts`, this plan, the run history,
  and the indexing-analysis campaign ledger.
- Delete: none.
