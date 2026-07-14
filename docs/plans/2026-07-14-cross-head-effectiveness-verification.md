# Cross-HEAD effectiveness verification

Date: 2026-07-14

## Goal

Count a committed repair as a verified scip-query fix when the detector no longer reports the finding over the same original Git comparison after `HEAD` advances. Do not treat an empty diff after a commit as proof. Preserve the original comparison commit, replay the applicable detector checks on a clean worktree, retain unresolved findings when replay is unavailable, and keep legacy events readable without retroactively inventing evidence.

## Current State

- `recordDiffGateOutcomes()` converts the current gate findings into a local outcome ledger and append-only repository events, but records only the current `HEAD`; the result's actual comparison base is discarded. Source: `scip-query trace recordDiffGateOutcomes --json --full` and `src/runtime/diff-gate-outcomes.ts:29-66`.
- `computeEffectiveness()` calls a resolution fixed only when the caught/reopened event and resolved event have the same non-null `commit`. A changed `HEAD` is therefore always `unverified`, even when the same original comparison could prove the committed repair. Source: `scip-query plan-context computeEffectiveness --full --json` and `src/queries/health/effectiveness.ts:59-157`.
- `diffGate()` already accepts an arbitrary `base`, and both the CLI and Stop-hook callers own the complete option set needed to repeat the same check over a stored base. Source: `scip-query code diffGate`, `src/runtime/query-commands/impact.ts:209-242`, and `src/runtime/agent-hooks.ts:548-568`.
- Outcome events are append-only repository facts and already tolerate additive optional fields plus legacy JSONL migration. Source: `scip-query refs OutcomeEvent`, `src/storage/outcome-events.ts:33-237`, and `tests/storage/outcome-events.test.ts`.

## Reuse Audit

- Extend `OutcomeEvent` rather than create another ledger: it is already the shared repository history read by `effectiveness` and written by every gate path.
- Extend `recordDiffGateOutcomes()` through injected Git/replay dependencies rather than add a second recorder: it is the only production boundary that sees the prior local state, current gate result, current commit, and database together.
- Extend the existing lifecycle-anchor calculation used by `computeEffectiveness()` rather than create a second definition of a finding lifecycle. The reusable anchor helper belongs with outcome-event history because both recording and reporting need it.
- Reuse `diffGate(db, { ...originalOptions, base })` at the CLI and Stop-hook call sites. A new detector or historical indexer is not justified; the existing gate is the behavior that must be replayed.
- No new module, command, option, or configuration field is required.

## Testability Design

| Behavior | Test seam | Dependencies to inject | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Persist the actual comparison identity | `deriveOutcomeEvents()` and outcome-event storage tests | resolved Git ref | additive event construction and validation | JSON event writer/reader | caught, reopened, and resolved events retain the resolved comparison commit when known |
| Verify a repair after `HEAD` advances | `recordDiffGateOutcomes()` | clock, current commit, base resolver, clean-state probe, event reader, gate replay | candidate/anchor/replay classification | Git probes, SQLite ledger write, repository event append | a missing finding is fixed only if the same comparison base is reused or a clean replay against the stored base also misses it |
| Keep a committed defect open | `recordDiffGateOutcomes()` | replay returning the original finding | replay reconciliation | same boundary | an empty default diff cannot resolve a finding that still appears in the stored-base replay |
| Avoid dirty-worktree false attribution | `recordDiffGateOutcomes()` | clean-state probe returning false | verification eligibility decision | Git status | cross-HEAD resolution stays pending until a clean comparable replay is possible |
| Report committed verified fixes | `computeEffectiveness()` | event arrays only | terminal lifecycle classification | command rendering | matching stored comparison bases or explicit replay proof count as fixed; legacy cross-HEAD events remain unverified |

## Design Phases

### 1.1 - Make outcome events comparison-aware

- [x] **Files**: `src/storage/outcome-events.ts:33-237`, `tests/storage/outcome-events.test.ts`
- **Source**: `scip-query refs OutcomeEvent --json` and `scip-query trace deriveOutcomeEvents --json --full`.
- **What**: events persist the observation commit but not the resolved diff base, so later readers cannot decide whether two observations analyzed the same change.
- **Change**: add optional `comparisonBaseCommit` and `verifiedAgainstCommit` evidence, resolve arbitrary Git refs, expose a clean-worktree probe, preserve proof during event deduplication, and keep old event files valid.
- **Testability**:
  - Test seam: `deriveOutcomeEvents()`, `readOutcomeEvents()`, and Git fixture tests.
  - Injected dependencies: commit/base strings and temporary Git repositories.
  - Pure core: event construction, parsing, validation, and proof-preserving dedupe.
  - Side-effect shell: `git rev-parse`, `git status`, and event-file I/O.
  - Contract: optional evidence is additive; malformed proof fields are rejected; a verified duplicate wins over an otherwise identical unverified event.
- **Validation**: `npx vitest run tests/storage/outcome-events.test.ts`.
- **Why**: durable comparison identity is the prerequisite for proving cross-commit outcomes without weakening legacy compatibility.

### 1.2 - Replay the stored comparison before resolving

