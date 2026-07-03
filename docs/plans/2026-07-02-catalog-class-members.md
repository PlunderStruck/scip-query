# Catalog class-member visibility (followup #16 residual) — 2026-07-02

`getDefinitionsForFile`'s row policy (`isPreciseMixedFallbackRow` in
`src/symbols/symbol-row-policy.ts`) drops every class-member fallback row whenever the file has
any primary-indexed definition — true for any class with a constructor or named method. Net
effect: `tla scaffold` reports "no mutable state discovered" on exactly the concurrency-class
shapes (locks, pools, watchers) most worth modeling; verified live on `Watcher`
(src/runtime/watch.ts, 14 methods, 20+ written fields, zero surfaced).

The original assessment ("fixing the catalog is repo-wide blast radius — members/refs/trace/
health all depend on it") stands. The plan therefore does NOT change default catalog behavior.

## K1 — additive opt-in: `includeClassMemberFallbacks`

- **Where**: `src/symbols/definition-catalog.ts` (`getDefinitionsForFile`),
  `src/symbols/symbol-row-policy.ts` (`isPreciseMixedFallbackRow`).
- **Change**: `getDefinitionsForFile(db, file, { includeClassMemberFallbacks: true })` — when
  set, class-member fallback rows (SCIP `ClassName#field.` symbols with real definition
  mentions) are retained even when primary-indexed definitions exist in the file, deduplicated
  against primary rows by symbol. Default (absent/false) is byte-for-byte current behavior —
  lock that with a test asserting the default result set is unchanged on a mixed fixture.
- **Fixture**: mixed file (class with constructor + methods + written instance fields): default
  call returns today's rows exactly; opted-in call additionally returns the `#field.` rows with
  correct ranges.

## K2 — scaffold consumes it

- **Where**: `src/tla/scaffold.ts` — the class-instance-field discovery fallback (P5.7) that
  currently sees only what the filtered catalog returns; its thrown "no mutable state" error
  documents this boundary.
- **Change**: scaffold's class-field discovery path calls the catalog with
  `includeClassMemberFallbacks: true`. Per-class scoping and the same-named-fields
  cross-contamination guard (P5.7 fixture) must keep passing. Update the error text and the
  skill's "Known boundary" paragraph (skills/scip-tla-model-system/SKILL.md — the class-fields
  boundary shrinks to: files where the indexer emitted no member rows at all).
- **Validation (the live proof)**: `scip-query tla scaffold src/runtime/watch.ts` on THIS repo
  must now discover Watcher's instance fields (record the discovered variable list in this
  file); before the change it throws "no mutable state discovered".

## K3 — survey, don't ship, wider consumption

- **Change**: a written survey (appended to this file) of the other catalog consumers
  (`members`, `refs`, `trace`, `health`, `dead`/cleanup family): for each, whether opting into
  class-member fallbacks would improve or degrade its output, with one concrete example each.
  NO behavior change for any of them in this plan — the survey is the input for a future
  decision.

## Closeout

Full gates; failing-test-first with revert probes; one commit per item; followup #16 updated to
RESOLVED-for-scaffold with the K3 survey noted as the remaining decision;
`scip-query reindex && scip-query diff-gate` — fix or justify.
