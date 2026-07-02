# External calibration: scip-query vs Stable_Management (Plan 3, Phase 21.1)

Target repo: `/Users/aydansalois/Documents/GitHub/Stable_Management` (read-only; all work done in a
local clone at `/private/tmp/.../scratchpad/calib-stable`). scip-query invoked via the dev build
(`node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js <cmd>`), version `0.10.12`.

## 1. Environment

| | |
|---|---|
| Repo shape | 2,284 tracked files, 1,173 `.ts`/`.tsx`, 410 `.vue`, 624 commits (verified in clone at HEAD `bd221c3fa`) |
| Stack | Vue 3 + TypeScript, Express/Prisma backend, npm workspaces (`frontend/`, `backend/`, `shared/`) |
| `npm ci --ignore-scripts` | Succeeded in ~5s, 832 packages, 11 audit advisories (not remediated, out of scope). No script-install fallout observed during indexing. |
| Index build | scip-typescript full run; `.vue` files handled via a post-hoc SQLite augmentation pass ("Augmented SQLite documents with 410 auxiliary source files") |

### Index stats (initial reindex, HEAD)

```
Documents:   1583
Symbols:     103168
Definitions: 89146
References:  108389
Index size:  59.4 MB
```

Initial `reindex`: **13.9s wall** (`19.55s user / 0.99s system`, 145% CPU). No failures, no cap hit.

## 2. Timings

| Command | Wall time | Notes |
|---|---|---|
| `reindex` (cold) | 13.9s | scip-typescript dominates |
| `reindex` (no-op re-run) | 0.3s | cache hit |
| `reindex` (typical commit-to-commit, 15 retro-gate runs) | ~14.0–14.5s | flat regardless of diff size |
| `reindex` (docs-only diff, 613ac73e3) | 2.2s | only commit with a real incremental speedup |
| `health` | 15.0s | full-index warning shown; ran uncapped |
| `twin-drift -n 20` | 0.43s | |
| `duplicate-bodies -n 20` | 0.34s | |
| `drift` | 0.47s | **no `-n` support**; 233 findings, 1139 lines, all emitted |
| `recent-duplicates` | 1.34s | |
| `co-change -n 15` | 0.62s | |
| `doc-drift -n 15` | 0.55s | |
| `complexity-hotspots -n 10` | 5.41s | slowest of the light detectors |
| `similar -n 20` | 0.50s | |
| `unused-params` | 0.62s | 0 findings |
| `wrapper-candidates` | 1.64s | |
| `stale-abstractions -n 15` | 1.19s | |
| `vue-component-duplicates -n 15` | 0.86s | |
| `vue-composable-candidates -n 15` | 0.78s | 0 findings |
| `vue-large-view-pressure -n 10` | 0.73s | 0 findings (see §6, major recall gap) |

No command exceeded the 3-minute battery cap or the 5-minute reindex cap; nothing was truncated
because of budget. All 15 retro-gate reindexes together took ~3.5 minutes.

**Volume flag:** `drift` has no result cap and printed 233 findings / 1139 lines on a single
default invocation — on a codebase this size that's a lot of tokens for an agent consumer to
digest, and (per §3) mostly low-value. Recommend adding a default `-n`/`--limit` the way
`twin-drift`/`duplicate-bodies`/etc. already have.

## 3. Per-detector precision table

Findings classified by reading the cited code, not just the finding text. "Sampled" = number of
findings actually inspected (cap 10 per instructions).

