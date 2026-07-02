# Plan 4 — Release readiness (final fixes, polish, ship)

Date: 2026-07-02 · Executor: agents (implementation) → Claude (final pass) → user (npm publish)
Inputs: [followups](2026-07-02-followups.md) · [calibration reports](../validation/) · [Vega TLA audit](../validation/2026-07-01-vega-tla-model-audit.md)
**Plan-1 working agreement applies verbatim.** Phases 22–26.

## Goal

Ship the current state as one npm release without breaking any existing user.
Decision (user, 2026-07-02): NO platform-scoped packages — one `scip-query`
package; Windows gets the scip binary via checksum-verified on-demand download.
Done = false-dead archetypes fixed or honestly downgraded, Windows path
restored without vendoring 39 MB, followups triaged ship/defer, gates green,
fresh-install smoke passes, version bumped, pushed.

## Phase 22 — Windows distribution: revert the package split (S)

### 22.1 - One package, download-on-demand for Windows
- [x] **File**: `package.json` (remove any `@scip-query/scip-win32-*` optionalDependencies + any `os`/`cpu` scaffolding), `src/runtime/scip-cli.ts` (resolution order becomes: PATH → `SCIP_QUERY_SCIP_BIN` env → cached download → printed install instructions), `scripts/build-scip-windows.mjs` (keep — it builds the release assets), docs.
- **What**: 21.2's 15.1 introduced platform-package references that were never published; installing them would warn-and-skip for every user. The user rejected the approach outright.
- **Change**: delete the platform-package path entirely. Windows binary resolution downloads from this project's GitHub release assets (URL pattern `https://github.com/PlunderStruck/scip-query/releases/download/v<version>/scip-win32-<arch>.exe` — CONFIRM the repo slug from package.json/git remote) with a pinned sha256 per release, cached under the scip-query cache dir, mirroring `tla fetch-tools` exactly (same download/verify/rename code path if reusable — reuse audit says extract a shared `fetchVerifiedBinary` helper only if both sides stay under ~30 lines each; otherwise mirror). Non-Windows platforms unchanged (PATH/brew/go instructions).
- **Migration honesty**: existing Windows users upgrading lose the vendored binary; their first `reindex` must print exactly one actionable line and attempt the download automatically. Test the resolution matrix as pure logic (platform/fs/fetcher injected).
- **RELEASE-BLOCKER NOTE for the publisher**: the Windows binaries MUST be uploaded as GitHub release assets (built via `npm run build:scip-windows`) before or at publish time, and the sha256 constants updated in the same commit that bumps the version. Add a `scripts/` check that fails `prepublishOnly` if the pinned URL/sha for the current version is unset.
- **Validation**: `npm pack --dry-run` < 6 MB, zero `@scip-query/*` references repo-wide; resolution unit tests cover all four outcomes; `npm i -g` from the tarball in a scratch prefix stays clean.

## Phase 23 — False-dead archetypes (the real engineering; M–L)

Each step: investigate root cause FIRST (index shape vs reference-counting vs
resolution), write the failing fixture, then fix. Calibration clones in the
scratchpad are available for live validation; a `pnpm install` rerun on the
Vega clone is part of 23.2's protocol.

### 23.1 - `import type`-only consumers counted as references
- [x] Symbols consumed only via `import type { X }` are reported dead (Stable_Management: `OrgMember`/`OrgInvite`/`OrgAssignment`, verified against `refs`). Root-cause: does scip-typescript emit those references (check the raw index) and we filter them, or are they absent? Fix at the counting layer (dead/isolated/new-dead/production-callables all consume it); a type-only consumer is a consumer (deleting breaks compile). Fixture: type-only import across files → `dead` must not flag; `refs` must list the importer.
### 23.2 - pnpm-workspace cross-package consumers invisible
- [x] Vega: `packages/shared/src/contracts/*` exports grep-verified consumed cross-package, all flagged new-dead (21% of gate findings). Protocol: `pnpm install` in the Vega clone, reindex (workspace mode), re-measure; classify remaining misses (symlinked node_modules resolution? project-mode shards not linking cross-project references?). Fix in the indexing/resolution layer or, if not fixable this release, `dead`/`new-dead` must detect workspace-package consumers via import-path evidence and downgrade those findings to `unconfirmed (cross-package)` — never plain "dead".
### 23.3 - Vue `<script setup>` composable consumers dropped
- [x] Stable_Management: `useHorseReportPrintView`/`usePublicInvoicePrintView` falsely zero-consumer. Suspect the SFC script extraction path (13.4 unified it — check offsets/refs wiring for setup blocks). Fixture: composable imported+called only from a `<script setup>` SFC → refs lists it, dead doesn't flag.
### 23.4 - Downgrade honestly where not fixed
- [x] Whatever 23.1–23.3 leaves unfixed: detector output and skills must label those shapes `unconfirmed` per the Detector Reliability section, and the followups doc updated. No known-wrong "dead" claims ship as facts.

