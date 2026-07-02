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

6. **RESOLVED (2026-07-02, remediation 24.5). `analysisBudget` disclosure only wired into
   `diff-gate` (Vega).** `commandAnalysisBudget` was only consumed by
   `src/runtime/query-commands/impact.ts` (diff-gate); every standalone battery command (`drift`,
   `duplicate-bodies`, `co-change`, etc.) ran uncapped on a 188k-symbol index with no
   budget-disclosure key in its JSON. Fixed by commit `8fcac514`: the `analysisBudget` disclosure
   is now emitted in the JSON of every budgeted command (health, navigation, planning, and impact
   surfaces — `src/runtime/query-commands/{health,navigation,planning,impact}.ts`).
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

9. **Clojure capability status asserted-though-true (claim-audit dry-run).**
   `sourceFactCapability` (`src/runtime/project-readiness.ts:307-353`) probes every language
   branch via `runtimeProbe?.(language) ?? defaultRuntimeProbe(language)` except the Clojure
   branch (lines 317-322), which hardcodes `status: 'available'` without ever calling
   `probeAstLanguageRuntime` — which itself returns `'unavailable'` for `lang === 'clojure'`, a
   result this code path never consults. Agent-facing (surfaces via `capabilities`/
   `capability-matrix --json`) and trust-bearing (a false "available" over-trusts Clojure
   source-fallback evidence).
   Source: `docs/plans/2026-07-01-remediation-3-detection-primitives-and-lens-skills.md`,
   "Deviations from plan anchors" note for step 19.3.

10. **RESOLVED (2026-07-02, remediation 24.1, commit `bfbe67fa`).** tla tool-runner classified
    SIGTERM-at-timeout TLC runs (exit 143, timedOut false) as `failed` instead of `timed-out`
    (Vega TLA audit, GitHubWebhookIndexingPipeline). `src/tla/tool-runner.ts` now classifies
    `SIGTERM && durationMs >= timeoutMs` as `timed-out`.
11. **RESOLVED (2026-07-02, remediation 24.2, commit `affe02b7`).** `tla verify` lacked a
    `--timeout-ms` flag though TlaToolRunOptions.timeoutMs existed — big models could not raise
    the 120s TLC budget (Vega TLA audit). Flag registered in
    `src/runtime/query-commands/tla.ts`.
12. **RESOLVED (2026-07-02, remediation 24.3, commit `75a5c60b`).** tla verify output needed
    root-cause grouping/caps at avalanche scale — 10,724 findings on one model was unconsumable
    (Vega TLA audit, AuthRefreshCompanionAuthorization). Findings are now grouped by
    (category, modelElement) with capped-by-default output and `--full` to uncap
    (`src/tla/conformance.ts` `findingGroups`, `src/runtime/query-commands/tla.ts`).

