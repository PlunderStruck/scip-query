# Doc Cited-Claim Metadata Plan

Date: 2026-06-22

## Goal

Users validating analyzer output need doc-related findings to say what kind of documented claim was touched, not only that a Markdown file mentioned a changed path. A cited claim is a local piece of documentation text that names a code file and gives that name meaning as a behavior description, configuration example, guide reference, or intentional historical record. Done means `doc-reference` and `doc-drift` rows carry enough cited-claim context for reviewers to decide whether the row is direct work, support verification, or a weaker signal.

## Current State

- `src/queries/cleanup/doc-drift.ts:6-38` defines `DocDriftSubject` with `file`, evidence source, co-change count, and staleness count, while `DocDriftFinding` carries only subjects and broken references. Source: `node dist/cli.js code 'src/queries/cleanup/doc-drift.ts:6-38' --json`.
- `src/queries/cleanup/doc-drift.ts:79-163` builds subjects from resolved file-path references and historical co-change, then sorts by code changes since the doc last changed. It does not retain the nearby doc text that explains the citation. Source: `node dist/cli.js code 'src/queries/cleanup/doc-drift.ts:79-163' --json`.
- `src/queries/cleanup/doc-drift.ts:215-281` exposes `docsCitingFiles()` for diff-gate and shares `extractFileReferences()` with `docDrift()`. `docsCitingFiles()` currently returns only `{ doc, cited }`. Source: `node dist/cli.js code 'src/queries/cleanup/doc-drift.ts:215-281' --json`.
- `src/queries/impact/diff-gate.ts:43-72` already has `DocCitationKind`, `citationKind`, and `citationKindReasons` on `DiffGateFinding`; it lacks a first-class cited-claim snippet. Source: `node dist/cli.js code 'src/queries/impact/diff-gate.ts:43-72' --json`.
- `src/queries/impact/diff-gate.ts:429-568` runs the `doc-reference` check, calls `classifyDocCitation()`, and derives action tier from nearby context, but only emits classifier reasons. Source: `node dist/cli.js code 'src/queries/impact/diff-gate.ts:429-568' --json`.
- `src/queries/cleanup/doc-drift.ts` is a medium-risk public query surface with external consumers in `src/queries/impact/diff-gate.ts`, `src/queries/index.ts`, and CLI cleanup handlers. Source: `node dist/cli.js change-surface src/queries/cleanup/doc-drift.ts --json`.
- `src/queries/impact/diff-gate.ts` is a medium-risk public query surface with runtime consumers in `src/queries/index.ts`, `src/runtime/agent-setup.ts`, and `src/runtime/query-commands/impact.ts`. Source: `node dist/cli.js change-surface src/queries/impact/diff-gate.ts --json`; `node dist/cli.js rdeps src/queries/impact/diff-gate.ts --json`.

## Reuse Audit

- Reuse `docCitationContexts()` and `citationNeedles()` as the existing doc-context extraction pattern instead of creating a new independent scanner in diff-gate. Source: `node dist/cli.js code 'src/queries/impact/diff-gate.ts:429-568' --json`.
- Extend `classifyDocCitation()` rather than adding a second classifier; `node dist/cli.js similar classifyDocCitation --json` found only a weak structural overlap with `baselineFindingMetadata()`, not another doc classifier.
- Extend `extractFileReferences()`/`docsCitingFiles()` in `doc-drift.ts` so both analyzers use the same path-resolution semantics. Source: `node dist/cli.js code 'src/queries/cleanup/doc-drift.ts:215-281' --json`.
- `node dist/cli.js similar docCitationContexts --json` and `node dist/cli.js similar extractFileReferences --json` found no reusable same-shape helper elsewhere, so any new helper must be small and local to the doc analyzer code.

## Design

### 1.1 - Add cited-claim metadata to doc-drift subjects

- [x] **File**: `src/queries/cleanup/doc-drift.ts:6-38`
- **Source**: `node dist/cli.js code 'src/queries/cleanup/doc-drift.ts:6-38' --json`
- **What**: `DocDriftSubject` reports which file is stale but not what the doc said about that file.
- **Change**: Add optional `citationContexts?: string[]` to `DocDriftSubject`. Add an exported `DocFileCitation` interface for `{ file, contexts }` so `docsCitingFiles()` can return structured cited-claim context without leaking implementation details.
- **Why**: A stale standards doc and a stale example path need different reviewer judgment; the nearby doc text is the evidence that separates them.

### 1.2 - Preserve contexts during path reference extraction

