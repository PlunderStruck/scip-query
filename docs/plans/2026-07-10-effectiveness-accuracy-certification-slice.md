# Effectiveness Integrity and Accuracy Certification Slice

Date: 2026-07-10
Status: Complete
Parent: [`Accuracy Hardening and Health Certification Roadmap`](../accuracy-hardening-goal.md)

## Goal

Make effectiveness record the findings that normal agent verification actually
shows, prevent a changed Git HEAD from being misreported as a confirmed fix,
repair Vega_2.0's checkout-local hook setup, and begin the health
certification roadmap with a reproducible TypeScript dead-code calibration
packet.

Done means ordinary and hook-mode diff-gate executions share one outcome
recorder, effectiveness separates verified fixes from unverified
disappearances, Vega has local hooks without tracked hook files, and the
calibration harness can generate deterministic review rows plus certification
statistics from real repositories.

## Current State

- `handleDiffGate` records outcomes only after the normal JSON early return;
  therefore `diff-gate --json` does not update either outcome store. Source:
  `scip-query code 'src/runtime/query-commands/impact.ts:220-255' --json`.
- Both legacy hook mode and `runStopHookDiffGate` reuse
  `recordDiffGateOutcomes`, which updates the SQLite working ledger and appends
  repository events. Source: `scip-query trace recordDiffGateOutcomes --json`;
  `scip-query code runStopHookDiffGate --json`.
- `recordFindingOutcomes` marks a prior row resolved whenever the same check ran
  and its ID was absent. It does not consider the Git commit. Source:
  `scip-query code recordFindingOutcomes --json`.
- `computeEffectiveness` treats every terminal resolved event as fixed except a
  narrow same-symbol/same-commit move classification. Source:
  `scip-query code computeEffectiveness --json`;
  `scip-query code movedFindingKeys --json`.
- Outcome events already carry the HEAD commit at observation time and use a
  committed JSONL stream with union merge and read-side deduplication. Source:
  `scip-query code deriveOutcomeEvents --json`;
  `scip-query code appendOutcomeEvents --json`;
  `scip-query code readOutcomeEvents --json`.
- `scripts/accuracy-calibration.mjs` is not in the SCIP index. Direct inspection
  shows that it currently runs source-backed navigation checks for three known
  symbols and records performance metadata; it does not sample or classify
  health findings.
- Live Vega_2.0 evidence on 2026-07-10 showed `effectiveness --json` with zero
  events, no `.scipquery/ledger/events.jsonl`, no local scip-query hook groups,
  and 41 tracked suppression JSON records. Its existing Claude local settings
  contain an unrelated Impeccable hook that setup must preserve.

## Reuse Audit

- Reuse `recordDiffGateOutcomes` as the only outcome-recording orchestrator.
  Its consumers are the impact command and Stop-hook path; moving its call
  before output branching is sufficient and avoids a second recorder. Source:
  `scip-query refs recordDiffGateOutcomes --json`.
- Reuse `OutcomeEvent.commit` to judge whether caught and resolved observations
  are comparable. Do not add a second Git fingerprint field in this slice;
  same-HEAD verification is conservative and directly supported by stored
  data. Source: `scip-query change-surface src/storage/outcome-events.ts --json --full`.
- Extend `CheckEffectiveness` with an unverified count rather than adding a new
  report type. Its only production consumer is the effectiveness command
  handler. Source: `scip-query refs computeEffectiveness --json`;
  `scip-query change-surface src/queries/health/effectiveness.ts --json --full`.
- Extend the existing accuracy script as the process/filesystem shell. A new
  `scripts/accuracy-calibration-core.mjs` is justified because deterministic
  sampling, Wilson intervals, verdict aggregation, and certification decisions
  are pure policy that must be unit-testable without indexing external repos.
- Preserve the existing JSONL event stream. One-event-per-file is not required
  for correctness in this slice because union merge plus deduplication already
  gives idempotent event facts; changing storage would add migration risk before
  the observation semantics are trustworthy.

## Testability Design