| Detector | Count | Sampled | Actionable | Noise | Uncertain | Verdict |
|---|---|---|---|---|---|---|
| `health` (rollup) | 1 score + 7 actions | 7 | 5 | 1 | 1 | KEEP |
| `twin-drift -n 20` | 20 groups | 8 | 3 | 4 | 1 | RETUNE — exclude generic method names (`<constructor>()`) from same-name matching |
| `duplicate-bodies -n 20` | 20 groups | 9 | 3 | 5 | 1 | RETUNE — raise min-body-LOC / exclude single-statement API-wrapper shape from `--full`-off mode |
| `drift` | 233 findings (0 unused-import, 0 layer-violation, 233 pattern-deviation) | 8 | 1 | 7 | 0 | RETUNE — default `--min-deviation` too low for this shape; add `-n` cap |
| `recent-duplicates` | 1 finding | 1 | 1 | 0 | 0 | KEEP |
| `co-change -n 15` | 15 pairs | 8 | 6 | 1 | 1 | KEEP |
| `doc-drift -n 15` | 15 docs (staleness-ranked) | 8 | 5 | 2 | 1 | KEEP — but demote "historical-note"/snapshot docs in ranking |
| `complexity-hotspots -n 10` | 10 symbols | 10 | 9 | 0 | 1 | KEEP |
| `similar -n 20` | ~20 pairs (self-tiered `direct`/`signal`) | 10 | 5 | 4 | 1 | KEEP — the built-in tier split is doing real work; consider hiding `signal` tier by default |
| `unused-params` | 0 | — | — | — | — | KEEP (clean run, nothing to judge) |
| `wrapper-candidates` | 30 | 10 | 4 | 5 | 1 | KEEP — `direct`/`signal` self-tiering again correctly separates infra boundary code from real inline candidates |
| `stale-abstractions -n 15` | 15 | 10 | 6 | 3 | 1 | RETUNE / flag reliability — 3 "unused type" findings were false positives traced to a `import type` reference-tracking gap (see §6) |
| `vue-component-duplicates -n 15` | 1 | 1 | 1 | 0 | 0 | KEEP (low recall, but the one hit is a strong true positive) |
| `vue-composable-candidates -n 15` | 0 | — | — | — | — | UNCERTAIN — clean run, but see §6 for whether it should have fired |
| `vue-large-view-pressure -n 10` | 0 | — | — | — | — | DEMOTE-TO-OPT-IN as currently scoped — confirmed blind spot, see §6 |

## 4. Retro-gate (headline number)

15 non-merge commits, newest-first: `bd221c3fa 41b9c0efc 8bf387e3a bfc67a8b1 40692ca2a dd2ed87e0
300b351df 2354b4e38 39d01fe81 5eeacef38 afc79a748 08d9249bb 0ca669ea5 613ac73e3 6f22f1c28`.

For each: `git checkout <commit>`, `node cli.js reindex` (timed — see §2), then
`node cli.js diff-gate --base <commit>~1 --json`.

### Findings per commit

| Commit | Findings | Exit |
|---|---|---|
| 5eeacef38 (268-file "Consolidate maintainability cleanup") | 54 | 1 |
| dd2ed87e0 | 14 | 1 |
| 41b9c0efc | 13 | 1 |
| 08d9249bb | 10 | 1 |
| 8bf387e3a | 9 | 1 |
| 6f22f1c28 | 9 | 1 |
| 39d01fe81 | 5 | 1 |
| afc79a748 | 3 | 1 |
| 2354b4e38, 300b351df, 40692ca2a, 0ca669ea5, bd221c3fa, 613ac73e3, bfc67a8b1 | 0 each | 0 |

**Total: 117 findings across 15 commits (median 5, mean 7.8, max 54).** All 117 came back
`severity: warning`.

### Per-check breakdown (117 total)

| Check | Count | % of total |
|---|---|---|
| `doc-reference` | 107 | 91% |
| `co-change-partner` | 7 | 6% |
| `new-dead` | 2 | 2% |
| `twin-partner` | 1 | 1% |
| `echo`, `incomplete-migration`, `coverage-contract`, `unused-params` | 0 | 0% |

`doc-reference` completely dominates the gate on this codebase. Two structural causes, both
confirmed by reading the diffs:

1. **Hub-file cascade.** `shared/src/contracts/endpoints.ts` is cited generically ("every API must
   have an entry here") by ~9–13 policy/reference docs (`AGENTS.md`, `agent-os/standards/api/*`,
   `docs/api-inventory.md`, etc.). Any commit that touches this one file — which happens on nearly
   every feature PR — refires the *same* set of ~9–13 warnings verbatim across 4 of the 8
   non-zero commits (`dd2ed87e0`, `41b9c0efc`, `6f22f1c28`, `39d01fe81`), regardless of whether the
   specific documented claim changed.
2. **Cosmetic-diff false fires.** `5eeacef38` and `afc79a748` each trip multiple `doc-reference`
   findings for files that were touched only mechanically — e.g. `backend/src/routes/horses.ts`
   changed only to drop non-null assertions (`stableContext!.id` → `stableContext.id`), and
   `FacilityBookingView.vue` changed only to swap a raw `<button>` for `<UiButton variant="text">`.
   Neither touches the behavior the citing docs (`FEATURE_CATALOG.md`,
   `docs/http-db-optimization-opportunities.md`) actually describe.

### Sample classification (~15 gate findings, across commits/checks)

