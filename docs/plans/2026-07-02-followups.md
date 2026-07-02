# Follow-ups from the 2026-07-01 external calibration (Plan 3, step 21.2)

Compact list of everything the two calibration reports flagged that is NOT covered by
remediation 21.2a-g. Each item: problem statement + report citation. Not a full plan — pick one
up, write a real plan section (`concrete-plan`), and implement independently.

1. **RESOLVED (2026-07-02, remediation 23.1). Import-type-only consumers falsely flagged
   dead/unused (Stable, HIGH).** Root cause was NOT a general "type-only imports are invisible"
   gap: raw SCIP evidence showed scip-typescript emits real cross-file mention rows for type-only
   imports when the specifier is *relative*; it emits none when the specifier is an unresolved
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

4. **`vue-large-view-pressure` blind to delegated-composable architecture (Stable).** The
   detector counts template + inline/external `<script>` LOC but stops at the immediate
   `src="..."` file; it never follows a second hop into a composable the script delegates
   `setup:` to. 0/0 findings on Stable despite `complexity-hotspots` independently surfacing five
   500-1,300 LOC `useXViewController` composables backing exactly the views this detector should
   have caught.
   Source: `docs/validation/2026-07-01-external-calibration-stable-management.md` §6, item 3.

5. **`similar`: sibling-helper fingerprint saturation (Vega).** Callee-fingerprint similarity
   saturates to 1.0 when a file has a small shared-helper vocabulary — the top-scored Vega pair
   (`fuzzMultipartRawAndSse` vs `fuzzSecondaryApi`) was unrelated fuzz scenarios that merely
   shared 4 generic helpers. Needs a cap/discount on similarity contributed by callees shared with
   many same-file siblings.
   Source: `docs/validation/2026-07-01-external-calibration-vega.md` §3 ("Failure modes
   observed", `similar` bullet).

6. **`analysisBudget` disclosure only wired into `diff-gate` (Vega).** `commandAnalysisBudget` is
   only consumed by `src/runtime/query-commands/impact.ts` (diff-gate); every standalone battery
   command (`drift`, `duplicate-bodies`, `co-change`, etc.) ran uncapped on a 188k-symbol index
   with no budget-disclosure key in its JSON. Either wire the disclosure into every large-index
   command or document that the contract is diff-gate-only.
   Source: `docs/validation/2026-07-01-external-calibration-vega.md` §1 ("Analysis-budget
   disclosure at this index size").

7. **`twin-drift` delegation-chain exclusion (Vega; explicitly deferred by 21.2b).** Beyond the
   `<constructor>` and test-file exclusions already shipped in 21.2b, `twin-drift` still
   systematically flags controller→service→storage delegation chains (thin `jsonHandler`
   delegates vs. their implementation) as same-name twins — not a real drifted-concept pair.
   Source: `docs/validation/2026-07-01-external-calibration-vega.md` §3 (`twin-drift` bullet) and
   §5 (verdict, item 2); this assignment's brief explicitly named it out of scope for 21.2.

8. **Hub-file `doc-reference` cascade damping (Stable).** One heavily-cited file
   (`shared/src/contracts/endpoints.ts`) accounts for 36 of 107 `doc-reference` findings across
   Stable's 15-commit retro-gate sample (4 separate commits, ~9-13 near-identical findings each),
   almost all against generic policy-statement citations. 21.2d's line-anchor/deletion severity
   split reduces this class's blocking weight but does not deduplicate repeated hub-file citations
   across commits or within one gate run — a per-hub-file finding cap or citation-cluster collapse
   is still open.
   Source: `docs/validation/2026-07-01-external-calibration-stable-management.md` §4 ("Hub-file
   cascade") and §6, item 5.

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

16. **PARTIALLY RESOLVED (2026-07-02, remediation P5.7) — implemented, deeper boundary found and
    documented.** scaffold.ts now falls back to class instance-field discovery when no top-level
    module state exists, scoped per class (a fixture proves same-named fields on unrelated classes
    never cross-contaminate) with qualified `file/Class#member` codeRefs. The original "may not
    [expose the definitions]" uncertainty is resolved in the RAW-data sense — SCIP does emit
    `ClassName#field.` symbols with real definition mentions (verified live: `ScipDatabase#pathFilter`/
    `#config` in this repo's own index) — but `getDefinitionsForFile` (the catalog nearly every command
    depends on) never surfaces them on a typical class: `symbol-row-policy.ts`'s
    `isPreciseMixedFallbackRow` drops every class-member fallback row whenever the file has any
    primary-indexed definition, true for any class with a constructor or named method. Verified live:
    `Watcher` (src/runtime/watch.ts, 14 methods, 20+ written fields) surfaces zero fields to scaffold.
    The discovery algorithm itself is correct and tested against the shape the catalog would produce
    absent that filter; fixing the catalog is a separate, repo-wide-blast-radius change (members, refs,
    trace, health all depend on it), out of scope here — documented precisely in scaffold's thrown
    error and the skill's Choose the Slice section, per this item's own "otherwise document the
    boundary" escape hatch. Cross-process state (the other half of this item, e.g. lock-file-owner
    identity as distinct from filesystem *content* already covered by #13) was not separately pursued
    — no dogfood case in this session needed it beyond what #13's resource binding already covers.
    Source: docs/plans/2026-07-02-tla-static-coverage.md P5.7.
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