| Behavior                                    | Test seam                                                          | Dependencies to inject                   | Pure core                                               | Side-effect shell                                    | Contract                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Record normal diff-gate observations        | `handleDiffGate` command test and `recordDiffGateOutcomes` fixture | DB, clock, Git HEAD, append function     | existing ledger transition functions                    | impact command handler                               | every completed diff-gate execution calls the shared recorder once                   |
| Separate verified and unverified resolution | `computeEffectiveness(events)`                                     | none                                     | terminal-event classification by caught/resolved commit | effectiveness command rendering only                 | same non-null HEAD = fixed; changed or missing HEAD = unverified; moves remain moved |
| Deterministic candidate sampling            | exported calibration-core functions                                | seed only                                | stable identity hash and ranking                        | accuracy script reads command JSON                   | same rows and seed always select the same sample                                     |
| Certification statistics                    | exported calibration-core functions                                | none                                     | verdict counts, Wilson interval, certification state    | report writer                                        | 95/90 thresholds and insufficient-evidence rules match the roadmap                   |
| Generate real-repo packet                   | accuracy script health-dead mode                                   | process runner, filesystem, clock        | row normalization and sample selection                  | temporary cache, CLI processes, JSON/Markdown writes | corpus repos remain unmodified and packet records commit/capabilities/evidence       |
| Install Vega hooks                          | packaged `setup-hooks` command                                     | Vega checkout filesystem and Git exclude | existing merge policy                                   | checkout-local provider configs                      | preserve unrelated hooks; hook configs remain untracked                              |

## Phase 1 — Make effectiveness observe normal verification

### 1.1 Record before output branching

- [x] **File**: `src/runtime/query-commands/impact.ts:210-305`
- **Source**: `scip-query code 'src/runtime/query-commands/impact.ts:220-255' --json`;
  `scip-query refs recordDiffGateOutcomes --json`.
- **What**: normal JSON mode returns before `recordDiffGateOutcomes`; text mode
  also reaches recording only through hook mode.
- **Change**: call the shared recorder once after the gate result is complete
  and before JSON/text/hook rendering branches. Reuse its result in hook mode
  and surface append warnings without changing gate exit semantics.
- **Testability**:
  - Test seam: command handler fixture plus existing recorder integration.
  - Injected dependencies: existing DB/runtime seams.
  - Pure core: unchanged finding transition calculation.
  - Side-effect shell: handler invokes recorder.
  - Contract: one invocation per diff-gate execution.
- **Validation**: focused runtime tests prove ordinary JSON caught → clean
  records the same event sequence as hook mode and records a clean run so prior
  findings can close.
- **Why**: the first observation must be captured when the agent actually sees
  it; a final Stop hook cannot reconstruct earlier output.

### 1.2 Classify cross-HEAD disappearance as unverified

- [x] **Files**: `src/queries/health/effectiveness.ts:26-134`,
      `tests/queries/effectiveness.test.ts`,
      `tests/runtime/diff-gate-outcomes.test.ts`
- **Source**: `scip-query code computeEffectiveness --json`;
  `scip-query code movedFindingKeys --json`;
  `scip-query change-surface src/queries/health/effectiveness.ts --json --full`.
- **What**: any resolved terminal event not classified as a move is counted as
  fixed even when the caught and resolved HEAD commits differ.
- **Change**: add `unverified` to per-check output. Count a resolution as fixed
  only when caught and resolved observations have the same non-null commit.
  Preserve moved classification first; changed/missing commits become
  unverified and do not enter the precision denominator or median time-to-fix.
- **Testability**:
  - Test seam: `computeEffectiveness` pure event arrays.
  - Injected dependencies: none.
  - Pure core: terminal classification.
  - Side-effect shell: JSON/text rendering consumes the expanded report.
  - Contract: effectiveness never calls a cross-HEAD disappearance a verified
    fix.
- **Validation**: tests cover same-HEAD fixed, changed-HEAD unverified,
  missing-commit unverified, moved, suppressed, reopened, and windowing.
