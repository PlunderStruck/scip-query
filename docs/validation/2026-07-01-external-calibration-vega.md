# External calibration: scip-query vs Vega_2.0 (Plan 3, Phase 21.1)

Target repo: `/Users/aydansalois/Documents/GitHub/Vega_2.0` (read-only; all work done in a local
clone at `/private/tmp/.../scratchpad/calib-vega`, retro-gate in a second clone
`calib-vega-retro`). scip-query invoked via the dev build
(`node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js <cmd>`), version `0.10.12`.

> ## ⚠️ PARTIALLY-SEEN TEST SET
> **Vega_2.0 was the historical perf-tuning and benchmark corpus for this tool** (see
> `docs/benchmarks/2026-06-28-vega-*`, `docs/validation/2026-06-28-vega-2-heavy-benchmark-result.md`,
> `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`). Performance numbers here are
> partially in-distribution by construction, and the repo even carries a mature `.scipquery.json`
> with **64 hand-written suppressions** accumulated from prior scip-query use — meaning the
> easiest true positives for `doc-reference`/`co-change-partner`/`new-dead`/`echo` have already
> been triaged out, which **deflates measured gate precision** relative to a never-seen repo.
> Precision detector sampling is less contaminated (the tuning was perf-focused, not
> threshold-focused, and the repo grew ~80% since: 103,982 indexed symbols on 2026-06-28 vs
> 188,759 today). The clean test is the companion run:
> `docs/validation/2026-07-01-external-calibration-stable-management.md`.

## 1. Environment

| | |
|---|---|
| Repo shape | 7,495 tracked files, 2,329 `.ts`/`.tsx`, 2,581 commits (verified in clone at HEAD `77f73600d`, branch `dev`) |
| Stack | pnpm workspace monorepo (`apps/api` Express/Drizzle, `apps/web` React/Vite, `packages/*` incl. published `@vega/companion` CLI), plus Python configured |
| `npm ci --ignore-scripts` | **Failed** (pnpm workspace; no `package-lock.json` — npm rejects the command). Per protocol, proceeded **without `node_modules`**. Indexing succeeded anyway, but this likely degrades cross-package reference resolution (see the `new-dead` artifact, §4) and possibly external-type resolution. |
| Existing `.scipquery.json` | Present, left untouched: `languages: [typescript, python]`, `watch.enabled: false`, `indexer.typescript.pnpmWorkspaces: true`, and **64 suppressions** (mostly `doc-reference`, plus `co-change-partner`, `echo`, `new-dead`) — evidence of prior scip-query adoption on this repo. |
| Index location | Default cache (`~/.cache/scip-query/projects/2ded10f2eb13/index.db`); no writes to either repo. |

### Index stats (initial reindex, HEAD)

```
Documents:   2,357
Symbols:     188,759
Definitions: 186,020
References:  168,881
Index size:  118.6 MB
```

Initial `reindex`: **29.8s wall** (41.1s user, 144% CPU — TS + Python indexers in parallel).
**The ~10-min scale concern did not materialize**; no OOM, no retry with
`--indexer-concurrency 2` needed. This is the 7.5k-file scale test and it passed with ~30s
headroom-free reindexes throughout.

### Analysis-budget disclosure at this index size

The index (188,759 symbols / 2,357 docs) is over both large-index thresholds
(`LARGE_COMMAND_SYMBOL_THRESHOLD` 25k, `LARGE_COMMAND_DOCUMENT_THRESHOLD` 2.5k;
`src/runtime/cli-support.ts:24-26`). Observed behavior:

- **`diff-gate --json` emits `analysisBudget` as designed** on every retro run:
  `{"scanLimit": 2500, "semanticEnrichment": false, "reason": "large index default budget; pass --full for unbounded semantic analysis"}`. Confirmed working.
- **`health`** does not emit `analysisBudget` but emits its own warning:
  `"Large index detected; running health without candidate scan or result caps because full mode is enabled."` — health's `--full` is a compat no-op and it runs uncapped by default (26s wall / 3m34s CPU here — acceptable).
