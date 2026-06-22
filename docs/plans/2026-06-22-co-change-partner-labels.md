# Co-Change Partner Labels Plan

Date: 2026-06-22

## Goal

Co-change output should tell reviewers what kind of relationship a historical partner probably represents before asking them to act. A co-change partner class is an evidence label for two files that repeatedly changed in the same commits; its essential trait is that it distinguishes coordination contracts, such as doc/code or schema/script pairs, from broad same-feature churn. Done means `co-change` and `diff-gate` expose partner-class metadata, human text output names the class, and high-confidence repeated contract-like pairs get a concrete declared-coupling suggestion.

## Current State

- `src/queries/impact/co-change.ts:7-18` defines `CoChangeFinding` as file pair, count, confidence, change counts, and structural-link boolean. Source: `node dist/cli.js outline src/queries/impact/co-change.ts --json`; `node dist/cli.js code 'src/queries/impact/co-change.ts:1-220' --json`.
- `src/queries/impact/co-change.ts:47-98` gets git-history pairs, removes noise/deleted files, hides already-linked pairs by default, and returns flat findings without relationship labels. Source: `node dist/cli.js code coChange --json`.
- `src/analysis/git-history.ts:260-300` computes `CoChangePair` rows from commit history and only knows file names, together count, confidence, and per-file change counts. Source: `node dist/cli.js trace getCoChangePairs --json`.
- `src/analysis/file-classifier.ts:31-38` classifies files only as test, worker, entry, barrel, or source, so doc/code and schema/script labels must be co-change-specific metadata rather than global file kinds. Source: `node dist/cli.js code classifyFile --json`; `node dist/cli.js trace classifyFile --json`.
- `src/queries/impact/diff-gate.ts:474-521` runs the co-change-partner check directly from `getCoChangePairs()`, recomputes directional confidence, and emits a warning when exactly one side changed. Source: `node dist/cli.js code 'src/queries/impact/diff-gate.ts:450-540' --json`; `node dist/cli.js code runCoChangePartnerCheck --json`.
- `src/runtime/query-commands/impact.ts:1-90` renders co-change rows as counts and file paths, without class labels or declared-coupling suggestions. Source: `node dist/cli.js code 'src/runtime/query-commands/impact.ts:1-90' --json`.
- `src/queries/impact/plan-context.ts:130-170` and `src/queries/health/health.ts:500-540` consume `coChange()` by projecting known fields, so optional metadata is backward compatible. Source: `node dist/cli.js code 'src/queries/impact/plan-context.ts:130-170' --json`; `node dist/cli.js code 'src/queries/health/health.ts:500-540' --json`.

## Reuse Audit

- `coChange()` already owns noise filtering, existence checks, structural-link detection, and declared-coupling set detection. Reuse this module for partner classification instead of adding a new analyzer. Source: `node dist/cli.js outline src/queries/impact/co-change.ts --json`.
- `runCoChangePartnerCheck()` already has the exact directional evidence needed for diff-gate; extend that finding in place instead of creating a parallel check. Source: `node dist/cli.js code runCoChangePartnerCheck --json`.
- `node dist/cli.js similar coChange --json` found query-scaffolding overlap, not an existing relationship classifier or declared-coupling suggestion builder.

## Design

### 1.1 - Add co-change partner metadata types

- [x] **File**: `src/queries/impact/co-change.ts:7-25`
- **Source**: `node dist/cli.js outline src/queries/impact/co-change.ts --json`
- **What**: `CoChangeFinding` has evidence fields but no interpretation fields.
- **Change**: Add exported `CoChangePartnerClass` and `DeclaredCouplingSuggestion` types. Add `partnerClass`, `partnerClassReasons`, and optional `declaredCouplingSuggestion` to `CoChangeFinding`.
- **Why**: JSON consumers need machine-readable labels without parsing CLI prose.

### 1.2 - Classify pair relationships inside co-change

- [x] **File**: `src/queries/impact/co-change.ts:47-98`
- **Source**: `node dist/cli.js code coChange --json`; `node dist/cli.js code classifyFile --json`
- **What**: `coChange()` filters and returns pairs without relationship labels.
- **Change**: Add exported helpers that classify pairs as `doc-code`, `config-code`, `schema-script`, `model-view`, `test-code`, `same-feature`, or `unknown`, with short evidence reasons based on path tokens, extension tokens, and existing `classifyFile()` output. Use the helpers when building every `CoChangeFinding`.
- **Why**: Reviewers can distinguish a probable coordination contract from a broad same-feature edit cluster.

