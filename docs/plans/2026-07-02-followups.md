# Follow-ups from the 2026-07-01 external calibration (Plan 3, step 21.2)

Compact list of everything the two calibration reports flagged that is NOT covered by
remediation 21.2a-g. Each item: problem statement + report citation. Not a full plan — pick one
up, write a real plan section (`concrete-plan`), and implement independently.

1. **Import-type-only consumers falsely flagged dead/unused (Stable, HIGH).** Symbols consumed
   exclusively through `import type { ... }` don't register as referenced — `stale-abstractions`
   flagged `OrgMember`/`OrgInvite`/`OrgAssignment` `[high]` "unused" despite 10+ real usages.
   Reliability issue, not a heuristic miscalibration: undermines every "unused"/"dead"/
   "single-consumer" claim for type-primarily-consumed symbols.
   Source: `docs/validation/2026-07-01-external-calibration-stable-management.md` §6 ("Worst
   false positives", item 1).

2. **pnpm-workspace cross-package consumers falsely flagged dead (Vega, HIGH — needs a
   pnpm-install rerun to separate causes).** All 4 sampled `new-dead` gate findings on Vega were
   `packages/shared/src/contracts/*` types consumed across the `@vega/shared` package boundary by
   `apps/web`/`apps/api`, which the index doesn't resolve; `npm ci` failed on this pnpm-only repo
   so the run proceeded without `node_modules`, which may compound (not solely cause) the gap.
   21% of Vega's total gate findings came from this one artifact.
   Source: `docs/validation/2026-07-01-external-calibration-vega.md` §4 (gate precision table,
   `new-dead` row) and §7 ("Caps and deviations").

3. **Vue `<script setup>` composable consumer linkage gaps (Stable, HIGH).** A composable
   imported and called directly inside a `.vue` SFC's `<script setup>` block isn't always linked
   back to the composable definition — `new-dead` flagged `useHorseReportPrintView` and
   `usePublicInvoicePrintView` as "zero indexed consumers" though both are called from their
   sibling `.vue` files. 2/2 sampled `new-dead` retro-gate findings on Stable were this exact
   false positive.
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