| Finding | Commit | Verdict | Reason |
|---|---|---|---|
| `doc-reference` FEATURE_CATALOG.md ← `horses.ts` (non-null-assertion cleanup) | 5eeacef38 | NOISE | Cited claims describe unrelated behavior; the diff is a mechanical `!`-removal |
| `doc-reference` AGENTS.md ← `endpoints.ts` | dd2ed87e0 | NOISE | Generic "every API needs a contract entry" policy claim; commit *followed* that policy correctly |
| `doc-reference` `agent-os/standards/api/route-registry.md` ← `endpoints.ts` | 41b9c0efc | NOISE | Same hub-cascade pattern |
| `doc-reference` `docs/architecture-deepening-opportunities.md` ← `FacilityBookingView.vue` (button swap) | afc79a748 | NOISE | Doc claim is about DB/query architecture, unrelated to the UI swap |
| `doc-reference` `docs/api-inventory.md` ← `endpoints.ts` | 6f22f1c28 | UNCERTAIN | Plausible the entry table needs a glance, but generic enough to be low-value most of the time |
| `co-change-partner` `platformAdmin.ts` (route) ↔ `platformAdmin.ts` (schema) | 5eeacef38 | ACTIONABLE | Genuine 88% historical coupling, real risk of drift |
| `co-change-partner` `docs/security/stable-scope-table-inventory.md` ↔ `scripts/stable-scope-inventory.mjs` | 08d9249bb | ACTIONABLE | Same real coupling seen independently in `health`/`co-change` |
| `co-change-partner` `MessagesView.script.ts` ↔ `MessagesView.vue` | 08d9249bb | UNCERTAIN | These are a deliberately split file pair; flagging "you touched one half" has some value but is close to always-true for this codebase's `.vue`/`.script.ts` convention |
| `new-dead` `useHorseReportPrintView` "zero indexed consumers" | 5eeacef38 | **NOISE (tool defect)** | `HorseReportView.vue` imports and calls it directly; confirmed false positive |
| `new-dead` `usePublicInvoicePrintView` "zero indexed consumers" | 5eeacef38 | **NOISE (tool defect)** | `PublicInvoiceView.vue` imports and calls it directly; confirmed false positive |
| `twin-partner` `RecordPackageBuilder.<constructor>()` vs `AppError.<constructor>()` | 08d9249bb | NOISE | Same-name match is purely on the literal `<constructor>()` symbol name, shared by every class in the codebase by convention |
| `doc-reference` `agent-os/standards/api/families/service-tasks.md` ← `endpoints.ts` | 39d01fe81 | NOISE | Hub-cascade, generic mention |
| `doc-reference` `docs/http-db-optimization-opportunities.md` ← `FacilityBookingView.vue` | afc79a748 | NOISE | Same cosmetic-diff false fire |
| `doc-reference` `docs/architecture-deepening-next-pass.md` ← `outcomeRecordAuthoring.ts`/`trainingBehavior.ts` | 08d9249bb | UNCERTAIN | Doc is an explicitly historical "completed on 2026-05-04" snapshot; further edits to the named files are expected and not necessarily worth a warning |
| `doc-reference` `docs/roadmap/.../emergency-broadcasts.md` ← `eventBus.ts` | 8bf387e3a | ACTIONABLE | `eventBus.ts` gained a new dedicated SSE topic in this commit (per the commit message); the roadmap doc's event-fan-out description plausibly needs a check |

**Retro-gate precision: roughly 4/15 (~27%) clearly ACTIONABLE, ~9/15 (~60%) NOISE, ~2/15 (~13%)
UNCERTAIN** in this sample — dragged down almost entirely by `doc-reference`, which is 91% of raw
volume. `co-change-partner` alone (7 findings, sampled 3/3 actionable-or-uncertain, 0 clear noise)
is a much stronger signal than the aggregate number suggests.

## 5. Verdicts