- [x] **Files**: `src/runtime/diff-gate-outcomes.ts:1-66`, `src/runtime/query-commands/impact.ts:209-242`, `src/runtime/agent-hooks.ts:548-568`, `tests/runtime/diff-gate-outcomes.test.ts`
- **Source**: `scip-query trace recordDiffGateOutcomes --json --full`, `scip-query refs recordDiffGateOutcomes --json`, and `scip-query code diffGate`.
- **What**: missing current findings are immediately resolved by the local ledger even when a commit merely made the default diff empty.
- **Change**: resolve the gate's comparison base, inspect the last caught/reopened event, and when bases differ replay the same gate options against the stored commit. Carry an exact still-present finding, preserve rename/move evidence by symbol, attach replay proof when absent, and leave the prior outcome pending when the worktree is dirty or replay cannot run the check.
- **Testability**:
  - Test seam: `recordDiffGateOutcomes()`.
  - Injected dependencies: clock, `HEAD`, base resolver, worktree cleanliness, prior event reader, gate replay, event appender.
  - Pure core: anchor grouping and reconciliation of current/replayed findings.
  - Side-effect shell: the two gate call sites provide a callback that reuses their original options with a substituted base.
  - Contract: verification never changes the user-facing gate result or exit code; recordkeeping/replay failure cannot fail the gate.
- **Validation**: focused tests for same-base commits, committed defects, committed fixes, dirty deferral, unavailable bases, and moved findings.
- **Why**: recording time is the only point where the current index and clean committed worktree can reproduce the original comparison cheaply and faithfully.

### 1.3 - Report comparison-verified fixes and update guidance

- [x] **Files**: `src/queries/health/effectiveness.ts:1-157`, `src/runtime/commands/command-handlers.ts:1010-1085`, `src/runtime/commands/command-descriptors.ts:257-266`, `tests/queries/effectiveness.test.ts`, `README.md:245-257`, `CHANGELOG.md:59-61`, `docs/COMMAND_REFERENCE.md:140`, `skills/_shared/SKILL.md:186-210`, `skills/scip-verify/SKILL.md:90`, `skills/scip-calibrate/SKILL.md:121-125`
- **Source**: `scip-query plan-context computeEffectiveness --full --json` and `rg -n "same-HEAD|unverified" README.md CHANGELOG.md docs skills src tests`.
- **What**: output and guidance define verification exclusively as a same-`HEAD` rerun.
- **Change**: define a verified fix as disappearance under the same resolved comparison base, either directly or through stored replay proof. Explain that legacy cross-HEAD resolutions remain unverified because no historical replay fact exists.
- **Testability**:
  - Test seam: `computeEffectiveness()` and command rendering tests.
  - Injected dependencies: event arrays.
  - Pure core: lifecycle classification and aggregate arithmetic.
  - Side-effect shell: existing CLI rendering only.
  - Contract: `fixed`, `unverified`, precision, and median-time fields remain stable; only stronger evidence can move an outcome from unverified/open to fixed.
- **Validation**: `npx vitest run tests/queries/effectiveness.test.ts tests/runtime/diff-gate-outcomes.test.ts` plus documentation link/format checks.
- **Why**: the reported metric must describe the new proof rule exactly and must not rewrite historical evidence.

## Stress-Test Findings

- **Dirty worktrees**: replaying `base → working tree` could credit an uncommitted fix to the current commit. Cross-base verification therefore waits for a clean worktree.
- **Moving refs**: `origin/main` and branch names can advance. Events store the resolved commit, not the ref spelling.
- **Custom bases**: repeated `--base origin/main` runs can be directly comparable even when `HEAD` changes; equal stored base commits verify without redundant replay.
- **Shallow clones/missing objects**: failure to resolve or replay the stored base leaves the finding pending; it does not manufacture a fix.
- **Renames**: a replayed finding with the same check and symbol but a new id remains a move, not a fix.
- **Concurrency/branches**: additive event files remain conflict-resistant. Deduplication prefers the copy carrying verification proof.
- **Legacy history**: old events lack comparison identities. Same-commit fallback remains valid; old cross-commit disappearances stay unverified.
- **Gate reliability**: verification is best-effort recordkeeping and cannot alter findings, blocking status, or process exit.

## Execution and Ship Order

1. Extend the additive event schema and its tests; deployable because readers accept old and new records.
2. Add recording-time replay and call-site callbacks; deployable because failures retain prior outcomes and never fail the gate.
3. Update effectiveness classification, rendering language, documentation, and skill guidance.
4. Run focused tests, the full suite, typecheck/lint/build, event/effectiveness smoke checks, `scip-query reindex`, and `scip-query diff-gate --json`.

The only durable public interpretation change is additive proof: future committed repairs can be verified. Historical events are not rewritten.

## File Summary

- **Create**: this plan only.
- **Edit**: outcome-event storage, diff-gate outcome recording, both gate call sites, effectiveness calculation/rendering, focused tests, README/changelog/command reference/shared skill guidance.
- **Delete**: none.
- **Verify**: event compatibility, replay decisions, outcome arithmetic, CLI text, full repository checks, reindex, and diff gate.