- **No other detector emits the disclosure** — `commandAnalysisBudget` is only wired into
  `src/runtime/query-commands/impact.ts` (diff-gate). The standalone battery commands ran
  without any budget disclosure key in JSON. If the disclosure is meant to be a general
  contract, only diff-gate honors it today.

## 2. Timings (detector battery, HEAD index)

| Command | Wall | Findings | JSON size |
|---|---|---|---|
| `reindex` (cold) | 29.8s | — | index 118.6 MB |
| `reindex` (commit-to-commit, 15 retro runs) | 7.9–29.3s, median ~27s | — | two small-diff commits hit ~8s incremental path |
| `health` | 26.5s | score 65 (risk 89, hygiene 65), 12 actions | 17 KB |
| `twin-drift -n 20` | 0.50s | 20 groups | 47 KB |
| `duplicate-bodies -n 20` | 0.38s | 20 groups shown (health: 474 total / 2,528 LOC) | 39 KB |
| `drift` | 0.80s | **897** (3 layer-violations, 894 pattern-deviations, 0 unused-imports) | **722 KB** |
| `recent-duplicates` | 1.85s | 30 findings, 25 root-cause groups | 76 KB |
| `co-change -n 15` | 1.10s | 15 | 17 KB |
| `doc-drift -n 15` | 2.48s | 15 | 153 KB |
| `complexity-hotspots -n 10` | 3.59s | 10 | 5 KB |
| `similar -n 20` | 0.87s | 20 pairs | 39 KB |
| `unused-params` | 1.22s | **0** | 144 B |
| `wrapper-candidates` | 2.83s | 30 shown (health: 170 total, 46.25 score-weighted) | 23 KB |
| `stale-abstractions -n 15` | 1.80s | 15 shown (health: 110 total) | 12 KB |

Every detector is sub-4s at 188k symbols; `health` is the only >5s command. Latency is a
non-issue at this scale. (Caveat: Vega was the perf-tuning corpus — see banner.)

## 3. Per-detector precision (sampled, hand-classified)

Findings were read at their cited file:line before classification. "Precision" = actionable /
sampled (UNCERTAIN counted as non-actionable).

| Detector | Sampled | Actionable | Noise | Uncertain | Precision |
|---|---|---|---|---|---|
| `complexity-hotspots` | 10 | 9 | 1 | 0 | **~90%** |
| `recent-duplicates` | 8 | 6 | 0 | 2 | **~75%** |
| `duplicate-bodies` | 10 | 6 | 2 | 2 | **~60%** |
| `similar` | 10 | 5 | 5 | 0 | ~50% |
| `co-change` | 10 | 5 | 1 | 4 | ~50% |
| `doc-drift` | 10 | 5 | 3 | 2 | ~50% |
| `twin-drift` | 10 | 1 | 9 | 0 | **~10%** |
| `drift` | 10 (all 3 layer-violations + 7 diverse pattern-deviations) | 0 | 10 | 0 | **~0%** |
| `stale-abstractions` | 10 | 0 | 10 | 0 | **0%** |
| `wrapper-candidates` | 10 (of 14 read) | 0 | 10 | 0 | **0%** |
| `unused-params` | 0 findings | — | — | — | no FP cost; recall untestable here |
| `health` (dead-code axis, graph-fact) | 4 (all `dead-code` kind) | 4 | 0 | 0 | 100% — all four are production-dead, referenced only by test mocks (e.g. `apps/api/src/middleware/permissions.middleware.ts:784` `requireCustomFieldAdmin`, `apps/api/src/modules/ai/ai.service.ts:75` `getProviderInfoForUser`) |

### Failure modes observed (with evidence)

