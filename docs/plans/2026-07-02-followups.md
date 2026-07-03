# Follow-ups from the 2026-07-01 external calibration (Plan 3, step 21.2)

Compact list of everything the two calibration reports flagged that is NOT covered by
remediation 21.2a-g. Each item: problem statement + report citation. Not a full plan — pick one
up, write a real plan section (`concrete-plan`), and implement independently.

1. **RESOLVED (2026-07-02, remediation 23.1). Import-type-only consumers falsely flagged
   dead/unused (Stable, HIGH).** Root cause was NOT a general "type-only imports are invisible"
   gap: raw SCIP evidence showed scip-typescript emits real cross-file mention rows for type-only
   imports when the specifier is _relative_; it emits none when the specifier is an unresolved
   tsconfig `paths` alias (`@/...`, this codebase's actual shape) — confirmed on the live
   Stable_Management clone. The compensating source-fallback layer
   (`sourceImportPathsByLocalName` -> `resolveImportPath`) had never implemented alias resolution
   at all, so it couldn't cover the gap either. Fixed `resolveJavaScriptImportPath` to resolve
   tsconfig `paths` aliases (handling the common Vite/vue-tsc solution-style-tsconfig-shell
   shadowing case too), shared by `dead`/`isolated`/`new-dead`/`stale-abstractions`/
   `production-callables`/`refs`. Live: `OrgMember`/`OrgInvite`/`OrgAssignment` no longer appear
   in `stale-abstractions` output at all; `refs OrgMember` went from 2 (self-file only) to 49
   references across its real consumers.
   Source: `docs/validation/2026-07-01-external-calibration-stable-management.md` §6 ("Worst
   false positives", item 1).

2. **MOSTLY RESOLVED (2026-07-02, remediation 23.2). pnpm-workspace cross-package consumers
   falsely flagged dead (Vega, HIGH).** Re-ran with `pnpm install` per this item's own protocol:
   the raw-index gap is genuinely indexer-shaped, identical with and without `node_modules`
   present (not solely — or even mainly — an artifact of the missing install the original
   calibration ran without). Fixed at the same source-fallback layer: `resolveJavaScriptImportPath`
   now resolves workspace-package specifiers (`@vega/shared/contracts`) via `pnpm-workspace.yaml`
   discovery and the package's `exports` map, rewriting an unbuilt `dist/` target to the indexed
   `src/` equivalent. Also found and fixed a latent bug this exposed: `diffImpactPartial`'s
   zero-fan-in filter treated "no SCIP mention row at all" as ineligible for semantic/fallback
   enrichment (`undefined !== 0`), silently starving both tiers for exactly this archetype; fixed,
   and wired a third source-fallback tier into `new-dead`'s fan-in computation (it previously had
   none). Live on the exact cited commits: 40->0 and 15->4 `new-dead` findings. **Residual gap**:
   a symbol with an ambiguous leaf name (same name defined elsewhere) reached only through a
   re-exporting barrel file still misattributes — `attributeIdentifier`'s strict same-file import
   match doesn't bridge the barrel hop. `new-dead` now labels that specific shape
   `unconfirmed (cross-package ambiguous-name resolution gap)` (`evidence: "heuristic"`, lowered
   confidence) instead of asserting `dead` (remediation 23.4). Re-export-chain-aware
   disambiguation is a real follow-up, not required to close this item further this release.
   Source: `docs/validation/2026-07-01-external-calibration-vega.md` §4 (gate precision table,
   `new-dead` row) and §7 ("Caps and deviations").

3. **RESOLVED, already fixed pre-session (2026-07-02, remediation 23.3 — verification only, no
   code change). Vue `<script setup>` composable consumer linkage gaps (Stable, HIGH).** Live
   re-check against the exact cited commit (`5eeacef38`) found `useHorseReportPrintView` and
   `usePublicInvoicePrintView` both correctly resolved (`refs` finds their `.vue` consumer;
   `diff-gate` on that commit now reports 0 `new-dead`, was 2). Neither composable uses a
   tsconfig-aliased import, so this predates and is independent of remediation 23.1 — most likely
   landed via prior Vue-SFC-scanning work between the 2026-07-01 calibration and this session
   (`git log --oneline --all | grep -i vue`: `df7f77c2`, `480278f2`, `a2bf44ac`). Locked in with a
   regression fixture (`tests/queries/cleanup/dead-vue-script-setup.test.ts`).
   Source: `docs/validation/2026-07-01-external-calibration-stable-management.md` §6, item 2.

4. **RESOLVED (2026-07-02, followup-batch). `vue-large-view-pressure` blind to
   delegated-composable architecture (Stable).** The detector counts template + inline/external
   `<script>` LOC but stops at the immediate `src="..."` file; it never follows a second hop into
   a composable the script delegates `setup:` to. 0/0 findings on Stable despite
   `complexity-hotspots` independently surfacing five 500-1,300 LOC `useXViewController`
   composables backing exactly the views this detector should have caught.
   Source: `docs/validation/2026-07-01-external-calibration-stable-management.md` §6, item 3.
   Fix: `src/source/vue/vue-profile.ts` — `VueComponentBehaviorProfile` gained
   `delegatedComposableLines`/`delegatedComposablePaths`, computed by
   `resolveDelegatedComposables` (`vue-profile.ts:161-177`): for each `use*` name the setup script
   actually _invokes_ (`scriptFacts.composables`, already invocation-filtered — an imported-but-
   unused composable doesn't count), find its matching import and resolve the specifier via the
   shared `resolveImportPath` (handles both inline `<script setup>` and external `<script src>`,
   since `VueScriptImportFact.sourcePath` already points at whichever one the import statement
   lives in), then sum the resolved file's LOC. One hop only by construction — the composable
   file's own imports are never inspected. Kept as new fields rather than folded into the existing
   shared `totalLines` (used by `vue-composable-candidates`/`vue-component-duplicates` for a
   different purpose) to avoid changing those detectors' behavior; only
   `src/queries/frontend/vue-large-view-pressure.ts` opts in, folding
   `delegatedComposableLines` into its `total` pressure axis and reported `totalLines`.
   Test: `tests/queries/frontend/vue-large-view-pressure-delegation.test.ts` — a small view
   delegating to a 900-line `useHorseReportViewController.ts` now fires (verified the assertion
   fails without the fix, by temporarily short-circuiting `resolveDelegatedComposables` to
   `{lines:0,paths:[]}`); the same view without delegation stays at 0 findings; a view that
   imports but never calls the composable also stays at 0 findings.

5. **RESOLVED (2026-07-02, followup-batch). `similar`: sibling-helper fingerprint saturation
   (Vega).** Callee-fingerprint similarity saturates to 1.0 when a file has a small shared-helper
   vocabulary — the top-scored Vega pair (`fuzzMultipartRawAndSse` vs `fuzzSecondaryApi`) was
   unrelated fuzz scenarios that merely shared 4 generic helpers. Needs a cap/discount on
   similarity contributed by callees shared with many same-file siblings.
   Source: `docs/validation/2026-07-01-external-calibration-vega.md` §3 ("Failure modes
   observed", `similar` bullet).
   Fix (chosen formula: exclude, not discount — see constraint comment at
   `src/queries/cleanup/similar.ts:1000` next to `SAME_FILE_SIBLING_SATURATION_THRESHOLD`):
   a callee called by >= 5 distinct same-file siblings is dropped from every fingerprint in that
   file (`trimSameFileSiblingSaturatedCallees`) _before_ corpus-wide IDF weighting or the
   `minCallees` floor ever sees it — global IDF already discounts callees common across the whole
   corpus, but can't see same-file-only ubiquity (a helper only ever called from within one file
   can have a low, positive global document frequency while still being 100% of that file's
   internal vocabulary). Applied at both entry points: the bulk `similarAll` corpus build
   (`buildCalleeFingerprints`) and the single-symbol `similar <symbol>` lookup's ad hoc target
   fingerprint (`trimTargetSameFileSiblingSaturatedCallees` in `compareAgainstFingerprints`, since
   `findCallees`'s target isn't part of the trimmed corpus). Test:
   `tests/queries/cleanup/similar-sibling-saturation.test.ts` — a pure test on
   `trimSameFileSiblingSaturatedCallees` proving the exact drop/keep boundary; a pure
   trim-\>index-\>compare pipeline test (padded corpus so IDF isn't degenerately zero) showing the
   saturated fuzz-scenario pair drops out of candidacy entirely while a genuine
   4-shared-helper near-duplicate pair (only 2 same-file callers) still scores >= 0.9; a db-backed
   `similarAll` test reproducing the exact calibration shape (5 same-file fuzz scenarios sharing 4
   helpers), verified to score 1.0 and get reported without the fix, and correctly suppressed with
   it. Fixing this also exposed and required repairing an unrelated pre-existing test
   (`tests/queries/health/health-full.test.ts`) that had (unintentionally) been relying on the
   exact same-file-saturation bug as its fixture mechanism for an unrelated scanLimit-capping
   assertion — moved its 16 caller symbols to one document each so the new rule doesn't engage,
   preserving the original 50/56 pair-count assertions.

6. **RESOLVED (2026-07-02, followup-batch). `analysisBudget` disclosure only wired into
   `diff-gate` (Vega).** `commandAnalysisBudget` is only consumed by
   `src/runtime/query-commands/impact.ts` (diff-gate); every standalone battery command (`drift`,
   `duplicate-bodies`, `co-change`, etc.) ran uncapped on a 188k-symbol index with no
   budget-disclosure key in its JSON. Either wire the disclosure into every large-index command or
   document that the contract is diff-gate-only.
   Source: `docs/validation/2026-07-01-external-calibration-vega.md` §1 ("Analysis-budget
   disclosure at this index size").
   Decision + evidence: the premise was stale. `commandAnalysisBudget` already flows through a
   shared JSON-envelope seam — the `budgeted*Command` family in
   `src/runtime/commands/command-execution.ts` (`budgetedDbCommand`, `budgetedListCommand`,
   `budgetedTableCommand`, `budgetedReportCommand`, `budgetedGroupedByFileCommand`,
   `budgetedSectionedReportCommand`), all piping `budget.analysisBudget` into `printJsonEnvelope`'s
   `extra.analysisBudget` key — and at HEAD it already covers ~30 commands including `drift`
   (`handleDrift`, `cleanup/handlers.ts:469`) and `duplicate-bodies`
   (`handleDuplicateBodies`, `cleanup/handlers.ts:553`); grep evidence:
   `grep -n "= budgeted" src/runtime/query-commands/**/*.ts`. The one genuinely open gap among the
   item's own named examples was `co-change`, still on the plain `dbCommand`. Fixed by wiring
   `co-change` into the existing seam (not a bespoke mechanism) — `handleCoChange` now uses
   `budgetedDbCommand('co-change', ...)` (`src/runtime/query-commands/impact.ts:59-69`) — and, to
   keep the disclosure truthful rather than cosmetic, `queries.coChange` gained a real `scanLimit`
   option (`src/queries/impact/co-change.ts:90-118`) that truncates the already
   `together`-count-sorted candidate pairs before the per-pair filesystem/graph classification
   loop, since that loop (not `queries.coChange` as a whole) is what scales with index/history
   size. Commands with no candidate-count/semantic-enrichment knob (`code`, `outline`, `fan-in`,
   `fan-out`, `coupling`, `cycles`, `deep-chains`) intentionally stay off the seam — attaching
   `analysisBudget` there would disclose a cap that isn't real. Full reasoning and the up-to-date
   list of covered/excluded commands recorded in `docs/COMMAND_REFERENCE.md` ("`analysisBudget`
   disclosure contract" section, hand-authored, after the generated block).
   Test: `tests/queries/impact/co-change-partner-labels.test.ts` — "honors scanLimit by keeping
   only the highest-priority pairs (followup #6)".

7. **RESOLVED (2026-07-02, followup-batch). `twin-drift` delegation-chain exclusion (Vega;
   explicitly deferred by 21.2b).** Beyond the `<constructor>` and test-file exclusions already
   shipped in 21.2b, `twin-drift` still systematically flags controller→service→storage delegation
   chains (thin `jsonHandler` delegates vs. their implementation) as same-name twins — not a real
   drifted-concept pair.
   Source: `docs/validation/2026-07-01-external-calibration-vega.md` §3 (`twin-drift` bullet) and
   §5 (verdict, item 2); this assignment's brief explicitly named it out of scope for 21.2.
   Fix: `src/queries/cleanup/twin-drift.ts`. Each `TwinDriftRecord` now carries a structural
   `isThinForwarder` flag (`isThinForwarderBody`, source-text-only: at most two top-level
   statements, no branching/looping, last statement is a single optionally
   `return`ed/`await`ed call expression). `groupTwins` takes an injected `isDelegatePair(from, to,
clusterMembers)` predicate and skips a cross-file pair entirely (not merely excludes it from
   similarity scoring) when either side delegates to the other — so a cluster whose only cross-file
   pair is a delegation chain produces no group at all. `allTwinGroups` wires the real
   `buildDelegationChecker`, which resolves the call target from source facts
   (`getCallSites`/`getSourceImports`) rather than the general call graph
   (`getCalleeRowsForSymbol`): the general call-graph attribution path
   (`pickAstCallCandidate` in `src/symbols/leaf-symbol-index.ts`) prefers a same-file
   same-leaf-name candidate and treats that as self-recursion, which is _always_ true for this
   exact shape (every twin-cluster member shares its own file's leaf name), so it silently reports
   zero callees for exactly the calls this check needs — confirmed live with a debug script before
   switching approaches. Chains up to 3 hops through other `isThinForwarder` cluster members.
   Test: `tests/queries/cleanup/twin-drift.test.ts` — two pure `groupTwins` tests with an injected
   `isDelegatePair` fake, plus a real db-backed integration test (`twinDrift (db-backed) —
delegation-chain exclusion`) using real TypeScript source files and an actual namespace-import
   delegate call, asserting zero findings; the pre-existing `escapeRegex`/`escapeRegExp` db-backed
   test (no call relationship) continues to assert a `divergent` finding, covering the
   "genuinely divergent, no delegation" side. Verified both new tests fail without the skip
   (temporarily disabled the guard, confirmed 2 failures, restored).

8. **RESOLVED (2026-07-02, followup-batch). Hub-file `doc-reference` cascade damping (Stable).**
   One heavily-cited file (`shared/src/contracts/endpoints.ts`) accounts for 36 of 107
   `doc-reference` findings across Stable's 15-commit retro-gate sample (4 separate commits, ~9-13
   near-identical findings each), almost all against generic policy-statement citations. 21.2d's
   line-anchor/deletion severity split reduces this class's blocking weight but does not
   deduplicate repeated hub-file citations across commits or within one gate run — a per-hub-file
   finding cap or citation-cluster collapse is still open.
   Source: `docs/validation/2026-07-01-external-calibration-stable-management.md` §4 ("Hub-file
   cascade") and §6, item 5.
   Fix: `src/queries/impact/diff-gate.ts`. `runDocReferenceCheck` now builds all per-doc citation
   drafts first (`buildDocReferenceFindingDraft`), then `clusterDocReferenceFindings` groups them
   by the cited hub file (`rootCauseKey`). A group at or under
   `DOC_REFERENCE_HUB_FILE_EXEMPLAR_LIMIT` (3) passes through untouched — matches "distinct-file
   citations must be untouched." A group over the limit collapses into one clustered finding
   (`clusterDocReferenceCitations`) carrying `citationCount` (total citing docs), up to 3
   `citationExemplars` (sorted deterministically), and an explicit `suppressedCount` — never silent
   (the suppressed docs' original finding ids stay reachable via `memberFindingIds`; review pass
   moved them off `legacySuppressionIds`, which suppression matching honors — reusing it would have
   let one pre-clustering per-doc suppression silently suppress the entire cluster). Chosen
   formula: the ledger's brief gave two illustrative numbers ("up to 3 exemplar citations" /
   "cap at a sane number, e.g. 5") for what reads as one constraint; 3 (the unambiguous, literal
   one) is used as both the exemplar limit and the clustering trigger threshold, documented at the
   constant's declaration. A blocking (non-advisory) citation anywhere in a cluster keeps the whole
   clustered finding blocking — damping never silently downgrades an actionable citation. Every
   doc-reference finding (clustered or not) also gets `groupKey`/`rootCauseKey` set to the hub
   file, reusing the existing `diffGateRootCauseGroups` root-cause-rollup mechanism the codebase
   already has for twin-partner/co-change-partner/coverage-contract findings — the same shared
   pattern `src/tla/conformance.ts:59` mirrors from the diff-gate side, so no cross-boundary import
   was needed. Test: `tests/queries/impact/doc-reference-hub-cascade.test.ts` — 12 docs citing one
   hub file collapse to exactly 1 finding with `citationCount:12`, 3 exemplars,
   `suppressedCount:9` (verified the assertion fails without the fix, temporarily short-circuiting
   `clusterDocReferenceFindings` to identity); a second test with 2 docs citing 2 distinct files
   confirms both stay individual, unclustered.

9. **RESOLVED (2026-07-02, followup-batch). Clojure capability status asserted-though-true
   (claim-audit dry-run).**
   `sourceFactCapability` (`src/runtime/project-readiness.ts:307-353`) probes every language
   branch via `runtimeProbe?.(language) ?? defaultRuntimeProbe(language)` except the Clojure
   branch (lines 317-322), which hardcodes `status: 'available'` without ever calling
   `probeAstLanguageRuntime` — which itself returns `'unavailable'` for `lang === 'clojure'`, a
   result this code path never consults. Agent-facing (surfaces via `capabilities`/
   `capability-matrix --json`) and trust-bearing (a false "available" over-trusts Clojure
   source-fallback evidence).
   Source: `docs/plans/2026-07-01-remediation-3-detection-primitives-and-lens-skills.md`,
   "Deviations from plan anchors" note for step 19.3.
   Fix: the Clojure branch (`src/runtime/project-readiness.ts:317-329`) now calls
   `runtimeProbe?.(language) ?? defaultRuntimeProbe(language)` like every other branch and derives
   `status` from the result (`'unavailable'` probe -> `'unavailable'` status) instead of hardcoding
   `'available'`. Root cause of the always-false probe: `probeAstLanguageRuntime`
   (`src/source/ast/ast-runtime.ts:36-37`) hardcoded `'unavailable'` for Clojure even though
   Clojure's source facts come from a hand-rolled reader (`src/source/clojure-facts.ts`,
   `src/language-parsers/languages/clojure.ts`) with no tree-sitter/native dependency to probe for
   — fixed to return `'reader'` (truthful: always present, matches the existing but previously
   unreachable `probe === 'reader'` branch in `sourceFactCapability`). Also added
   `clojure: 'clojure'` to `AST_LANGUAGE_BY_SUPPORTED_LANGUAGE`
   (`src/runtime/project-readiness.ts:88-102`) so `defaultRuntimeProbe` actually dispatches to
   `probeAstLanguageRuntime('clojure')` instead of short-circuiting through the regex-only branch.
   Test: `tests/runtime/project-readiness.test.ts` — "derives Clojure source-fact status from the
   runtime probe instead of asserting it (followup #9)", witnessed both ways via a stubbed
   `runtimeProbe`.

10. **RESOLVED (2026-07-02, remediation 24.1).** tla tool-runner classified SIGTERM-at-timeout TLC
    runs (exit 143, timedOut false) as `failed` instead of `timed-out`. Fixed: `src/tla/tool-runner.ts:115`
    treats SIGTERM at/after the requested boundary as timed-out.
11. **RESOLVED (2026-07-02, remediation 24.x).** `tla verify` now accepts `--timeout-ms <n>`
    (`src/runtime/query-commands/tla.ts:369`), threaded to TlaToolRunOptions.timeoutMs.
12. **RESOLVED (2026-07-02, remediation P5).** verify output now emits root-cause finding groups by
    (category, modelElement) with 3 exemplars each (`src/tla/conformance.ts:59`); `--full` prints
    every finding ungrouped.

13. **RESOLVED (2026-07-02, remediation P5.1).** `variables.<v>.resource: {path}` binds a variable to
    filesystem state. The conformance scanner (AST + source-scan fallback, both write and read paths)
    classifies `writeFileSync`/`rmSync`/`renameSync`/`mkdirSync`/`unlinkSync` and `readFileSync`/
    `existsSync`/`statSync` calls as writes/reads of the variable when the call's first argument text
    contains the declared path — evidence tier stays `static-action`. Applied to specs/reindex-lock's
    `lockOwner` (bound to `lockPath`); one now-provable waiver deleted at this step alone (writes: 7→10
    verified). See #14 for the rest of the benchmark movement and the residual-gap accounting.
    Source: docs/plans/2026-07-02-tla-static-coverage.md P5.1.
14. **RESOLVED (2026-07-02, remediation P5.4), target partially met.** `collectAllStaticWrites`/`Reads`
    now also scan each action referent's direct callees (`callGraph(db, symbol, {semantic:false})` —
    precise call edges only, one level, no recursion) for effects on a variable the action already
    declares (the declared-fact filter is load-bearing: an unfiltered version misattributed a shared
    callee's write across actions that don't own it — undeclared-write false positives, caught by a
    regression fixture). Findings/staticWrites gain `via: <callee>`. specs/reindex-lock benchmark:
    writes 7→17 verified, 11→9 waived (target was ≤3, not fully reached). Root cause of the remaining
    gap: 7 of the 9 write waivers are `phase`, a documented pure control-flow abstraction with no
    stored field in code at all across all 7 modeled actions — no resource binding or call-hop can
    manufacture evidence for state that isn't materialized; the other 2 (Crash: external process-death
    event; Publish: released via an anonymous closure with no callable symbol) are equally unprovable
    by the same reasoning already in the mapping before this work. Reaching ≤3 would require either
    dishonestly stretching evidence or a model redesign reducing `phase`'s per-action granularity —
    out of scope for a scanner-capability step. Source: docs/plans/2026-07-02-tla-static-coverage.md
    P5.4 (commit message has the full per-waiver rationale).
15. **RESOLVED (2026-07-02, remediation P5.6).** `tla trace-check` verdicts (JSON and human) gain
    `actionCoverage`: steps-observed per mapped action, including zero-count entries for actions never
    exercised. Human mode lists unexercised actions with a classify-it pointer (pure modeling
    abstraction vs. real gap). Live-validated on specs/diff-gate's existing trace: `RunDiffGate`/
    `DecideExitCurrent` show 1 step each, `DecideExitVulnerable` (the pre-fix regression-model action
    with no real code path) correctly reports 0 — exactly the abstraction-not-reachability distinction
    this item asked for. Source: docs/plans/2026-07-02-tla-static-coverage.md P5.6.

16. **RESOLVED-for-scaffold (2026-07-02, remediation P5.7 + catalog-members K1/K2) — the catalog
    boundary this item flagged is now closed for scaffold's own consumer.** scaffold.ts falls back
    to class instance-field discovery when no top-level module state exists, scoped per class (a
    fixture proves same-named fields on unrelated classes never cross-contaminate) with qualified
    `file/Class#member` codeRefs. The original "may not [expose the definitions]" uncertainty was
    resolved in the RAW-data sense first — SCIP does emit `ClassName#field.` symbols with real
    definition mentions (verified live: `ScipDatabase#pathFilter`/`#config` in this repo's own
    index) — and the remaining catalog-level gap (`getDefinitionsForFile` dropping every
    class-member fallback row whenever the file has any primary-indexed definition, true for any
    class with a constructor or named method; verified live at the time: `Watcher`,
    src/runtime/watch.ts, 14 methods, 20+ written fields, zero surfaced) is now fixed via an
    additive, default-safe opt-in: `getDefinitionsForFile(db, file, {
includeClassMemberFallbacks: true })` (`src/symbols/symbol-row-policy.ts`,
    `src/symbols/definition-catalog.ts`; default absent/false stays byte-for-byte identical,
    proven by a `health --json` before/after `cmp`). scaffold now calls it unconditionally and
    discovers `Watcher`'s state correctly: `scip-query tla scaffold src/runtime/watch.ts` goes from
    throwing "no mutable state discovered" to discovering all 26 instance fields and 10
    state-writing actions. The remaining boundary shrinks to files where the indexer emitted no
    member row for a class at all (neither primary nor fallback) — documented in scaffold's thrown
    error and the skill's Known-boundary paragraph. Whether `members`/`refs`/`trace`/`health`/
    `dead`-cleanup should also opt in is a **separate, not-yet-decided** question — see the K3
    survey in docs/plans/2026-07-02-catalog-class-members.md for a per-consumer improve/degrade/
    neutral assessment with live examples (short version: `members` would clearly improve;
    `refs`/`trace` are already unaffected by this specific boundary through independent lookup
    paths; `health`/`dead` are neutral today with one identified misattribution risk and one
    identified two-part gap, both documented there, not fixed). Cross-process state (the other half
    of this item, e.g. lock-file-owner identity as distinct from filesystem _content_ already
    covered by #13) was not separately pursued — no dogfood case in this session needed it beyond
    what #13's resource binding already covers. Source: docs/plans/2026-07-02-tla-static-coverage.md
    P5.7; docs/plans/2026-07-02-catalog-class-members.md K1/K2/K3.
17. **RESOLVED (2026-07-02, remediation P5.2).** `variables.<v>.waive: {reason}` exempts that
    variable's `missing-referent`/`invalid-referent-kind` findings (distinct from an action's `waive`,
    which exempts read/write facts only), counted in the Waivers output and Proof line
    ("referents: N waived") like action waivers. specs/diff-gate's `stage`/`exitState` proxy-ref
    workaround (citing an unrelated real `DiffGateResult` field as a decoy just to pass the
    value-like-kind check) replaced with an honest missing-referent + variable waiver naming a plainly
    non-existent symbol. Source: docs/plans/2026-07-02-tla-static-coverage.md P5.2.
18. **RESOLVED (2026-07-02, remediation P5.3).** `loadTlaModelContract` now rejects a mapping where
    two variables share an alias or the same resource path suffix, at contract-load time (before any
    scanning), instead of silently misattributing every matching write/read to both. Source:
    docs/plans/2026-07-02-tla-static-coverage.md P5.3.
19. **RESOLVED (2026-07-02, remediation P5.7).** `unmappedWriteScope: 'actions' | 'scope-files'`
    (default `'scope-files'`, identical to prior behavior) added to the mapping schema. `'actions'`
    opts out of the whole-scope-file unmapped-write sweep entirely, relying only on the per-action
    write/read checks, for models whose `scope` legitimately contains code the mapping was never meant
    to cover in full. Source: docs/plans/2026-07-02-tla-static-coverage.md P5.7.
20. **RESOLVED (2026-07-02, remediation P5.5).** `dedupeTracePaths(projectRoot, paths)` resolves each
    trace path and keeps only the first occurrence; `contract.traces` and `--trace` naming the same
    file (relative vs. absolute, or literally repeated) no longer double-counts that file's steps in
    either `tla verify` or `tla trace-check`. Source: docs/plans/2026-07-02-tla-static-coverage.md P5.5.
21. **RESOLVED (2026-07-02, remediation P5.5).** `generateTraceSpec`/`runTraceCheck` take an optional
    `nextOperator` (default `Next`); new `tla trace-check --next <operator>` CLI flag. Proven live with
    a real-TLC e2e test: the same trace accepts under one named relation and diverges under another on
    the same spec. specs/diff-gate/DiffGateOutcome.tla drops the `Next == NextCurrent` alias workaround
    (trace-check now runs with `--next NextCurrent`); both `tla verify` configs (which SPECIFY
    CurrentSpec/VulnerableSpec directly, never a bare `Next`) are unaffected. Source:
    docs/plans/2026-07-02-tla-static-coverage.md P5.5.

## From the Vega mapping modernization (2026-07-02, post-0.11.0)

22. tla cfg `INVARIANTS` block form not parsed — **RESOLVED same day** (`81159d92`):
    `readTlaConfigInvariants` now strips cfg comments, tokenizes, and treats
    INVARIANT/INVARIANTS as synonyms with keyword-terminated sections.
23. **RESOLVED (2026-07-02, `f50e3b29`, tla-improvements I1).** Write-error conformance
    categories are unwaivable: `isFactWaived` is consulted for `undeclared-read`/
    `missing-*-evidence` only, never `model-code-write`/`undeclared-write`/`model-mapping-write`
    (src/tla/conformance.ts ~715-748). Read/write waiver asymmetry left ~470 residual noise
    findings across 5 Vega models that could not be waived with reasons. Fixed: `model-code-write`
    (src/tla/conformance.ts:748) and `undeclared-write` (src/tla/conformance.ts:765) now consult
    `isFactWaived(action, 'write', ...)`, symmetric with `missing-write-evidence`
    (src/tla/conformance.ts:781); `verifySetAgreement`'s `model-mapping-write` direction
    (src/tla/conformance.ts, `verifyModelText`'s `writes` call site) now takes an `isWaived`
    predicate backed by `mapping.waive?.writes`. A waived write still lands in the Proof line's
    waiver ledger with its reason.
24. **RESOLVED (2026-07-02, `4fda66e7`, tla-improvements I2).** SANY fact extractor does not
    expand user-defined operator references (`deriveActionFacts` in src/tla/sany-facts.ts): an
    action delegating its primes to a helper operator reports `writes: none`, forcing mappings to
    target helpers directly (worked around in Vega's GitHubWebhookIndexingPipeline mapping).
    Fixed: `deriveActionFacts` (src/tla/sany-facts.ts:151) now recursively expands
    `UserDefinedOpKindRef` references (src/tla/sany-facts.ts:188) into the referenced operator's
    own facts — bounded to `MAX_OPERATOR_EXPANSION_DEPTH` (src/tla/sany-facts.ts:112) hops,
    cycle-safe via a visited-UID set, and restricted to same-module references (matching each
    entry's own `<filename>`, src/tla/sany-facts.ts:101).
25. **RESOLVED (2026-07-02, `a164f813`, tla-improvements I3).** A variable's own name is
    force-included as an alias (`model-contract.ts:426`, `[...new Set([name, ...aliases])]`) —
    object-literal keys echoing a variable name become unavoidable false write attributions;
    there is no way to opt out. Fixed: `variables.<v>.selfAlias: false`
    (src/tla/model-contract.ts:60, parsed at src/tla/model-contract.ts:433-434) opts out of the
    force-include (default stays `true`, fully backward compatible); a `selfAlias: false` variable
    with no other alias, resource, statements, or waive is a load error naming the fix
    (src/tla/model-contract.ts:435-438).
26. **RESOLVED (2026-07-02, `0c4e8d62`, tla-improvements I4).** Minor: `const x = ...`
    declarations are scored as writes of same-named aliases by the source-scan fallback. Fixed in
    both write classifiers: the AST path's `variable_declarator` branch
    (src/tla/conformance.ts:1064) no longer records any write at all (previously tagged kind
    `'declaration'` but still counted toward action-level write facts), and the source-scan
    fallback's `isDeclarationLine` helper (src/tla/conformance.ts:240) excludes a
    `const`/`let`/`var` declaration line for the matching alias before the mutation regex runs.
    Only the declaration statement itself is excluded — a later assignment to the same binding
    (including a module-level `let` reassigned inside an action) keeps attributing.

## From the 2026-07-03 integrity-detector calibration

Noise archetypes found calibrating `not-implemented`/`decorative-checkers`/`test-quality` against
Vega_2.0 and Stable_Management (read-only) that were deliberately documented rather than chased
further — each would require expanding the detector's stated scope, not fixing a bug in it. Source
for all five: `docs/validation/2026-07-03-integrity-detector-calibration.md`.

27. **`decorative-checkers`: multi-hop delegation through a wrapping/memoizing utility.** A checker
    whose real failure path is reached through more than one call hop (e.g. an `await
    someWrapper(req, () => realAssertion(...))` shape) reads as decorative — `isThinForwarderBody`'s
    ≤2-statement, single-call shape requirement never engages one-hop resolution for it. Example:
    `assertRequestCompanionOrganizationScope`,
    `apps/api/src/middleware/access-policy-request-gateway.ts:62` (Vega_2.0).
28. **`decorative-checkers`: guard-clauses-then-delegate tail call.** 2-3 early-return guard
    statements followed by a delegating call as the LAST statement is not a single-statement
    thin-forwarder, so one-hop resolution never triggers even though the delegate is exactly one hop
    away. Examples: `assertUserLimitAllowsUserId`/`assertCanAddUser`/`assertCanAddUserByEmail`
    (`apps/api/src/services/instance-settings.service.ts:219,233,245`),
    `validateModelProfileTuning` (`apps/api/src/modules/ai-provider/ai-provider.manager.ts:1010`),
    both Vega_2.0. Fixing either 27 or 28 well means widening the delegate-target-resolution shape
    beyond `isThinForwarderBody` without also matching arbitrary multi-statement bodies that merely
    happen to end in a call — needs its own design pass, not a drive-by regex tweak.
29. **`decorative-checkers`: indirect diagnostics helper, one hop past the sink pattern.** The
    `DIAGNOSTIC_SINK_PATTERN` fix (`.addIssue(`/`.push(`) only sees the sink call in the checker's
    OWN body text; `validateCompanionClient`/`validateCompanionRedirectUri`
    (`apps/api/src/modules/auth/auth.routes.ts:67,76`, Vega_2.0) call a named helper
    (`addUnknownCompanionClientIssue(ctx)`) that itself calls `ctx.addIssue` — one more hop than the
    literal-pattern fix reaches. Same underlying shape as #27/#28; likely worth solving together.
30. **`decorative-checkers`: Effect-TS (or similar effect-system) generator bodies.** A checker
    wrapped in `Effect.gen(function* () { ... })` has its real control flow inside generator
    `yield*`/`Effect.fail` sequencing, invisible to plain throw/return pattern matching. Example:
    `assertVetFacilityBelongsToStable`
    (`backend/src/workflows/incidents.ts:262`, Stable_Management). Framework-specific; would need a
    dedicated Effect-TS-aware pass, not a general fix.
31. **`test-quality` mock-echo: designed recall ceiling, not a bug.** Every sampled Vega_2.0/
    Stable_Management mock-echo finding was a test where a stubbed value genuinely flows through
    real application logic to a derived assertion (`mockResolvedValueOnce('x')` → `expect(exposed
    .data.value).toBe('x')`), not a test asserting its own mock's literal directly. This is the
    exact trade-off the sub-check's own design named up front ("syntactic same-literal, high
    precision, low recall — do not chase dataflow"); recorded here only so the expected steady-state
    noise rate is visible to whoever next tunes `--limit` or decides whether to review mock-echo
    output routinely — not something to "fix."
