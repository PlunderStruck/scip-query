# Doc Reference Citation Parser Result

Date: 2026-06-22

## Verdict

The doc-reference citation parser follow-up is closed. Path-reference doc output now extracts a Markdown-local cited claim instead of a fixed line window, so neighboring sections no longer contaminate the citation kind.

A Markdown-local cited claim is the smallest document unit that gives a file-path citation its review meaning: a paragraph, list item, table block, or fenced code example. It differs from a fixed line window because it follows the author's document structure and avoids mixing unrelated nearby sections into the classification evidence.

## Implementation

- Added `src/queries/cleanup/doc-citation-context.ts` with `markdownCitationContext()`.
- `markdownCitationContext()` extracts:
  - fenced code blocks as whole fenced examples,
  - contiguous Markdown table blocks,
  - list items with indented continuations,
  - ordinary paragraphs bounded by blank lines, headings, tables, lists, and fences.
- `src/queries/cleanup/doc-drift.ts` uses that helper while building doc path evidence, so path-reference `doc-drift` and `docsCitingFiles()` share the structured claim extraction.
- `src/queries/impact/diff-gate.ts` uses the same helper in its fallback `docCitationContexts()`, keeping doc-reference fallback behavior aligned with doc-drift.
- `src/queries/public-query-entries.ts` classifies `doc-citation-context.ts`, `doc-terms.ts`, and diff-gate policy/type helpers as private helper modules, keeping the public query manifest contract explicit. The later `locality-candidates` public entry does not change that private-helper classification.
- The helper's Markdown boundary checks now share a single interruption classifier, so the implementation does not introduce a new health-baseline similarity finding.
- `tests/queries/impact/incomplete-migration.test.ts` adds a regression where configuration prose appears near a behavioral citation. The finding stays `citationKind: "behavioral-claim"` and `actionTier: "direct"`, and the cited claim excludes `declaredCouplings`.

## Verification

Completed:

- `npx vitest run tests/queries/impact/incomplete-migration.test.ts -t doc-reference` passed 1 selected test.
- `npx vitest run tests/analysis/git-history.test.ts -t "citation context"` passed 1 selected test.
- `npx vitest run tests/queries/impact/incomplete-migration.test.ts` passed 22 tests. The run still prints the known noisy `git diff` usage warning from the existing fixture.
- `npx prettier --check src/queries/cleanup/doc-citation-context.ts src/queries/cleanup/doc-drift.ts src/queries/impact/diff-gate.ts tests/queries/impact/incomplete-migration.test.ts tests/analysis/git-history.test.ts docs/plans/2026-06-22-doc-reference-citation-parser.md` passed.
- `npm run typecheck` passed.
- `npm run build` passed.
- `node dist/cli.js similar markdownCitationContext --json` returned no rows.
- `node dist/cli.js recent-duplicates --json` returned no findings or root-cause groups.
- `node dist/cli.js unused-params --json` returned `[]`.
- `node dist/cli.js wrapper-candidates --json` returned `[]`.
- `node dist/cli.js passthrough-candidates --json` returned `[]`.
- `node dist/cli.js incomplete-migration --json` reported no findings on the real repository diff.
- `node dist/cli.js health --json` reported score 100, risk score 100, hygiene score 100, and no pressure rows.
- `npx vitest run tests/runtime/cli-contract.test.ts` passed 16 tests after the private-helper manifest classification.
- `npm test` passed 66 files and 335 tests. The run still prints the known noisy `git diff` usage warning from the existing fixture.
- `npm run typecheck` passed after the helper-manifest and boundary-classifier changes.
- `npm run build` passed after the helper-manifest and boundary-classifier changes.
- `node dist/cli.js similar isParagraphContinuation --json` returned no rows after the boundary-classifier cleanup.
- `node dist/cli.js reindex` passed after the final build.
- `node dist/cli.js diff-gate --json` returned only accepted warnings `SQ36D93309ABEA` and `SQ30E6CF5F9B38`.
  - `SQ36D93309ABEA` is the already-reviewed signal-tier echo between compile-time contract detection and indexed definition parsing.
  - `SQ30E6CF5F9B38` is the already-reviewed support-tier README configuration example; the cited claim is now limited to the fenced JSON example.

## Residual Risk

The parser intentionally handles common Markdown structure, not every possible prose convention. That is enough for the current direct/signal/support split because doc-reference remains a review prompt, and the output now carries the cited claim that reviewers can inspect.

The next precision candidate is passthrough package/export and public-facade caveats.

## 2026-06-23 Citation Refresh

The maintainability-register completion slice rechecked the behavioral claim that `diff-gate.ts` uses the shared Markdown citation helper for doc-reference fallback contexts. That claim remains current; the slice only moved diff-gate finding emission behind `recordFinding()` after citation classification and remediation are selected.

## 2026-06-27 Citation Refresh

The persistent-refresh coordination slice rechecked the doc-reference fallback claim in `diff-gate.ts`. The fallback citation-context behavior remains aligned with doc-drift; the changed refresh and hook code does not alter doc-reference citation parsing.

## 2026-06-28 Path Evidence Cache Refresh

The doc-drift path-evidence cache removed the old `docCitationContextWindows()` wrapper. The citation parser claim remains current because `docPathEvidence()` still calls `markdownCitationContext()` when it builds cached path candidates and citation contexts, and both `doc-drift` and `docsCitingFiles()` consume that shared evidence.

## 2026-06-28 Diff-Gate Echo Follow-Up

The doc-reference citation parser references to `diff-gate.ts` remain accurate.
The latest edit does not touch doc-reference fallback parsing or citation
context behavior; it only skips non-callable symbols in the echo check.

## 2026-06-28 Raw Git Path Follow-Up

The doc-reference citation parser references to `diff-gate.ts` remain accurate.
The co-change partner cleanup does not touch doc-reference parsing or citation
contexts; it only counts raw git changed paths when testing partner presence.

## 2026-06-28 Focused Co-Change History Follow-Up

The doc-reference citation parser references to `diff-gate.ts` remain accurate.
The focused co-change history optimization does not touch doc-reference parsing
or citation contexts; it only changes how the separate co-change partner check
loads git-history evidence.

## 2026-06-30 Evidence Product Follow-Up

The `src/queries/cleanup/doc-drift.ts` citation-parser reference remains
accurate after the file evidence product registry migration. Markdown citation
context extraction still uses the same parser and path-evidence payload; only
the persistent cache read/write path moved to `src/storage/evidence-products.ts`.

## 2026-06-30 Health Cleanup Follow-Up

The private-helper classification claim has moved: `src/queries/public-query-entries.ts`
now exports only the public query manifest used by packaging, while
`tests/runtime/cli-contract.test.ts` owns the private helper source-path fixture
that verifies those helpers are not published. The public command manifest
contract remains explicit.

2026-07-01 round-2 remediation note: the `src/queries/cleanup/doc-drift.ts`
behavioral citation was rechecked after line-suffix capture and shared
citation-kind tiering landed. Path references are still resolved before
citation contexts are scored; line references are recorded for evidence and are
not yet treated as line-drift failures.
