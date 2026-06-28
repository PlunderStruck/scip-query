# Incomplete Migration Scope Hints Result

Date: 2026-06-22

## Verdict

The incomplete-migration subtype/scope follow-up is closed. Leftover sites now carry review-only migration-scope hints that tell a maintainer whether the leftover looks like the same extraction rollout or a possible subtype/variant site.

A migration-scope hint is a structured review label attached to an unchanged leftover site, such as `src/site-b.ts` or `src/billing.ts`, that compares path and symbol-name evidence against the new helper and the files already migrated to that helper. It exists to separate "probably finish this rollout" from "review whether this is a different variant" without hiding either site from the report.

## Implementation

- `src/queries/impact/incomplete-migration.ts` adds `migrationScope` and `migrationScopeReasons` to each leftover, with `same-scope`, `possible-subtype`, and `unknown` values.
- Scope tokens are derived from the helper file, helper symbol leaf, already migrated files, leftover file, and leftover symbol leaf. Shared domain-ish tokens produce `same-scope`; no shared tokens produce `possible-subtype`; missing evidence produces `unknown`.
- The detector still reports possible subtype rows. It sorts same-scope leftovers first, then unknown, then possible-subtype, so the hint improves review order without becoming a filter.
- `src/runtime/query-commands/impact.ts` renders the scope hint and reason in CLI text.
- `src/queries/impact/diff-gate.ts` includes scope hints in the finding message and `why` text, and changes remediation when possible subtype/variant rows are present.
- `tests/queries/impact/incomplete-migration.test.ts` adds `src/billing.ts` as a callee-matching but out-of-scope leftover. The fixture now proves `site-b` and `site-c` stay `same-scope`, while `billing.ts` stays visible as `possible-subtype`.

2026-06-22 note: the later `diff-gate.ts` doc-reference same-diff fix does not change the incomplete-migration scope-hint behavior described here.

## Verification

Completed:

- `npx vitest run tests/queries/impact/incomplete-migration.test.ts` passed 21 tests.
- `npx prettier --write src/queries/impact/incomplete-migration.ts src/queries/impact/diff-gate.ts src/runtime/query-commands/impact.ts tests/queries/impact/incomplete-migration.test.ts docs/plans/2026-06-22-incomplete-migration-scope-hints.md` formatted the slice after the first check found one unformatted file.
- `npx vitest run tests/queries/impact/incomplete-migration.test.ts` passed again after formatting.
- `npm run typecheck` passed.
- `npm run build` passed.
- `node dist/cli.js similar migrationScopeForLeftover --json` returned no rows.
- `node dist/cli.js recent-duplicates --json` returned no findings or root-cause groups.
- `node dist/cli.js unused-params --json` returned `[]`.
- `node dist/cli.js wrapper-candidates --json` returned `[]`.
- `node dist/cli.js passthrough-candidates --json` returned `[]`.
- `node dist/cli.js incomplete-migration --json` reported no findings on the real repository diff.
- `node dist/cli.js cycles --json` returned `[]`.
- `node dist/cli.js isolated --json` returned `[]`.
- `node dist/cli.js dead --only-dead --json` reported `deadCodeCount: 0`; the remaining rows are file-internal inventory.
- `node dist/cli.js health --json` reported score 100, risk score 100, hygiene score 100, and no pressure rows.
- `npm test` passed 66 files / 334 tests. The run still prints the known noisy `git diff` usage warning from the existing incomplete-migration fixture.
- `node dist/cli.js reindex` rebuilt the TypeScript shard successfully.
- `node dist/cli.js diff-gate --json` exited 1 with the same two accepted warning-level findings from the prior slices:
  - `SQ36D93309ABEA`: signal-tier echo for `isCompileTimeContractAssertion()` versus `indexedDefinitionFromRow()`. Both use symbol leaf helpers, but the product decisions differ, so this remains review context rather than a required extraction.
  - `SQ30E6CF5F9B38`: support-tier README `configuration-example` doc-reference for declared-coupling example paths that still point at the intended cleanup files.

## Residual Risk

