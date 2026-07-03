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

### K1 evidence (commit 9ce51c52)

Default-path invariant proof: `node dist/cli.js health --json` run at HEAD (pre-K1, source
temporarily reverted via `git show HEAD:<path> >` targeted copies, not `git checkout`) and at the
K1 commit are **byte-identical** (`cmp` exit 0). Mixed fixture (`tests/symbols/definition-catalog.test.ts`,
`Widget` class: constructor + method as primary rows, `count` field as a fallback-only mention
row) proves the default call returns exactly `[constructor, bump]` and the opted-in call
additionally returns `Widget#count.` with its mention-derived range. Revert probe witnessed: sed
reverting `isPreciseMixedFallbackRow`'s opt-in branch back to `return false` reproduces the
pre-fix failure on the opted-in test only; all other tests stay green.

### K2 evidence (commit 96d2d82d)

Baseline failure (captured before the change, `dist/cli.js` built from the pre-K2 source):

```
error: no mutable state discovered in src/runtime/watch.ts — the static write scan found no writes
to top-level variables, no top-level let declarations exist, and no class instance-field
definitions were exposed for this file at all. This is a known catalog boundary, ...
```

Live proof after the change (`node dist/cli.js tla scaffold src/runtime/watch.ts --out
.tmp-scaffold-watcher --json`): scaffold now discovers all 26 of `Watcher`'s instance fields and
10 state-writing actions. Discovered variables (sorted):

```
changedFiles, clojureConfigPath, config, cooldownTimer, debounceTimer, dirty, extraIgnore,
fsWatchers, gitignoreFilter, gitPollTimer, indexerConcurrency, languages, lastGitState,
lastReindexEnd, onError, onReindexComplete, onStatus, pendingTrigger, pnpmWorkspaces,
projectRoot, reindexInFlight, status, stopped, typescriptProjectMode, typescriptProjects,
watchConfig
```

Discovered actions: `_constructor_`, `Start`, `Stop`, `ScheduleReindex`, `TriggerReindex`,
`SetStatus`, `ClearDebounceTimer`, `ClearCooldownTimer`, `StartGitStatePolling`, `PollGitState`,
`ClearGitPollTimer`. Revert probe witnessed: sed reverting the `getDefinitionsForFile` call back
to no options reproduces the new "discovers instance fields that are indexed only as fallback
mentions" test failure (`no mutable state discovered in src/lock.ts ...`); the 5 pre-existing
scaffold tests (including the P5.7 per-class scoping / no-cross-contamination fixture) stay green
throughout.

## K3 survey — other catalog consumers

Investigated by reading each consumer's source and, where the code path allowed it, by running the
actual `scip-query` command against this repo's own index against `Watcher` (`src/runtime/watch.ts`,
26 instance fields, methods/constructor already primary-indexed — the exact shape K1/K2 target).

- **`members`** — **would clearly improve.** `members` calls `ProjectIndex.definitionsForFile`
  → `getDefinitionsForFile(db, file)` with no options (`src/queries/navigation/members.ts:28`), so
  it inherits the file-wide fallback-drop directly. Live: `scip-query members Watcher` today lists
  all 14 methods and **zero** of Watcher's 26 fields — the same gap K2 just fixed for scaffold.
  Opting `members` in would surface every field alongside methods, which is exactly what a
  "members of this class" query should show. No degrade risk identified: `members` already
  dedupes/sorts by range and the merge is keyed by symbol, so no existing row could be pushed out.

- **`refs`** — **neutral / already unaffected**, but for a reason worth recording precisely:
  `refs` never calls `getDefinitionsForFile` (confirmed by grep — `src/queries/navigation/refs.ts`
  only calls `findFirstSymbolMatch` and `referenceSitesForSymbol`). Symbol _resolution_ for a
  concrete pattern goes through `exactSymbolRows`/`pathQualifiedSymbolRows`/`fuzzySymbolResolution`
  in `symbol-lookup.ts`, none of which apply the catalog's _file-wide_ "any primary row exists"
  policy — `exactSymbolRows` merges primary/fallback scoped to one symbol at a time (so
  `primary.length` is 0 for a field-only symbol and the drop-filter never engages), and
  `pathQualifiedSymbolRows` passes an empty array as `primary` to `mergeMixedSymbolQueryRows`,
  which bypasses the filter outright. Live: `scip-query refs 'watch.ts/Watcher#dirty' --json`
  already returns 21 reference sites (including the definition site) today, unaffected by K1. The
  one place `refs` does touch the catalog is `hydrateSymbolMatch` (via `findFirstSymbolMatch`),
  used only to try to upgrade the resolved match's range — since class-member rows are never
  AST-corrected either way (`correctTopLevelTermRangeFromSource` returns early whenever
  `parentTypeName !== null`), the opted-in and un-opted-in ranges are identical, so opting `refs`
  in would change nothing observable.

