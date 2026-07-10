# Automatic Indexing Setup Integration

Date: 2026-07-10
Status: Complete
Parent: [`2026-07-09-automatic-incremental-indexing-roadmap.md`](./2026-07-09-automatic-incremental-indexing-roadmap.md)

Follow-up: [`2026-07-10-setup-scope-and-outcome-records.md`](./2026-07-10-setup-scope-and-outcome-records.md) closes setup ownership, local-hook, and effectiveness-record integrity gaps discovered after this lifecycle slice.

## Goal

Make the completed demand-started indexing lifecycle the normal outcome of an
explicit `scip-query setup` or `scip-query init`, while preserving an existing
explicit `watch.enabled: false` and offering a guided opt-out. Setup must prove
that the project service can start or be reused, expose its idle policy, and
report the selected Rust semantic transport plus worker fallback.

## Pre-Change State

- `DEFAULT_WATCH` and `initProjectConfig` set `enabled: false`, so a
  new config disables the automatic service. Source:
  `scip-query code 'src/runtime/config.ts:7-20' --json` and
  `scip-query code initProjectConfig --json`.
- `runProjectSetup` reports the watch policy from `resolveWatchConfig`, but its
  status depends only on `autoRefresh`; it neither enables nor starts the
  service. Source: `scip-query code runProjectSetup --json` and
  `scip-query code 'src/runtime/project-setup.ts:240-285' --json`.
- `buildSetupSmokeTests` marks watch refresh from that policy step rather than
  an observed service result. Source:
  `scip-query code buildSetupSmokeTests --json`.
- Normal commands start the service only when `config.watch.enabled === true`.
  Source: `scip-query code ensureWatchServiceForCommand --json`.
- Rust semantic selection already defaults to durable, retains worker fallback,
  and exposes a read-only status function. Source:
  `scip-query code rustSemanticSessionSelection --json` and
  `scip-query code rustSemanticSessionStatus --json`.

## Reuse Audit

- Reuse `resolveWatchConfig` for effective defaults, `ensureWatchService` for
  the real start/reuse lifecycle, and `rustSemanticSessionStatus` for Rust
  diagnostics. No parallel lifecycle implementation is justified.
- Extend `initProjectConfig` for newly initialized projects. It cannot update
  an existing config because it returns immediately when the file exists;
  setup therefore needs one small config persistence function that preserves
  unrelated fields and changes only `watch.enabled`/the default refresh value.
  Source: `scip-query code initProjectConfig --json` and
  `scip-query refs initProjectConfig --json`.
- Extend the existing pure `planGuidedProjectSetup` action list rather than add
  a separate prompt system. Source:
  `scip-query code planGuidedProjectSetup --json`.

## Testability Design

| Behavior | Test seam | Dependencies | Deterministic decision | Side-effect boundary | Contract |
| --- | --- | --- | --- | --- | --- |
| Persist setup opt-in | `configureProjectAutomaticRefresh` | filesystem | preserve all config fields; change only watch selection | `.scipquery.json` write | missing decision becomes enabled; explicit false remains unless guided setup selects enable |
| Guided opt-out | `planGuidedProjectSetup` and `guidedProjectSetupOptions` | prompt selection | add one recommended action only when disabled | existing readline prompt | declining the action passes `automaticRefresh: false` |
| Service lifecycle smoke | `runProjectSetup` | mocked `ensureWatchService` | enabled/disabled/failure step classification | demand-started helper process | enabled setup returns observed started/reused state and idle policy |
| Rust transport smoke | existing `rustSemanticSessionStatus` | environment and state file | classify durable/worker and valid/invalid selection | read-only helper state lookup | Rust projects report transport, state, worker fallback, and opt-out |

## Implementation Phases

### 1. Persist the setup decision

- [x] **File**: `src/runtime/config.ts:7-20,542-563`
- **Source**: `scip-query code 'src/runtime/config.ts:7-20' --json`; `scip-query code initProjectConfig --json`
- **Change**: make `init` produce an enabled demand-started watch config and
  add a preservation-oriented setup writer for missing or changed watch
  selection.
- **Testability**: exercise new/missing, existing-disabled, existing-enabled,
  and unrelated-field preservation with temporary project directories.
- **Validation**: focused runtime config tests and `scip-query co-change src/runtime/config.ts --json`.

### 2. Wire guided consent and real lifecycle observations

- [x] **Files**: `src/runtime/project-setup.ts:107-208,211-460,515-618`; `src/runtime/commands/command-handlers.ts:1119-1170`
- **Source**: `scip-query plan-context src/runtime/project-setup.ts --json`; `scip-query code guidedProjectSetupOptions --json`
- **Change**: add the recommended guided action, preserve explicit non-guided
  false, enable missing decisions, start/reuse the service after indexing, and
  record Rust selection through a passive status read after health so the
  final live/asleep state is truthful.
- **Testability**: reuse `runProjectSetup` module mocks for deterministic
  service results and the pure guided-plan assertions for consent behavior.
- **Validation**: `tests/runtime/project-setup.test.ts`, runtime configuration
  tests, and command-contract tests.

### 3. Make setup smoke evidence truthful