| Detector | Verdict |
|---|---|
| `health` | KEEP |
| `twin-drift` | RETUNE — drop/deprioritize matches keyed only on generic member names (`<constructor>()`, likely also `toString()`, `constructor`-adjacent accessor names) |
| `duplicate-bodies` | RETUNE — raise the default min-body-LOC (or require ≥2 distinct statements) so 2-line API-wrapper call-throughs with different string-literal arguments stop dominating group counts |
| `drift` | RETUNE — raise default `--min-deviation` (currently 5) and/or add a default `-n` limit; 233 same-shaped "[UNIQUE] only sibling that imports X" findings at default settings is not actionable volume |
| `recent-duplicates` | KEEP |
| `co-change` | KEEP |
| `doc-drift` | KEEP, minor RETUNE — down-rank docs whose own prose self-identifies as a point-in-time/historical snapshot ("Status: completed on...", "as of...") so they don't crowd out living-doc staleness at the top of the ranking |
| `complexity-hotspots` | KEEP |
| `similar` | KEEP — consider making `tier: direct` the default view and gating `tier: signal` (scaffolding overlap) behind a flag, since `signal` accounted for most of the noise in the sample |
| `unused-params` | KEEP (nothing to tune from a 0-finding run; command itself was fast and correct) |
| `wrapper-candidates` | KEEP — the `direct`/`signal` self-tiering is the right idea and worked in this sample |
| `stale-abstractions` | RETUNE + reliability flag — see §6; "unused" claims for symbols reached only via `import type` are unreliable on this codebase and should not be surfaced at `[high]` confidence without a caveat |
| `vue-component-duplicates` | KEEP |
| `vue-composable-candidates` | KEEP (no findings to fault; too small a sample to bless further) |
| `vue-large-view-pressure` | DEMOTE-TO-OPT-IN in its current form for this codebase's architecture — 0/0 findings despite `complexity-hotspots` independently surfacing five 500–1,300-LOC `useXViewController` composables backing exactly the views this detector is supposed to catch (§6) |
| `diff-gate` — `doc-reference` check specifically | RETUNE hard — dominates gate volume (91%) at low precision; needs either (a) hub-file exemption/dampening for docs whose citation is a generic policy statement rather than a specific behavioral claim, or (b) a check that the *content* of the changed hunk plausibly touches the cited claim, not just that the file changed |
| `diff-gate` — `co-change-partner`, `twin-partner`, `new-dead` | Small sample but promising signal (`co-change-partner`) alongside one confirmed tool defect class (`new-dead`, see §6) |

## 6. Notable findings

### Most impressive true findings

1. **`recent-duplicates` / `vue-component-duplicates`: `CardDropdownOption.vue` vs
   `FilterMenuOptionButton.vue`** (`frontend/src/shared/workspace/actions/CardDropdownOption.vue`,
   `frontend/src/shared/workspace/actions/FilterMenuOptionButton.vue`) — both added in the same
   268-file commit (`5eeacef38`), 65% structural overlap, same props
   (`label`/`selected`/`testid`/`role`), same `click` event contract, different styling/variant
   support (danger state vs. checkmark). Two agents independently building near-identical "menu
   option button" primitives in one commit — exactly the "echo before it diverges" case the tool
   is designed for. Two independent detectors (`recent-duplicates`, `vue-component-duplicates`)
   agreed on this pair.

2. **`twin-drift`: `idSchema` divergence across 11 backend schema files**
   (`backend/src/schemas/farrierCare.ts:13`, `vetFacilities.ts:11`, `vetRecords.ts:14` use
   `z.string().trim().min(1)`; `backend/src/schemas/conversations.ts:14`,
   `emergencyBroadcasts.ts:8`, `inventory.ts:15`, `locations.ts:4`, `maintenance.ts:14`,
   `notes.ts:46`, `notifications.ts:14`, `templateOptions.ts:26` use
   `z.string().uuid('id must be a valid UUID')`) — a real, unflagged validation inconsistency: 3 of
   11 identically-named local `idSchema` constants accept *any* non-empty string where the other 8
   require UUID format. This is the kind of latent data-integrity gap a security reviewer would
   want surfaced.

3. **`duplicate-bodies`: `writeAuditEntry` duplicated across 14 workflow files**
   (`backend/src/workflows/orgAssignments.ts:39-43`, `orgInvites.ts:48-52`, `orgMembers.ts:36-40`,
   `orgProfiles.ts:26-30`, `adminConfig.ts:12-16`, `join.ts:48-52`,
   `platformAdminStables.ts:61-66`, and 7 more) — a canonical, more capable version already exists
   at `backend/src/workflows/auditEffects.ts:11-23` (accepts an `operationPrefix` option), but 14
   other files independently redefine the same 5–6 line local copy instead of importing it.