## Phase 24 — Small fixes + dogfood polish (S each)

- [x] 24.1 tla tool-runner: SIGTERM/exit-143 at the timeout boundary classifies `timed-out`, not `failed` (followup #10) + test.
- [x] 24.2 `tla verify`/`trace-check` gain `--timeout-ms` (plumb existing TlaToolRunOptions.timeoutMs; descriptor + docs) (followup #11).
- [x] 24.3 tla verify output: group findings by (category, action) with per-group caps + `--full` uncap, mirroring diff-gate's root-cause grouping (followup #12; AuthRefresh produced 10,724 findings).
- [x] 24.4 Health 97→100 dogfood: add `runtime → tla` to the layer policy; move `escapeRegex` from source/source-stripper to `src/core/` (restores the documented semantic↛source invariant); move `binaryAvailable` (runtime/command-availability) usage out of src/tla (invert: tla takes an availability fn param or the helper moves to core); consolidate the 7 duplicate-body pairs; `cleanup-plan --verify` then delete the 3 dead symbols; add declaredCouplings for the generated-docs triangle. Health must land at 100 with zero suppression additions. (Landed at 100/100; only 1 of the 3 flagged dead symbols was genuinely dead — the other 2 are pre-existing, deliberately-kept test-only exports, see commit c8a1e3e4. 4 of 7 duplicate-body pairs consolidated; 3 documented as intentional variation. declaredCouplings extended by 2 files + 2 additional well-evidenced groups beyond the plan's literal 4-file list — see commit 8ae9b244.)
- [x] 24.5 analysisBudget disclosure on the other budgeted commands (followup #6) — same JSON field diff-gate uses.
- [ ] 24.6 Explicitly DEFERRED (stay in followups): hub-file doc-reference damping, similar sibling saturation, twin-drift delegation exclusion, twin-drift→health integration, Clojure capability derivation, behavioral A/B.

## Phase 25 — Release artifacts (S)

- [ ] 25.1 `CHANGELOG.md` (or release-notes section): every behavior change since 0.10.12 grouped by breaking/notable/fix, with the one-way doors called out: postinstall no longer installs anything (run `scip-query setup`); hooks default to `.claude/settings.local.json` (`setup-hooks --shared` for the old behavior); suppression IDs migrated (legacy ids still match; config-validate names replacements); package no longer vendors Windows binaries (auto-download on first use); `convergence` deprecated → `similar --plan`; `drift` pattern-deviation behind `--patterns`; new commands (`twin-drift`, `duplicate-bodies`, `uninstall`, `tla scaffold/instrument/trace-check/fetch-tools`); doc-reference advisory split; snapshot-doc policy; coverage contracts; finding-outcome ledger.
- [ ] 25.2 README refresh: feature list mentions the new detectors + TLA workflow + lens skills; Quick Start reflects consent model; prerequisites table Windows row says "downloaded automatically on first use".
- [ ] 25.3 Version bump to **0.11.0** (breaking-ish doors on a 0.x line) in package.json; `npm run docs:commands`; verify the `files` list one final time against `npm pack --dry-run` output review.

## Phase 26 — Final pass (Claude, not agents)

- [ ] 26.1 Full gates + the complete command smoke sweep (the session's smoke.sh) + regression suite + detect-the-past suite.
- [ ] 26.2 Fresh-install rehearsal: `npm pack`, install the tarball into a scratch prefix, run `postinstall` output check, `setup` in a scratch repo, `install-skills`, one query battery, `uninstall` round-trip.
- [ ] 26.3 Re-run the Stable_Management retro-gate on 5 commits with the final build — confirm gate precision didn't regress from the retunes.
- [ ] 26.4 Verify 23's fixture claims against both calibration clones live.
- [ ] 26.5 Commit, push to origin. Publisher then: build Windows assets → create GitHub release v0.11.0 with them → `npm publish`.

## Stress notes

- 22.1 depends on the repo slug + release-asset hosting: confirm remote URL before writing the download constant; the prepublish check is the guard against shipping a dead URL.
- 23.2 may be unfixable this release (indexer-shaped); 23.4 is the honesty valve — the release ships either the fix or the label, never the silent wrong claim.
- 24.4's escapeRegex move touches many importers — mechanical, gate-covered.
- Order: 22 ∥ 23 (disjoint files), then 24, 25, 26 strictly last.