- [x] **File**: `src/queries/cleanup/doc-drift.ts:215-281`
- **Source**: `node dist/cli.js code 'src/queries/cleanup/doc-drift.ts:215-281' --json`
- **What**: `extractFileReferences()` resolves path-like tokens to `resolved` paths and `broken` references, but discards the line window where each token appeared.
- **Change**: Extend extraction to return citation objects keyed by resolved file, with a bounded nearby context snippet. Keep the existing `resolved` set and `broken` array for compatibility. Use a small local `docCitationContextWindows()` helper beside `docPathCandidates()` because `doc-drift.ts` already owns cached doc-token extraction.
- **Why**: Both `doc-drift()` and `docsCitingFiles()` should explain the cited claim using the same resolution pass that found the path.

### 1.3 - Carry contexts into doc-reference findings

- [x] **File**: `src/queries/impact/diff-gate.ts:43-72`
- **Source**: `node dist/cli.js code 'src/queries/impact/diff-gate.ts:43-72' --json`
- **What**: `DiffGateFinding` has citation kind metadata but no cited-claim snippet.
- **Change**: Add optional `citedClaims?: string[]` to `DiffGateFinding`.
- **Why**: JSON consumers and ledger reviewers need the actual evidence behind `citationKindReasons`.

### 1.4 - Reuse structured contexts in the doc-reference classifier

- [x] **File**: `src/queries/impact/diff-gate.ts:429-568`
- **Source**: `node dist/cli.js code 'src/queries/impact/diff-gate.ts:429-568' --json`
- **What**: `runDocReferenceCheck()` currently recomputes contexts from `{ doc, cited }` and emits only classification reasons.
- **Change**: Consume `citation.contexts` from `docsCitingFiles()`, pass those contexts to `classifyDocCitation()`, and emit `citedClaims` on the finding. Keep `docCitationContexts()` available as a fallback if needed by tests or old call paths.
- **Why**: The finder and classifier should agree on the exact citation context, and the output schema should expose it.

### 1.5 - Update CLI text output and focused tests

- [x] **File**: CLI cleanup and impact command surfaces discovered through `node dist/cli.js surface src/queries/cleanup/doc-drift.ts --json` and `node dist/cli.js rdeps src/queries/impact/diff-gate.ts --json`
- **Source**: `node dist/cli.js surface src/queries/cleanup/doc-drift.ts --json`; `node dist/cli.js rdeps src/queries/impact/diff-gate.ts --json`
- **What**: Text output currently has no place to display cited-claim context.
- **Change**: Print a short cited-claim line for `doc-drift` subjects and `doc-reference` findings where available. Add or update focused tests for configuration example and behavioral prose cases.
- **Why**: Humans should see the same evidence JSON consumers receive.

## Stress Test

- Understand before touching: The flow is path-token extraction in `doc-drift.ts`, then staleness reporting or diff-gate doc-reference classification. Sources: `plan-context doc-drift`, `code` excerpts above.
- Blast radius: `doc-drift.ts` and `diff-gate.ts` are medium-risk query surfaces; preserve existing fields and add optional fields to avoid breaking JSON consumers.
- Intermediate validity: Add fields in a backward-compatible way; no existing required property changes.
- Reversibility: This is internal analyzer metadata only; rollback removes optional fields and text printing.
- Failure design: Unreadable docs continue to return empty contexts, matching current behavior.
- Concurrency: No shared mutable state beyond existing evidence-cache reads/writes; no new async path.
- Boundaries: CLI input remains unchanged; doc text is local repo content.
- Data integrity: No persistent schema migration.
- Observability: JSON/text output gains evidence rather than hiding it in classifier heuristics.
- Human impact: Reviewers can distinguish current standards from examples or historical notes without opening the doc manually.
- Reuse: Existing doc path extraction and classification stay the canonical implementation.

## Execution Order

1. Update `doc-drift.ts` types and extraction context.
2. Update `diff-gate.ts` types and classifier wiring.
3. Update CLI text surfaces and tests.
4. Record validation results and revise analyzer ledger documents.
5. Run focused tests, typecheck, build, full test suite, reindex, and diff-gate.

## Ship Order

This is one deployable slice. It is backward-compatible because all output additions are optional fields and no CLI input contract changes.

## Summary

Expected files: `src/queries/cleanup/doc-drift.ts`, `src/queries/impact/diff-gate.ts`, runtime output descriptors/handlers, focused tests, and validation documentation. Net effect should be more explicit evidence with no analyzer threshold change.
