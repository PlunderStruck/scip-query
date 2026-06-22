# Co-Change Recency and Broad-Sweep Context Plan

Date: 2026-06-22

## Goal

Co-change output should keep useful hidden-coupling evidence while showing when the history is mostly broad batch work or old history. A broad feature sweep is a commit that changes many files or directory areas as part of one work batch; it can make two files appear coupled even when the real-world connection is only that they were swept into the same release, migration, or cleanup. Recency context is the age and count of the pair's latest shared commits within the analyzed history window; it distinguishes current coordination pressure from stale historical correlation. Done means standalone `co-change`, diff-gate `co-change-partner`, and health hidden-coupling summaries expose these facts, and fixtures prove focused/recent pairs differ from broad or stale pairs.

## Current State

- `src/analysis/git-history.ts:260-300` computes `CoChangePair` from bounded git history, but it only returns pair counts, file-level changes, and aggregate confidence. Source: `node dist/cli.js code getCoChangePairs --json`.
- `src/analysis/git-history.ts:40-49` defines `CoChangePair` without any pair-level commit-shape or timestamp fields. Source: `node dist/cli.js code CoChangePair --json`.
- `src/analysis/git-history.ts:96-140` loads commit timestamps and per-commit file lists, so broad-sweep and recency evidence already exists before pair aggregation. Source: `node dist/cli.js code loadCommitHistory --json`.
- `src/queries/impact/co-change.ts:77-137` filters and classifies co-change pairs, then returns them as `CoChangeFinding`; this is the right place to preserve the new pair fields, not recompute them. Source: `node dist/cli.js code coChange --json`.
- `src/queries/impact/diff-gate.ts:490-555` recomputes directional confidence for changed-side partner warnings and currently explains only co-change count, confidence, and partner class. Source: `node dist/cli.js code runCoChangePartnerCheck --json`.
- `src/runtime/query-commands/impact.ts:43-84` renders standalone `co-change` text with pair count, confidence, partner class, and declared-coupling suggestion. Source: `node dist/cli.js code 'src/runtime/query-commands/impact.ts:1-80' --json` and `node dist/cli.js code 'src/runtime/query-commands/impact.ts:80-130' --json`.
- `src/queries/health/health.ts:516-539` copies only `fileA`, `fileB`, `together`, and `confidence` into `hiddenCoupling.top`, while `src/queries/health/health-types.ts:66-74` declares the same narrow shape. Source: `node dist/cli.js code summarizeGitEvidence --json`; `node dist/cli.js code GitEvidenceSummary --json`.

## Reuse Audit

- Reuse `CommitRecord.timestamp` and `CommitRecord.files` from existing git history loading instead of adding another git command. Source: `node dist/cli.js code loadCommitHistory --json`.
- Reuse the existing `maxFilesPerCommit` option as the upper bound and add only a lower broad-sweep classification threshold. Source: `node dist/cli.js code getCoChangePairs --json`.
- Reuse the existing co-change classifier and rendering paths. `node dist/cli.js plan-context coChange --full --json` shows `coChange()` feeds health, plan-context, the public query API, and text rendering.
- `node dist/cli.js similar getCoChangePairs --json` found only low-score access/query scaffolding overlap with `buildDocDriftScanIndex()`, not an existing pair-history context helper.

## Design

### 1.1 - Add pair history context to git-history

- [x] **File**: `src/analysis/git-history.ts:40-49` and `src/analysis/git-history.ts:260-300`
- **Source**: `node dist/cli.js code CoChangePair --json`; `node dist/cli.js code getCoChangePairs --json`
- **What**: `CoChangePair` reports how often two files changed together but not whether those shared commits were focused, broad, recent, or stale.
- **Change**: Add `CoChangeCommitScope` and `CoChangeRecency` types plus additive fields on `CoChangePair`: `focusedTogether`, `broadTogether`, `broadCommitRatio`, `lastTogetherAt`, `recentTogether`, `commitScope`, and `recency`. In `getCoChangePairs()`, keep per-pair metadata while counting pairs. Classify a pair as `broad-sweep` when at least half its co-change commits are broad, `mixed` when some are broad, and `focused` otherwise. Classify recency relative to the newest analyzed commit timestamp so fixture output is deterministic.
- **Why**: The pair counter is the only place that still has the exact commit file lists and timestamps for each co-change.

### 1.2 - Carry context through co-change and diff-gate