- **`twin-drift`** groups by bare leaf name with no layer/role awareness. Worst FP: a 24-member
  `<constructor>` group (`maxDivergence` 0.083, e.g.
  `apps/api/src/middleware/rateLimit.middleware.ts:172` vs test-mock `AppError` constructors in
  `apps/api/src/middleware/__tests__/auth.middleware.test.ts:56`) — every TS class has a member
  literally named `<constructor>`. Also systematically flags controller→service→storage
  delegation chains (`upload`, `delete`, `removeReaction`) and test mocks vs production. The
  one real find: `searchCode` independently reimplemented in
  `apps/api/src/modules/codebase-analysis/codebase-analysis.controller.ts:375` vs
  `services/codebase-repo-intel-query.service.ts:273` (same clamp→search→rank→map pipeline).
- **`drift` pattern-deviation channel** (894/897 = 99.7% of output) fires on "only sibling in
  this directory depending on X" — all 7 diverse samples were legitimate, actively-called
  imports (e.g. `auth-session.service.ts:499` really calls `pushService.unsubscribeAll()` in
  the logout path). The 3 layer-violations are the *same* edge repeated 3× (each vitest config
  importing the shared `scripts/vitest-pool-config.mjs` helper) and all intentional.
- **`stale-abstractions`** cannot see: in-file type composition (`PaginationMeta` nested in the
  actively-used `PaginatedResponse<T>`, `apps/web/src/api/types.ts:10`), ambient global
  augmentation (`apps/api/src/types/express.d.ts:4` `Express.Request` — used implicitly on
  every request via `req.rawBody`), or published-package public types
  (`packages/companion/.../coding-agent-runtime.ts:48`, deliberately self-contained per its
  file header). 0/10 actionable.
- **`wrapper-candidates`** flags intentional layering boundaries. Worst cluster: 13 entries
  from `apps/web/src/api/chat.ts:53-273` — the file has an explicit architectural comment
  declaring "wrappers own chat route paths… hooks own cache/realtime policy". The
  boundary-evidence discount (170 → 46.25 score-weighted) is directionally right but the
  *displayed top-30* is still 0/10 actionable.
- **`similar`'s** top-scored pair (sim 1.0) was its worst FP: `fuzzMultipartRawAndSse` vs
  `fuzzSecondaryApi` in `apps/api/.../live-api-fuzz.ts` — unrelated fuzz scenarios that share
  the same 4 generic helpers. Callee-fingerprint similarity saturates when a file has a small
  shared-helper vocabulary.
- **`doc-drift`** metadata bug: every sampled finding reports `"docLastChangedAt": 0` (epoch)
  even for docs committed the same day; `changesSinceDocUpdate` looks correct. Undermines
  trust in the staleness explanation even when the verdict is right.
- **`complexity-hotspots`'s** single FP is instructive: `seed-test-data.ts:30 seedTestData()`
  (841 LOC, fanOut=1) — a linear seed script whose "branches" are repetitive guard clauses.
  A low-fan-out straight-line-script discount would take this detector to ~100% here.

### Best finds (worth quoting)

- `complexity-hotspots`: `apps/web/src/components/chat/ChatMessage.tsx:87` —
  `useChatMessageInnerView()`, 1,009 LOC / 250 branches / churn 54 — one hook computing
  translation retry state, live-vs-persisted tool counts, edit/delete/reaction handlers, and
  attachment detection. Textbook decomposition target; also #1 in health's churn-weighted list.
- `recent-duplicates`: `CustomEndpointManagerModal.tsx:385` (`EndpointModalFooter`) vs
  `ModelProfileManager.tsx:1119` (`ProfileModalFooter`) — byte-identical modal footers
  differing in one label string.
- `duplicate-bodies`: `apps/api/src/modules/auth/auth-password.service.ts:17` `logAuthEvent` —
  a security audit-log writer hand-copied into a second file; silent-divergence risk.
- `co-change`: `apps/api/src/db/schema/ai-settings.ts` ↔ `apps/web/src/api/ai-settings.ts` —
  no import edge (server Drizzle schema vs browser fetch client), co-changed 11×; exactly the
  hidden coupling the check exists for. Also `apps/api/.env.example` ↔ `apps/api/src/config/index.ts`.