- **Why**: a clean diff after commit is not proof that the flagged code was
  repaired.

### 1.3 Reconcile public wording

- [x] **Files**: command descriptions, README/agent guide/generated references,
      shared skill reliability text, and the accuracy roadmap where applicable.
- **Source**: `scip-query refs computeEffectiveness --json`;
  `scip-query co-change src/runtime/commands/command-descriptors.ts --json --full`.
- **What**: current wording says resolved rows were fixed by code changes.
- **Change**: define fixed as same-HEAD verified disappearance, add unverified
  disappearance, and state that normal diff-gate runs record repository
  outcomes. Standalone health detectors remain outside effectiveness until a
  complete-scan observation contract exists.
- **Validation**: generated command docs, doc drift, and output snapshots.
- **Why**: user-facing labels must match the evidence actually stored.

## Phase 2 — Repair Vega's checkout-local setup

### 2.1 Install and inspect project hooks

- [x] **Target**: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- **Source**: `scip-query code installProjectAgentHooks --json` and live
  inspection of Vega's local settings/Git exclude.
- **What**: no scip-query Codex or Claude hook group is installed.
- **Change**: after the source fix is built and globally linked/installed, run
  `scip-query setup-hooks --json`. Preserve the existing Impeccable
  `PostToolUse` group and verify `.codex/hooks.json` plus
  `.claude/settings.local.json` are excluded through `.git/info/exclude`.
- **Testability**:
  - Test seam: setup result JSON and provider config inspection.
  - Injected dependencies: existing hook installer.
  - Pure core: existing hook-config merge.
  - Side-effect shell: Vega checkout-local files.
  - Contract: no tracked Vega file changes merely from hook installation.
- **Validation**: `git status --short` before/after shows only the user's
  existing work; a controlled diff-gate run initializes future event tracking
  without fabricating historical events.
- **Why**: Vega cannot record automatically without the local lifecycle hook.

## Phase 3 — Build the certification core and packet generator

### 3.1 Add pure calibration policy

- [x] **Files**: create `scripts/accuracy-calibration-core.mjs` and
      `tests/scripts/accuracy-calibration-core.test.mjs`
- **Source**: direct inspection of the non-indexed
  `scripts/accuracy-calibration.mjs`; roadmap certification table in
  `docs/accuracy-hardening-goal.md`.
- **Change**: implement schema versioning, stable row identity, deterministic
  seeded sampling, verdict aggregation, Wilson 95% interval, and certification
  classification. Keep thresholds data-driven and emit `certified`,
  `qualified`, `experimental`, `unsupported`, or `insufficient-evidence`.
- **Testability**:
  - Test seam: direct pure-function imports.
  - Injected dependencies: seed/string inputs only.
  - Pure core: all calculations and selection.
  - Side-effect shell: none.
  - Contract: deterministic output and roadmap-exact thresholds.
- **Validation**: focused Vitest suite including 95/100 versus 97/100 interval
  behavior, uncertain rows, repo-count gate, and stable sampling.
- **Why**: certification cannot depend on hand-edited spreadsheet formulas or
  non-reproducible top-result sampling.

### 3.2 Extend the existing real-repository harness

- [x] **File**: `scripts/accuracy-calibration.mjs`
- **Source**: direct sequential inspection; the script is outside the SCIP
  index (`scip-query plan-context scripts/accuracy-calibration.mjs --json`
  reports no match).
- **What**: the script only runs navigation oracles for three hard-coded cases.
- **Change**: preserve navigation mode and add a `health-dead` mode that accepts
  repository manifests, builds temporary indexes, records capabilities and Git
  commit, runs `dead --full --json`, retains only `dead-code` rows, selects a
  deterministic sample, captures bounded source context, and writes both JSON
  and Markdown review packets with blank verdict/archetype fields.
- **Testability**:
  - Test seam: pure core for normalization/sampling plus one temporary-repo
    process smoke.
  - Injected dependencies: CLI path, clock, process runner, filesystem paths.
  - Pure core: selection/statistics.
  - Side-effect shell: index and report generation.
  - Contract: corpus repos are read-only; failure is per-repo and explicit.