- [x] **File**: `src/queries/impact/co-change.ts:34-48` and `src/queries/impact/diff-gate.ts:490-555`
- **Source**: `node dist/cli.js outline src/queries/impact/co-change.ts --json`; `node dist/cli.js code runCoChangePartnerCheck --json`
- **What**: `CoChangeFinding` inherits pair fields structurally today, but diff-gate drops the context when building its warning message.
- **Change**: Add the new context fields to `CoChangeFinding` and `DiffGateFinding` usage. Include commit scope and recency in `co-change-partner` `why` lines. Keep declared-coupling suggestions limited to contract-like partner classes; if a pair is broad-sweep or stale, explain that the warning is weaker review evidence.
- **Why**: A changed-side partner warning should show whether history indicates a focused current relationship or broad/stale correlation.

### 1.3 - Render context in CLI and health output

- [x] **File**: `src/runtime/query-commands/impact.ts:43-84`, `src/queries/health/health.ts:516-539`, and `src/queries/health/health-types.ts:66-74`
- **Source**: `node dist/cli.js code 'src/runtime/query-commands/impact.ts:1-80' --json`; `node dist/cli.js code summarizeGitEvidence --json`; `node dist/cli.js code GitEvidenceSummary --json`
- **What**: Text and health summaries currently show only together/confidence, which can make broad or stale history look as strong as focused current coordination.
- **Change**: Print compact text such as `focused/recent` or `broad-sweep/stale`; add the same fields to `hiddenCoupling.top`.
- **Why**: The same evidence should stay visible across standalone review, health summary, and diff-gate.

### 2.1 - Add focused regression coverage

- [x] **File**: `tests/analysis/git-history.test.ts` and `tests/queries/impact/co-change-partner-labels.test.ts`
- **Source**: Production behavior anchored by `node dist/cli.js code getCoChangePairs --json`, `node dist/cli.js code coChange --json`, and `node dist/cli.js code runCoChangePartnerCheck --json`; these test fixtures are not indexed by scip-query.
- **What**: Existing tests prove high-confidence pairs and partner classes, but not broad-sweep or recency metadata.
- **Change**: Add git-history fixture assertions for a focused/recent pair, a broad-sweep pair, and an older pair. Extend the diff-gate co-change-partner fixture to assert the new `why` text and structured fields.
- **Why**: The precision slice is only valuable if broad and stale evidence is reproducible, not inferred from a live repository's incidental history.

### 3.1 - Update validation records

- [x] **File**: `docs/analyzer-validation-ledger.md`, `docs/analyzer-validation-protocol.md`, `docs/analyzer-inventory.md`, `docs/validation/2026-06-21-analyzer-calibration-memo.md`, and `docs/validation/2026-06-21-output-schema-quality-finalization-result.md`
- **Source**: The ledger already lists the current follow-up in `docs/validation/2026-06-21-analyzer-calibration-memo.md` after the incomplete-migration result update.
- **What**: The validation docs currently treat broad-feature-sweep and recency context as remaining co-change precision work.
- **Change**: Record the implementation result and move the next candidate to the following unresolved output-schema gap.
- **Why**: The ledger should keep pointing at real remaining work, not completed slices.

## Stress Test

- Understand before touching: co-change is history evidence, not a dependency proof. The new fields should explain evidence strength without hiding pairs.
- Blast radius: `CoChangePair` feeds `coChange()`, health git evidence, plan-context history, diff-gate partner warnings, public API output, and CLI text. Additive fields preserve JSON compatibility.
- Intermediate validity: First add pair fields with defaults from existing history data, then render and test them.
- Reversibility: This is metadata and wording. Removing it returns the previous aggregate behavior.
- Failure design: Repos without git history still return `available: false`; pairs with missing timestamps should become stale/unknown only through deterministic numeric defaults.
- Concurrency: No shared mutable state; metadata is local to one query run.
- Boundaries: Public CLI options stay unchanged.
- Data integrity: No persisted config or index schema change.
- Observability: Diff-gate and text output will state both commit scope and recency.
- Human impact: Reviewers can treat broad or stale co-change as weaker signal without losing the raw pair evidence.
- Reuse: Use existing git history loading, co-change filtering, and rendering paths.

## Execution Order

1. Add `CoChangePair` context fields and pair metadata aggregation in `getCoChangePairs()`.
2. Carry the fields into `CoChangeFinding`, diff-gate findings, text output, and health summary types.
3. Add focused git-history and diff-gate fixtures.
4. Update docs and run focused tests, typecheck, build, analyzer post-checks, full tests, reindex, and diff-gate.

## Ship Order

This is one backward-compatible metadata slice. It changes evidence quality and wording, not public command options or gating severity.