- `doc-drift`: `docs/analysis/2026-04-09-vega-beta-security-report.md` cites
  `github.service.ts:658-665` for the webhook timing-safe comparison; `crypto.timingSafeEqual`
  now lives at ~line 2502 — a security auditor re-verifying the claim lands on the wrong code.

## 4. Retro-gate (last 15 non-merge commits)

Method: second clone, per commit `git checkout -f <c>` → `reindex` (timed) →
`diff-gate --base <c>~1 --json` (timed). Total loop: **8m56s for 15 commits** (~36s/commit:
median 27s reindex + 0.3–32s gate, gate median ~8.7s).

| # | Commit | Changed files/symbols | Gate wall | Exit | Findings (by check) |
|---|---|---|---|---|---|
| 1 | `77f7360` billing lifecycle | 26 / 103 | 32.0s | 1 | 3 doc-reference (+5 suppressed) |
| 2 | `a2f778a` agent+billing lifecycles | 42 / 81 | 21.8s | 1 | 1 doc-reference (+9 suppressed) |
| 3 | `85f9ade` TLA models | 8 / 0 | 3.1s | 0 | 0 |
| 4 | `f7ba503` untrack TLC artifacts | 8 / 0 | 2.4s | 0 | 0 |
| 5 | `8768190` indexing race fix | 6 / 17 | 9.0s | 1 | 8 doc-ref, 2 twin-partner (advisory) |
| 6 | `cc276cc` workspace commit (8,099 files) | **0 / 0** | 1.4s | **0** | **"Unable to compute git diff." — FAIL-OPEN** |
| 7 | `73b6786` health cleanups | 26 / 154 | 21.2s | 1 | 49 doc-ref, 40 new-dead |
| 8 | `ca1fd59` reduce coupling | 27 / 78 | 18.9s | 1 | 48 doc-ref, 15 new-dead, 5 co-change, 4 twin |
| 9 | `2aae0cd` dep updates | 6 / 0 | 2.1s | 0 | 0 |
| 10 | `3f48179` dev personas (68k insertions) | **0 / 0** | 0.3s | **0** | **"Unable to compute git diff." — FAIL-OPEN** |
| 11 | `a6b259b` glass CSS fix | 2 / 1 | 2.0s | 0 | 0 |
| 12 | `6929e42` Safari iframe fix | 12 / 22 | 18.1s | 1 | 6 co-change-partner |
| 13 | `b27d3e2` issues view chrome | 2 / 19 | 8.7s | 1 | 1 echo, 2 doc-ref |
| 14 | `776d2ed` AI + CSP hardening | 6 / 14 | 2.2s | 1 | 20 doc-reference |
| 15 | `13db044` prelaunch security | 45 / 62 | 18.1s | 1 | 57 doc-ref, 5 co-change, 2 twin |

Totals: **268 findings** — doc-reference 188 (70%), new-dead 55, co-change-partner 16,
twin-partner 8 (all advisory, as designed), echo 1. Exit 1 on 9/15 commits. The repo's
existing suppressions engaged correctly (14 findings suppressed across commits 1–2 with
reasons echoed in JSON).

### 🔴 Fail-open on the largest diffs (blocker-grade)

On the two biggest commits — #6 (8,099 files changed) and #10 (68,674 insertions) — `git diff`
inside `diffImpactPlan` threw (exec buffer exceeded, most likely), the bare `catch` in
`src/queries/impact/diff-impact.ts:113-120` swallowed it into
`note: "Unable to compute git diff."`, and diff-gate returned **exitCode 0 with zero checks
run**. A gate that passes precisely when the diff is too big to analyze is inverted risk
ordering: the commits most likely to smuggle problems get a green check. Minimum fix: exit
non-zero (or a distinct "gate could not run" code) when the note is
`GIT_DIFF_UNAVAILABLE_NOTE`, and raise/execute the diff with a streaming or `--name-only`
first pass.