### 1.3 - Suggest declared coupling only for specific repeated contracts

- [x] **File**: `src/queries/impact/co-change.ts:47-98`
- **Source**: `node dist/cli.js code coChange --json`; `node dist/cli.js code hasStructuralLink --json`
- **What**: `coChange()` already hides structurally linked pairs unless requested, but unlinked high-confidence pairs receive only a generic “changed together” signal.
- **Change**: For unlinked pairs with at least 4 co-changes, confidence at or above 0.75, and class `doc-code`, `config-code`, `schema-script`, `model-view`, or `test-code`, attach a suggestion naming the likely declared-coupling set and why it is worth declaring. Do not suggest for `same-feature` or `unknown`.
- **Why**: Specific repeated relationships should graduate from historical suspicion to an explicit contract candidate; broad churn should stay advisory.

### 2.1 - Reuse partner metadata in diff-gate

- [x] **File**: `src/queries/impact/diff-gate.ts:474-521`
- **Source**: `node dist/cli.js code 'src/queries/impact/diff-gate.ts:450-540' --json`
- **What**: The co-change-partner finding emits count/confidence but not class, group, source, or suggestion metadata.
- **Change**: Import the co-change classifier/suggestion helpers and add `partnerClass`, `partnerClassReasons`, optional `declaredCouplingSuggestion`, `sourceAnalyzer: 'co-change'`, `groupKey`, `rootCauseKey`, and `actionTier: 'signal'` to each co-change-partner finding.
- **Why**: Diff-gate should carry the same interpretation as the standalone analyzer and should group repeated partner warnings consistently with the previous root-cause slice.

### 2.2 - Render labels and suggestions for humans

- [x] **File**: `src/runtime/query-commands/impact.ts:1-90`
- **Source**: `node dist/cli.js code 'src/runtime/query-commands/impact.ts:1-90' --json`
- **What**: Co-change CLI text prints only pair counts and structural-link status.
- **Change**: Append the partner class to each row and print the declared-coupling suggestion as an indented note when present. Also show partner class and suggestion details in diff-gate finding output.
- **Why**: The reviewer should see why a pair matters before deciding whether to update the partner or declare the coupling.

### 2.3 - Add regression coverage

- [x] **File**: focused impact tests
- **Source**: Production behavior anchored by `node dist/cli.js code coChange --json`, `node dist/cli.js code runCoChangePartnerCheck --json`, and `node dist/cli.js trace getCoChangePairs --json`.
- **What**: Current coverage does not assert partner-class metadata or declared-coupling suggestions.
- **Change**: Add focused tests that construct repeated doc/code and schema/script co-change histories, assert `coChange()` metadata, and assert diff-gate co-change-partner findings preserve the same classification and suggestion.
- **Why**: The validation slice should lock the behavior at the analyzer boundary and at the gate boundary.

## Stress Test

- Understand before touching: `coChange()` is a history analyzer; it should explain git evidence, not invent semantic dependency edges. Source: `node dist/cli.js plan-context coChange --full --json`.
- Blast radius: `coChange()` feeds the query index, CLI, health summary, plan-context history, and diff-gate. Optional fields keep existing projections valid. Source: `node dist/cli.js plan-context coChange --full --json`.
- Intermediate validity: Add helper/types in `co-change.ts`, then wire diff-gate and rendering. Flat rows remain usable throughout.
- Reversibility: This is additive output metadata and prose; rollback removes optional fields and helper calls.
- Failure design: Unknown classes and absent git history should keep current behavior with no suggestion.
- Concurrency: No shared mutable state; helpers are pure functions over paths and pair evidence.
- Boundaries: CLI input and config stay unchanged; JSON output gains optional interpretation fields.
- Data integrity: No persisted schema change.
- Observability: The evidence reasons and suggestion reason make the analyzer’s judgment auditable.
- Human impact: Specific labels reduce verdict-review ambiguity; broad same-feature churn stays labeled without being over-promoted.
- Reuse: Keep relationship logic in `co-change.ts` and reuse it from diff-gate.

## Execution Order

1. Add co-change partner metadata types and pure classification/suggestion helpers.
2. Wire helpers into `coChange()` and `runCoChangePartnerCheck()`.
3. Update co-change and diff-gate text output.
4. Add focused regression tests.
5. Update the validation ledger, calibration memo, protocol, and result note.
6. Run focused tests, typecheck, build, relevant analyzer checks, full test suite, reindex, and diff-gate.

## Ship Order

This is one backward-compatible output slice. It has no one-way door because it only adds optional metadata and clearer text output.
