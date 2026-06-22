# Doc Reference Citation Parser

Date: 2026-06-22

## Goal

Doc-reference and path-reference doc-drift findings should extract the cited claim as a Markdown-local documentation unit instead of a fixed line window.

A cited claim is the paragraph, list item, table row, or fenced example that gives a file-path citation its meaning. Its referents are doc fragments such as `Cleanup detector behavior lives in src/dead.ts.`, a JSON declared-coupling block containing `src/dead.ts`, or a guide bullet that sends readers to a command implementation. The essential distinction is that the claim follows the document's own structure, while a fixed window can mix neighboring sections and misclassify why the path is cited.

Done means the parser keeps configuration examples recognizable, keeps behavioral citations direct, avoids contamination from nearby unrelated config/guide text, and records the result in the validation ledger.

## Current State

- `node dist/cli.js plan-context src/queries/impact/diff-gate.ts --full --json` shows `runDocReferenceCheck()` at `src/queries/impact/diff-gate.ts:620-657`, where `doc-reference` findings use `docsCitingFiles()` cited claims and then `classifyDocCitation()`.
- `node dist/cli.js plan-context src/queries/cleanup/doc-drift.ts --full --json` shows `docsCitingFiles()` at `src/queries/cleanup/doc-drift.ts:316-339` and `docCitationContextWindows()` at `src/queries/cleanup/doc-drift.ts:410-439`.
- `docCitationContextWindows()` currently takes eight lines before and after a cited path. That is broad enough to preserve a fenced JSON example, but it can pull unrelated headings, config prose, or guide text into a behavioral citation.
- `src/queries/impact/diff-gate.ts:708-725` has a fallback `docCitationContexts()` that repeats the same fixed-window shape when `docsCitingFiles()` does not return cited claims.
- `tests/queries/impact/incomplete-migration.test.ts:1019-1128` already covers configuration-example and behavioral-claim doc-reference output.

## Design

### 1. Add Markdown-Local Claim Extraction

- [x] **Files**: `src/queries/cleanup/doc-citation-context.ts`, `src/queries/cleanup/doc-drift.ts`
- **Source**: `src/queries/cleanup/doc-drift.ts:410-439`.
- **Change**: Replace the fixed `lineIndex - 8` / `lineIndex + 9` context with a helper that extracts the containing Markdown unit.
- **Rules**:
  - Fenced code: return the whole fenced block.
  - Table: return the contiguous table block.
  - List item: return the current list item plus indented continuations.
  - Paragraph: return the contiguous paragraph bounded by blank lines, headings, fences, and tables.
  - All contexts stay trimmed and bounded.

### 2. Preserve Existing Citation Kind Semantics

- [x] **Files**: `src/queries/cleanup/doc-drift.ts`, `src/queries/impact/diff-gate.ts`
- **Source**: `src/queries/impact/diff-gate.ts:666-705`.
- **Change**: Keep `classifyDocCitation()` unchanged unless tests show the structured context needs an additional term. The parser should improve the input; the classifier should keep the current action-tier meanings.
- **Change**: Update the fallback `docCitationContexts()` in diff-gate to use the same Markdown-local extraction behavior or a small local equivalent so fallback output does not regress.

### 3. Pin Neighbor-Contamination Regression Coverage

- [x] **File**: `tests/queries/impact/incomplete-migration.test.ts`
- **Source**: existing git-backed doc-reference tests at `tests/queries/impact/incomplete-migration.test.ts:1019-1128`.
- **Change**: Add a doc-reference fixture where an unrelated configuration section appears close to a behavioral path citation.
- **Assertion**: The finding remains `citationKind: "behavioral-claim"`, `actionTier: "direct"`, and the cited claim excludes the neighboring configuration prose.

### 4. Keep Fenced Configuration Examples Covered

- [x] **File**: `tests/queries/impact/incomplete-migration.test.ts`
- **Source**: existing configuration-example fixture at `tests/queries/impact/incomplete-migration.test.ts:1019-1076`.
- **Change**: Strengthen the assertion if needed so a JSON fenced block remains the cited claim and still classifies as `configuration-example`.

### 5. Record The Closed Caveat

- [x] **Files**: `docs/validation/2026-06-22-doc-reference-citation-parser-result.md`, `docs/analyzer-validation-ledger.md`, `docs/validation/2026-06-21-analyzer-calibration-memo.md`, `docs/validation/2026-06-21-output-schema-quality-finalization-result.md`, `docs/analyzer-validation-protocol.md`
- **Source**: completed verification commands from this slice.
- **Change**: Record that citation parser improvement is implemented and choose the next remaining validation slice.

## Verification

- `npx vitest run tests/queries/impact/incomplete-migration.test.ts -t "doc-reference"`
- `npx vitest run tests/analysis/git-history.test.ts -t "citation context"`
- `npx prettier --check src/queries/cleanup/doc-citation-context.ts src/queries/cleanup/doc-drift.ts src/queries/impact/diff-gate.ts tests/queries/impact/incomplete-migration.test.ts tests/analysis/git-history.test.ts docs/plans/2026-06-22-doc-reference-citation-parser.md`
- `npm run typecheck`
- `npm run build`
- `node dist/cli.js similar markdownCitationContext --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js wrapper-candidates --json`
- `node dist/cli.js passthrough-candidates --json`
- `node dist/cli.js incomplete-migration --json`
- `node dist/cli.js dead --only-dead --json`
- `node dist/cli.js health --json`
- `npm test`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`