The scope label is intentionally heuristic. It compares stable path/name words; it does not prove product subtype semantics. That is the right boundary for this analyzer because incomplete-migration remains a diff-gate review warning, not an automatic rewrite instruction.

The next precision candidate is doc-reference citation parser improvement, especially stronger extraction of the cited sentence or section around path references.

## 2026-06-23 Citation Refresh

The maintainability-register completion slice rechecked the behavioral claim that `diff-gate.ts` includes incomplete-migration scope hints in messages, `why` text, and remediation. That claim remains current; `recordFinding()` only standardizes the final suppression hint and does not alter scope-hint construction.

## 2026-06-23 Current Sweep Citation Refresh

The current maintainability sweep rechecked the scope-hint claim after doc-reference and baseline policy helpers moved into private modules. Scope hints still come from the incomplete-migration check before the finding is recorded, so this validation result remains current.

## 2026-06-27 Citation Refresh

The persistent-refresh coordination slice rechecked the `incomplete-migration.ts`, `diff-gate.ts`, and `src/runtime/query-commands/impact.ts` citations. Scope labels and CLI rendering remain on those surfaces; the new freshness and watcher-lock behavior does not alter scope-hint semantics.

## 2026-06-28 Performance Citation Refresh

The hyper-optimization slice rechecked the `src/queries/impact/incomplete-migration.ts` citation after incomplete-migration switched from rebuilding a local callee-fingerprint index to reusing the cached index accessor in `src/queries/cleanup/similar.ts`. Scope labels, scope reasons, ordering, CLI rendering, and diff-gate remediation text remain unchanged. The later `similarAll()` focus-file pruning option is scoped to `recent-duplicates --full` and does not change incomplete-migration scope hints.

The lazy-index optimization rechecked the `src/queries/impact/incomplete-migration.ts` citation after moving global candidate-index creation behind the meaningful-callee threshold. Scope labels, scope reasons, ordering, CLI rendering, and diff-gate remediation text remain unchanged because helpers that are too small to score are skipped before any candidate-specific scope analysis.

## 2026-06-28 Echo/Similarity Follow-Up

The incomplete-migration scope-hint notes remain accurate. The latest
`similar.ts` and `diff-gate.ts` edits only avoid wasted echo/similarity work for
non-callable or non-function-like symbols; scope labels, scope reasons,
ordering, CLI rendering, and remediation text are unchanged.

## 2026-06-28 Source-Fallback Scan-Limit Follow-Up

The incomplete-migration scope-hint notes remain accurate after bounded
source-shape fallback. The new `similar.ts` behavior only applies scan-limit
budgeting to lexical fallback for bounded targeted similarity callers; scope
labels, scope reasons, ordering, CLI rendering, and remediation text are
unchanged.

## 2026-06-28 Source-Fingerprint Cache Follow-Up

The incomplete-migration scope-hint notes remain accurate after targeted
source-token fingerprints became persistent evidence. The new `similar.ts`
cache is used by lexical fallback for echo/similar probes, not by
incomplete-migration scope labeling, ordering, CLI rendering, or remediation
text.

## 2026-06-28 Diff-Gate Co-Change Follow-Up

The incomplete-migration scope-hint notes remain accurate. The latest
`diff-gate.ts` change only lets co-change partner detection see raw git changed
paths and does not change scope labels, ordering, CLI rendering, or remediation
text.

## 2026-06-28 Focused Co-Change History Follow-Up

The incomplete-migration scope-hint notes remain accurate. The focused
co-change history optimization only changes the git-history input used by
diff-gate's co-change partner check; scope labels, ordering, CLI rendering, and
remediation text are unchanged.

## 2026-06-28 Zero-Callee Similarity Follow-Up

The incomplete-migration scope-hint notes remain accurate after the latest
`similar.ts` optimization. The zero-callee shortcut only affects targeted
echo/similar source fallback, and the source-fingerprint cache-hit line-split
avoidance does not change scope labels, ordering, CLI rendering, or remediation
text.

## 2026-06-28 Bench Profiling Follow-Up

The incomplete-migration scope-hint notes remain accurate after adding
`similar.ts` profile spans. The spans are measurement-only and do not change
scope labels, ordering, CLI rendering, or remediation text.