### Gate precision (15 findings sampled proportionally, verified against each commit's actual diff)

| Check | Sampled | Actionable | Verdict evidence |
|---|---|---|---|
| doc-reference | 7 | **1** | The hit: `docs/frontend-api-wrapper-standard.md` cites exact line anchors (`proposals.ts:489/:534/:644/:660`, `ai-settings.ts:211`); commit `73b6786` shrank proposals.ts 754→253 lines — five citations now point past EOF. The 6 misses: docs cite the file at role/snapshot granularity and the commit's mechanical refactor didn't invalidate any claim (e.g. `TIER_PERMISSION_SWEEP.md` claims about `checkUsageLimit` were untouched by the billing extraction in `77f7360`). |
| new-dead | 4 | **0** | **Systematic cross-package artifact**: all four flagged `packages/shared/src/contracts/*` types (`AISettingsAuthType`, `CodingAgentsUpdateAgentProfileBody`, `AISettingsCustomEndpoint`, `CodebaseIndexStartResponse`) are grep-verified consumed by `apps/web`/`apps/api` through the `@vega/shared` package boundary, which the index does not resolve (compounded by missing `node_modules` in this run). 55 of 268 gate findings (21%) come from this artifact. Notably `dead` at HEAD reports 0 dead symbols in `packages/shared` — the two checks disagree on the same corpus. |
| co-change-partner | 2 | **0** | #12's controller change was pure param-parsing hardening (service called with identical signature); #13 paired two docs whose correlation comes from bulk doc sweeps. |
| twin-partner | 1 | **0** | Controller `startIndexing` is a thin `jsonHandler` delegate; the race fix belonged only in the coordinator. Advisory tier (never blocking alone) is the right call — keep it advisory. |
| echo | 1 | **0** | `SprintPickerDropdown` vs `EpicPickerDropdown` are both thin prop-configs over the shared `ScopedWorkItemPicker` — reuse already happened; 84% similarity is inherent to configuring the same generic component. |
| **Overall** | **15** | **1 (~7%)** | Deflated by the 64 pre-existing suppressions (see banner) but the new-dead artifact and role-level doc citations are real, repo-shape-driven noise sources. |

Ironic data point: commit `73b6786`'s message shows the Vega author ran
`diff-gate --skip doc-reference --skip new-dead` — they had already learned to skip the two
noisiest checks, yet doc-reference caught the only genuinely broken citation in exactly that
commit. The volume, not the check, is the problem.

## 5. Per-detector verdicts