- **`trace`** — **neutral, same reasoning as `refs`**, with the added observation that the
  definition range `trace` shows for a class field is already coarse _today_, independent of K1:
  `scip-query trace 'watch.ts/Watcher#dirty' --json` resolves correctly right now and reports
  `startLine: 0, endLine: 109` (the whole top of the file, since the field's own definition mention
  sits in a ~110-line chunk and the catalog only AST-corrects `parentTypeName === null` terms). K1
  does not change this — the chunk is exactly as coarse via the opted-in fallback row as via the
  raw pre-hydration row `trace` already falls back to. Opting `trace` in would be a no-op for its
  current code paths; genuinely tightening class-field ranges would require teaching
  `correctDefinitionRangesFromAst`/`correctTopLevelTermRangeFromSource` to handle
  `parentTypeName !== null` terms, a separate change from K1.

- **`health`** — **neutral-to-risky today, confirmed neutral by the K1 byte-identity proof itself**
  (`health --json` cmp'd byte-identical before/after K1, since nothing in the aggregation opts in).
  `health` aggregates ~15 sub-detectors (`dead`, `isolated`, `cycles`, `similar`,
  `duplicateBodies`, `twinDrift`, the React/Vue duplicate/hook detectors, `extractCandidates`,
  `wrapperCandidates`, `passthroughCandidates`, `staleAbstractions`, `drift`,
  `complexityHotspots`, `stats`, `coChange`). None of them currently has a notion of a "class
  field" finding, so opting the shared catalog in for health's own use would mostly add rows no
  detector reads — noise, not improvement. One specific _risk_, not just noise, is worth flagging:
  `wrapperCandidates`'s `attributeCallerDefinition` (`src/queries/cleanup/wrapper-candidates.ts:265`)
  calls `findEnclosingDefinition(callerDefs, refinedLine)` to attribute a call site to its
  enclosing caller function, which picks the _smallest-span_ definition containing that line. Class-
  member fallback rows carry uncorrected, chunk-derived ranges (verified live: `Watcher#dirty`'s
  fallback range is lines 0-109, but chunking elsewhere in the codebase could just as easily be
  narrow) — if a field's fallback range ever ends up smaller than its enclosing method's corrected
  range at the same call site, opting `wrapperCandidates` in could misattribute the call to the
  field symbol instead of the real caller method. Any future opt-in for this detector needs that
  case checked, not assumed safe by analogy with `members`.

- **`dead`/cleanup family** — **neutral today, with one identified two-part gap and one identified
  degrade risk.** `dead`'s main sweep (`src/queries/cleanup/dead.ts:226`) calls
  `getScopedDefinitionsMatchingSymbols(db, { sqlPrefilter: 'callable' })` — the SQL prefilter
  (`symbolSqlPredicate` in `definition-catalog.ts`) only matches symbols shaped `%().` / `%()`,
  which excludes every field (`.`-suffixed term) _before_ the fallback-drop policy even runs.
  `cleanup-plan.ts`'s `resolveDefinition` (line 175) requires an INNER JOIN to
  `defn_enclosing_ranges`, so it can never resolve a field-only symbol either. Net effect: today,
  "dead field" is not a concept either command can produce, so K1 changes nothing for the
  callable-scoped sweep itself — opting in is _necessary but not sufficient_ for a future
  "unused/write-only class field" detector; the SQL prefilter would also need a `'field'` (or
  similar) option. Degrade risk found in `cleanup-plan.ts`'s `buildBatch` "file emptied" check
  (line 211): it calls `getDefinitionsForFile(db, file)` with no options to decide whether every
  definition in a file is covered by the batch's removed ranges. If this call opted in, a file
  whose only remaining content after a dead-method removal is a still-referenced field declaration
  would correctly stop being reported as "emptied" (arguably a _correctness fix_, not a
  regression) — but it is a behavior change worth flagging explicitly rather than folding into a
  blanket opt-in, since "conservatively assumes non-empty" is the safer default for a destructive
  cleanup plan and deserves its own test rather than inheriting K1 silently.

No behavior change was made for any of these five in this plan — this is the input for a future,
separately-scoped decision.

## Closeout

Full gates; failing-test-first with revert probes; one commit per item; followup #16 updated to
RESOLVED-for-scaffold with the K3 survey noted as the remaining decision;
`scip-query reindex && scip-query diff-gate` — fix or justify.
