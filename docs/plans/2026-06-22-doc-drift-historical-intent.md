# Doc Drift Historical Intent Plan

Date: 2026-06-22

## Goal

`doc-drift` should not make a historical note look like a stale current standard when the only evidence is past doc/code co-change. A historical note is a document section or file that records what happened or what used to be true; it differs from current guidance because its purpose is preservation of context rather than instruction for future changes. A co-change-only staleness row is a doc-drift subject found from commit history without a file-path citation in the doc text. Done means co-change-only subjects expose doc intent, action tier, and reasons, and a fixture proves historical notes become support-tier while current guidance remains a review signal.

## Current State

- `src/queries/cleanup/doc-drift.ts:6-20` defines `DocDriftSubject` with evidence, co-change count, changes since doc update, and optional citation contexts, but no intent or action-tier fields. Source: `node dist/cli.js code DocDriftSubject --json`.
- `src/queries/cleanup/doc-drift.ts:87-173` creates `reference`, `co-change`, and `both` subjects; pure co-change subjects do not inspect doc wording before being reported. Source: `node dist/cli.js code docDrift --json`.
- `src/queries/cleanup/doc-drift.ts:175-216` already builds a one-pass scan index with doc/code co-change counts and tracked docs. Source: `node dist/cli.js code buildDocDriftScanIndex --json`.
- `src/runtime/query-commands/cleanup/handlers.ts:861-908` renders doc-drift rows with evidence text and citation context when available, but co-change-only rows have no intent explanation. Source: `node dist/cli.js code 'src/runtime/query-commands/cleanup/handlers.ts:850-930' --json`.
- `src/queries/impact/diff-gate.ts:658-698` already has citation-kind classification for explicit diff-gate doc references, including historical/intentional wording. Source: `node dist/cli.js code classifyDocCitation --json`.

## Reuse Audit

- Reuse `docDrift()`'s existing doc file read path and `readFileSync` import instead of adding a new evidence provider. Source: `node dist/cli.js code docDrift --json`; `node dist/cli.js outline src/queries/cleanup/doc-drift.ts --json`.
- Mirror the existing diff-gate citation-kind vocabulary for historical/intentional wording without depending on the private `classifyDocCitation()` helper across modules. Source: `node dist/cli.js code classifyDocCitation --json`.
- `node dist/cli.js similar classifyDocCitation --json` found structural overlap with other diff-gate helpers, not a reusable public doc-intent classifier.

## Design

### 1.1 - Add doc intent metadata to subjects

- [x] **File**: `src/queries/cleanup/doc-drift.ts:6-20`
- **Source**: `node dist/cli.js code DocDriftSubject --json`
- **What**: Subjects do not state whether the document sounds like current guidance, a historical note, or unknown intent.
- **Change**: Add `DocDriftIntent`, `DocDriftActionTier`, `docIntent`, `actionTier`, and `docIntentReasons` fields. Keep fields additive.
- **Why**: Consumers can discount co-change-only historical notes without losing the drift evidence.

### 1.2 - Classify co-change-only subject intent

- [x] **File**: `src/queries/cleanup/doc-drift.ts:87-173`
- **Source**: `node dist/cli.js code docDrift --json`
- **What**: Co-change-only subjects are emitted from history counts and code churn alone.
- **Change**: Read a bounded portion of the doc text once per doc, classify historical-note wording such as historical, retrospective, archived, previous, or record, classify current-guidance wording such as current, standard, should, must, policy, or guide, and attach action tier. Co-change-only historical notes become `support`; co-change-only current or unknown docs stay `signal`. Reference and both subjects keep stronger action tiers unless historical wording says support.
- **Why**: The detector should distinguish "this old note stopped tracking code" from "this living standard stopped tracking code."

### 1.3 - Render intent in doc-drift CLI output

- [x] **File**: `src/runtime/query-commands/cleanup/handlers.ts:861-908`
- **Source**: `node dist/cli.js code 'src/runtime/query-commands/cleanup/handlers.ts:850-930' --json`
- **What**: The CLI prints evidence type but not doc intent or action tier.
- **Change**: Print compact intent/action-tier text for each subject and the first intent reason.
- **Why**: Reviewers need the classification visible in normal text output, not only JSON.

### 2.1 - Add regression coverage

- [x] **File**: `tests/analysis/git-history.test.ts`
- **Source**: Production behavior anchored by `node dist/cli.js code docDrift --json`; the test fixture itself is not indexed by scip-query.
- **What**: Existing doc-drift tests cover co-change staleness and citation contexts, but not historical-note intent.
- **Change**: Add a git fixture with a historical note and a current guide that both co-change with code, then let the code move on. Assert the historical note subject is `support`/`historical-note` and the current guide subject remains `signal`/`current-guidance`.
- **Why**: This directly protects the false-positive class named in the validation ledger.

### 3.1 - Update validation records

- [x] **File**: `docs/analyzer-validation-ledger.md`, `docs/analyzer-validation-protocol.md`, `docs/analyzer-inventory.md`, `docs/validation/2026-06-21-analyzer-calibration-memo.md`, and `docs/validation/2026-06-21-output-schema-quality-finalization-result.md`
- **Source**: The current missing-field list in `docs/validation/2026-06-21-output-schema-quality-finalization-result.md` names historical-note intent classification for co-change-only staleness rows.
- **What**: The docs currently list this as remaining precision work.
- **Change**: Record the result and move the next candidate to the next unresolved output-schema gap.
- **Why**: The validation ledger should remain the operating map for the next slice.

## Stress Test

- Understand before touching: doc-drift has two evidence sources. Explicit path references are stronger than pure co-change because the doc text names the code. This slice only discounts intent when the doc itself says it is historical or intentional.
- Blast radius: `DocDriftSubject` is exported through query results and rendered by the cleanup handler. Additive fields preserve existing consumers.
- Intermediate validity: Add fields and defaults first, then rendering and tests.
- Reversibility: This is output metadata and action-tier wording; removing it returns previous staleness rows.
- Failure design: If the doc cannot be read, classify intent as `unknown` and keep the existing signal/direct behavior.
- Concurrency: No shared mutable state; text is read per query run.
- Boundaries: No CLI option or persisted schema change.
- Data integrity: No writes.
- Observability: JSON and text output will show action tier, intent, and reason.
- Human impact: Agents get less pressure to "update" historical notes that are intentionally records.
- Reuse: Use existing doc-drift file reads and the existing diff-gate citation vocabulary.

## Execution Order

1. Add subject metadata types and classification helpers.
2. Attach intent/action-tier fields when creating reference, co-change, and both subjects.
3. Render the new fields in `doc-drift` text output.
4. Add focused git-history fixture assertions.
5. Update validation docs and run focused tests, typecheck, build, analyzer post-checks, full tests, reindex, and diff-gate.

## Ship Order

This is one backward-compatible output-precision slice. It changes the review strength of doc-drift rows, not the command surface or git-history scan.