- **Validation**: existing navigation mode still passes where repositories are
  present; health-dead mode produces schema-valid deterministic packets.
- **Why**: the first real baseline must be replayable after detector fixes.

## Phase 4 — Produce the TypeScript dead-code baseline

### 4.1 Generate the four-repository packet

- [x] **Corpus**: Vega_2.0, openwork, Stable_Management, traceroot
- **Source**: roadmap corpus table and live local repository inventory.
- **Change**: generate 25 deterministic dead-code candidates per repository,
  or all available rows when fewer exist, using isolated caches and recording
  any degraded capability.
- **Validation**: packet totals, unique identities, commit pins, capability
  records, source excerpts, and no corpus worktree mutations.
- **Why**: this creates the sampling frame required before detector tuning.

### 4.2 Classify and name noise archetypes

- [x] **Files**: generated JSON packet and a dated validation report under
      `docs/validation/`
- **Source**: each packet row's cited source and graph evidence.
- **Change**: inspect code for every sampled row and record `valid`, `invalid`,
  or `uncertain`; name false-positive archetypes; calculate the baseline
  precision and certification state without changing thresholds.
- **Validation**: every row has a verdict and evidence note; summary is derived
  by the calibration core; uncertain rows are not counted as valid.
- **Why**: measured noise archetypes, not finding volume, determine the next
  detector fixes.

## Stress-Test Findings

- Recording normal diff-gate runs creates repository records as a side effect.
  This is intentional for the verifier command, must be documented, and must
  never alter the gate result when append I/O fails.
- A resolved ID with a changed HEAD is ambiguous: the fix may be legitimate,
  but the stored evidence cannot prove it. Conservative `unverified` labeling
  protects precision and gives agents a clear reason to rerun before commit.
- A clean first run creates no event file because there is no transition. This
  is correct; setup must not fabricate a caught/fixed history.
- Standalone detector commands cannot safely close findings until their output
  declares scan completeness, capability coverage, and stable identity. Keep
  that extension in the certification roadmap rather than silently treating a
  bounded run as a full observation.
- Existing JSONL events remain readable. The report schema addition is
  backward compatible because it derives `unverified` from stored commits.
- Real repositories are mutable user worktrees. Calibration must use separate
  cache directories and never edit source; any mutation testing belongs in a
  disposable Git worktree added later for recall.
- Fewer than 100 emitted candidates is evidence, not a harness failure. Record
  the smaller sample and return `insufficient-evidence` when gates cannot be
  met.

## Execution and Ship Order

1. Implement Phase 1 with focused tests; the report addition is backward
   compatible but changes the meaning of `fixed`.
2. Build the package, install Vega's local hooks, and prove Git cleanliness.
3. Implement and test the calibration core and harness.
4. Generate the real-repository packet, then classify without detector tuning.
5. Reconcile roadmap/result docs and generated command references.
6. Run focused tests, full test/typecheck/lint/build, package smoke as needed,
   `scip-query reindex`, and `scip-query diff-gate --json`.

The one-way door is public interpretation of historical effectiveness: old
cross-HEAD resolutions will move from `fixed` to `unverified`. This is an
intentional correction; raw events are preserved and no repository history is
rewritten.

## File Summary

Create:

- `scripts/accuracy-calibration-core.mjs`
- `tests/scripts/accuracy-calibration-core.test.mjs`
- one dated TypeScript dead-code calibration report
- generated local accuracy packet artifacts

Edit:

- `src/runtime/query-commands/impact.ts`
- `src/queries/health/effectiveness.ts`
- focused effectiveness/outcome tests
- `scripts/accuracy-calibration.mjs`
- command and agent documentation describing effectiveness
- `docs/accuracy-hardening-goal.md` progress state

Checkout-local only:

- Vega `.codex/hooks.json`
- Vega `.claude/settings.local.json`
- Vega `.git/info/exclude`

Delete: none.