4. **`complexity-hotspots`: the `useXViewController` family** — `useFacilityBookingViewController`
   (1,257 LOC, score 1119.8), `useHorseProfileViewController` (1,117 LOC), `useInventoryViewController`
   (967 LOC), `useMessagesViewController` (1,133 LOC), `useDailyChecklistViewController` (747 LOC).
   Clean, well-evidenced ranking (LOC + fan-out) that correctly identifies this codebase's
   dominant god-composable pattern.

### Worst false positives

1. **`stale-abstractions`: `OrgMember`/`OrgInvite`/`OrgAssignment` flagged `[high]` "unused — no
   consumers"** (`frontend/src/features/organization/shared/types/organizationTypes.ts:3-28,
   42-65, 67-80`). All three are actively used — `OrgMember` alone appears in
   `frontend/src/features/organization/organization/OrganizationView.script.ts`,
   `organizationModel.ts`, and `organizationModel.spec.ts` (10+ usages). Root cause: all three are
   consumed exclusively through `import type { ... }` (type-only imports), and `scip-query refs`
   on the underlying symbol confirms the index only sees the definition-site reference, not any of
   the consuming files. This is a reference-tracking gap for type-only imports, not a heuristic
   miscalibration — it should be treated as a reliability issue, since it silently undermines
   confidence in every "unused"/"dead"/"single-consumer" claim for symbols that are primarily
   consumed as types.

2. **`diff-gate` `new-dead`: `useHorseReportPrintView` / `usePublicInvoicePrintView` flagged
   "zero indexed consumers"** (`frontend/src/features/horse-care/horse-profile/reports/useHorseReportPrintView.ts`,
   `frontend/src/features/operations/billing/usePublicInvoicePrintView.ts`). Both are imported and
   called directly (plain value import, not type-only) by their sibling `.vue` SFC
   (`HorseReportView.vue:7,19`, `PublicInvoiceView.vue:6,17`). This points to a second,
   related reference-tracking gap: consumption from inside a `.vue` `<script setup>` block isn't
   always linked back to the composable it imports. 2/2 sampled `new-dead` findings in the
   retro-gate were false positives.

3. **`vue-large-view-pressure`: 0 findings, confirmed blind spot.** The detector counts template +
   inline `<script>` + style + `<script src="...">` (external script) LOC, but this codebase's
   dominant pattern is a *second* hop: `FacilityBookingView.vue` uses `<script src=
   "./FacilityBookingView.script.ts">` (45 LOC, thin), which sets `setup:
   useFacilityBookingViewController` — a composable imported from a *separate* 1,342-line file one
   more hop away. The detector's "external script" counting stops at the immediate `src=` file and
   never follows into the composable it delegates `setup` to, so it misses exactly the pattern
   `complexity-hotspots` independently flagged as the top 5 hotspots in the whole repo.

4. **`twin-drift`/`diff-gate twin-partner`: matches keyed on `<constructor>()`.** Both the standalone
   `twin-drift` run (5 unrelated constructors: `AppError`, `StripePaymentProcessor`, a test mock
   `StripeMock`, `SupabaseRecordStorage`, `RecordPackageBuilder`, 60% "divergence") and the retro-gate
   sample (`RecordPackageBuilder.<constructor>()` vs. `AppError.<constructor>()`) surfaced pairs that
   share nothing but the literal method name every class constructor gets. Not a real twin
   relationship.

5. **`diff-gate doc-reference` hub-file cascade**, detailed in §4 — `shared/src/contracts/endpoints.ts`
   alone accounts for 36 of the 107 `doc-reference` findings across the 15-commit sample (4
   separate commits, ~9–13 near-identical findings each), almost all against generic
   policy-statement citations rather than specific behavioral claims.

## 7. Agent-consumer latency/volume notes

- `drift` has no `-n`/`--limit` flag and returns unbounded output (233 findings / 1139 lines here);
  every other detector in the battery supports `-n`. This is the one place in the battery where an
  agent would need to post-filter a large blob rather than ask for a capped result.
- `diff-gate --json` on the 268-file commit (`5eeacef38`) returned 54 findings in one payload —
  large but not unreasonable given the diff size; still, since 91% of gate volume system-wide is
  the low-precision `doc-reference` check, an agent burns most of its gate-triage budget on the
  weakest signal.
- Reindex cost is flat at ~14s per commit regardless of diff size except when the diff contains no
  `.ts`/`.vue` changes (2.2s observed for a docs-only commit). For an agent looping over many
  commits (e.g. bisecting or auditing a PR stack) this is a real, constant per-step tax — 15
  commits cost ~3.5 minutes of reindexing alone in this run.