| Detector | Verdict |
|---|---|
| `health` | **KEEP.** 26.5s at 188k symbols, uncapped; graph-fact axis sampled 4/4 correct; score-weighted discounts (wrappers 170→46.25, hidden-coupling 100→15) are directionally honest. |
| `complexity-hotspots` | **KEEP.** ~90%; optional polish: discount fanOut≤1 straight-line scripts (the `seedTestData` FP). |
| `recent-duplicates` | **KEEP.** ~75%; note the repeat-cluster inflation (same underlying pattern occupying 4–5 of top 30). |
| `duplicate-bodies` | **KEEP + already-planned RETUNE** (`--min-loc` 1→3 / registration-boilerplate exemption, plan §21.2). At Vega the shown top-20 are all ≥7 LOC and 60% actionable; the FP shapes (shadcn boilerplate, one-line apiClient forwarders) are exactly what 21.2 targets. |
| `similar` | **KEEP + RETUNE**: cap or discount similarity contributed by callees shared with >N same-file siblings (the sim=1.0 fuzz-helper saturation); consider excluding test files from default output. |
| `co-change` | **KEEP + RETUNE**: suppress same-directory pairs and locale-sibling (`locales/*.json`) pairs by default — the "hidden" premise fails when colocation already signals the coupling. Cross-app/schema↔client pairs are the detector's genuine value. |
| `doc-drift` | **KEEP**; **fix the `docLastChangedAt: 0` serialization bug**; consider auto-downgrading docs that self-mark historical/completed. |
| `twin-drift` | **RETUNE before any gate default** (confirms plan §Stress-Test note): (1) hard-exclude the `<constructor>` leaf; (2) exempt groups whose members sit on a caller→callee delegation path (controller/service twins); (3) exempt test-file-only members. Without these: ~10%. Gate `twin-partner` stays **advisory** — calibration says it must not block. |
| `drift` (pattern-deviation channel) | **DEMOTE-TO-OPT-IN.** 0/10 actionable, 894 findings / 722 KB with no `-n` cap; "only sibling importing X" fires on ordinary well-factored code. Keep the layer-violation channel in default output but collapse shared-edge duplicates into one finding. |
| `stale-abstractions` | **DEMOTE-TO-OPT-IN** (or retune hard): must exempt `.d.ts`/ambient declarations, types composed within their own file's exported types, and published-package roots before it earns default placement. 0/10. |
| `wrapper-candidates` | **DEMOTE-TO-OPT-IN** in ranked-list form: 0/10 on the displayed top-30 despite boundary discounts; single-consumer API-client layering is idiomatic in this stack. The score-weighted aggregate inside `health` can stay. |
| `unused-params` | **KEEP.** Zero findings on 2,329 TS files = zero noise cost. |
| `diff-gate` overall | **KEEP with three fixes before it's trusted at this repo shape**: (1) **fail-closed** on `GIT_DIFF_UNAVAILABLE_NOTE` (blocker); (2) disable or grep-back `new-dead` for symbols whose consumers may live across an unresolved package boundary (auto-detect: flagged symbol is exported from a workspace package consumed elsewhere in the same repo); (3) split `doc-reference` severity by citation granularity — line-anchored citations that no longer resolve are the actionable core (1/1 in sample), file-mention citations are the noise bulk (0/6). |

## 6. Agent-consumer notes

- **Output volume**: `drift` (722 KB / 897 findings, no `-n`) and doc-heavy `diff-gate` runs
  (205–228 KB JSON on commits 7/8/15, dominated by doc-reference + rootCauseGroups) will blow
  agent context windows. A `--max-findings`/severity floor on both, plus root-cause-group
  collapse being the default presentation, would help most. Everything else is ≤160 KB and fine.
- **Latency**: excellent across the board at 188k symbols — battery total ~44s including
  health; retro cycle ~36s/commit (reindex-dominated). Per-commit gate latency is acceptable
  for CI; the ~27s reindex is the floor.
- **Suppression loop works end-to-end**: 64 pre-existing suppressions round-tripped (findings
  reported under `suppressed` with reasons), proving the triage workflow scales to a real repo.
  But 64 suppressions accumulated on one repo *is itself* a calibration signal — the
  doc-reference default is generating triage debt faster than value at this doc density
  (~250+ markdown files citing code).
- **`--json` envelope is consistent** (`command/evidence/args/options/result`) and easy to
  machine-consume; `analysisBudget` disclosure appears only in diff-gate (see §1).
- **Trust asymmetry confirmed**: graph-fact outputs (`dead`, health's deletable axis) sampled
  clean; heuristic detectors range 0–90%. The `evidence` field's fact/heuristic split is
  earning its keep and agents should be told to weight accordingly (skills already do).

## 7. Caps and deviations

- `npm ci --ignore-scripts` failed (pnpm-only workspace); proceeded without install per
  protocol. Effect: cross-package reference resolution likely degraded (see new-dead artifact —
  though scip-typescript's `pnpmWorkspaces: true` mode may reproduce it even with installs;
  needs a follow-up run with `pnpm install` to separate the two causes).
- Precision sampling: 10 per detector as specced (8 for recent-duplicates: obvious repeat
  clusters); gate sampling 15 findings proportional to check distribution.
- Retro-gate used `checkout` in the clone rather than worktrees (plan allows either; clone
  isolation is equivalent and avoids node_modules symlinks).
- Not committed — left for reviewer per assignment.