- [x] **File**: `src/runtime/project-setup.ts:515-618`
- **Source**: `scip-query code buildSetupSmokeTests --json`
- **Change**: derive automatic-indexing evidence from the observed service
  result/configured idle policy and Rust evidence from the existing status
  record; disabled/unsupported states are unavailable rather than false passes.
- **Testability**: assert started, reused, disabled, service failure, default
  durable, explicit worker, and invalid environment outcomes.
- **Validation**: focused setup tests plus a packed-project setup/status smoke.

### 4. Close documentation and package behavior

- [x] **Files**: `README.md`, `docs/COMMAND_REFERENCE.md`, roadmap and benchmark ledger
- **Source**: `scip-query co-change src/runtime/project-setup.ts --json`; generated command descriptor checks
- **Change**: document demand start, ten-minute clean-idle exit, guided opt-out,
  Rust sleep/wake behavior, and setup verification evidence; mark this closure
  complete in the parent roadmap.
- **Validation**: lint/docs generation check, package dry-run/install, setup and
  status in an isolated fixture, then full repository verification.

## Stress-Test Findings

- Existing explicit `watch.enabled: false` is user intent and must not be
  silently overwritten by ordinary non-guided setup.
- A missing watch decision is not an opt-out; explicit setup may safely persist
  the recommended enabled state.
- Setup should start the project service only after the index is refreshed, so
  it observes a current generation and does not race the setup reindex.
- The service's configured positive idle timeout plus its live state proves it
  is eligible to sleep; setup will not block for ten minutes to observe exit.
- Rust setup verification is read-only. A semantic request remains the event
  that wakes rust-analyzer, preserving demand-start behavior.
- Invalid config, service startup failure, or invalid Rust transport selection
  must be visible in the setup verdict rather than converted into a pass.
- Git-backed language discovery must ignore dependency directories just like
  its filesystem fallback. A packed fixture without `.gitignore` exposed
  untracked `node_modules` files as false Python and C/C++ project languages;
  segment filtering now applies the existing ignored-directory policy to both
  discovery paths.
- Indexers may create source-identity inputs such as `Cargo.lock` during a cold
  refresh. Setup rechecks freshness and permits one bounded settling refresh
  when the first successful pass is stale; it fails truthfully if the second
  pass is still stale.

## Delivered Outcome

- `scip-query init` creates an enabled demand-started watch policy. Explicit
  setup enables a missing policy while ordinary non-guided setup preserves an
  existing `watch.enabled: false` opt-out.
- Guided setup offers automatic refresh as a recommended selectable action.
- Setup starts or reuses the real project service only after indexing and
  reports its PID, watcher state, automatic-refresh policy, Git poll interval,
  and clean-idle deadline.
- Rust projects report the selected durable or worker semantic transport,
  final live/asleep state, worker fallback, and opt-out. The status read is
  passive; the existing health audit may make the semantic request that wakes
  rust-analyzer.
- Smoke evidence is derived from observed freshness and lifecycle state. Stale
  indexes, invalid config, failed config persistence, service startup failure,
  missing idle policy, and invalid Rust selection all block setup.

## Verification Evidence

- Focused tests cover config preservation, guided consent, start/reuse and
  failure paths, idle-policy evidence, Rust selection, stale settling, and
  dependency-directory language filtering.
- A packed `0.15.0` install (333 files, 824,195 bytes, SHA-256
  `6d9673689152e891362986147572c48ca20317b426612fab1855e25918674a45`)
  cold-indexed an isolated TypeScript/Rust repository from no database, Rust
  build output, or lockfile. It detected only `typescript` and `rust`, rebuilt
  both shards in 2,627ms, finished `fresh`, started the automatic service with
  a ten-minute clean-idle deadline, and reported Rust `durable/live` with
  worker fallback after health made a semantic request. It produced 12
  passing, one intentionally unavailable, and zero failed setup smoke checks.
  The unavailable check was the deliberately skipped project-hook installation
  under `--no-hooks`.
- A packed explicit-opt-out control preserved `watch.enabled: false`, did not
  start the service, and labeled automatic refresh unavailable rather than
  passing it decoratively.
- Final repository acceptance passed 1,231 tests across 177 files, lint,
  typecheck, build, generated command docs, a fresh TypeScript/Rust reindex,
  and diff-gate with zero findings or advisories. `health --baseline` was also
  run; its committed baseline predates the wider indexing campaign and reports
  165 repository-wide deltas, so this setup-only closure does not rewrite it.

## Ship Order

1. Config persistence and tests.
2. Guided selection and lifecycle/Rust observations.
3. Truthful smoke tests and failure controls.
4. Documentation, packed fixture, full checks, reindex, diff-gate, commit.

Every step is reversible through `watch.enabled: false`; Rust retains
`SCIP_RUST_SEMANTIC_DURABLE_SESSION=0` and automatic worker failover.

## File Summary

- Create: this executable closure plan and any isolated fixture output only in
  temporary storage.
- Edit: runtime config/setup/handler code, their focused tests, command docs,
  roadmap, and benchmark ledger.
- Delete: no product files.
- Verify: focused setup/config/watch/Rust suites, full tests, typecheck, lint,
  build, package smoke, `scip-query reindex`, and `scip-query diff-gate`.
