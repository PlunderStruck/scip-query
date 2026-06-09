# Health Metric Accuracy Plan

Date: 2026-06-09. Goal: turn `health` from a detector-output aggregate into a falsifiable,
actionable, predictive instrument. Companion to `2026-06-09-maintainability-register.md` and
`2026-06-09-maintainability-implementation.md` (detector accuracy work, done earlier today).

Why: the score read 100 before AND after we removed 11 false positives and 8 false similar
pairs — the scalar is insensitive and unexplained. The fix is not better weights; it is
(a) auditable decomposition, (b) a ground-truth data source the reference graph lacks (git
history), (c) a feedback loop from user suppressions, (d) a ratchet mode whose semantics are
objective ("no new findings"), and (e) risk delivered at decision time (plan-context).

## Phase 1 — Git evidence module (`src/analysis/git-history.ts`)
- [x] `loadCommitHistory(db)`: `git log --no-merges --name-only` (bounded: 2,000 commits),
      parsed to {hash, timestamp, subject, files[]}; skip bulk commits (>50 files);
      per-db cache keyed by HEAD (`git rev-parse HEAD` revalidation); graceful null when
      git/repo unavailable.
- [x] Derived facts: `fileChurn` (changes + last-changed per file), `changeAmplification`
      (median/p90 indexed-files-per-commit), `fixDensity` (per-file count of commits whose
      subject matches fix/bug/regression), `coChangeMatrix` (pair counts + confidence).
- [x] Unit tests against a synthetic git repo built in tmp.

## Phase 2 — `co-change` query + CLI command
- [x] `src/queries/co-change.ts`: hidden-coupling pairs — files that co-change with high
      confidence (support ≥ 4, confidence ≥ 0.6) but have NO dependency edge in either
      direction (the change graph sees concepts the reference graph can't: this is the
      mechanized form of "scattered concept / hand-synchronized artifacts").
      `co-change <file>` mode: that file's co-change partners.
- [x] Full command wiring (the machinery hardened earlier today enforces each step):
      manifest (`public-query-entries.ts`), package.json export, query-command spec (Impact
      family), `queryCommandOrder`, regenerated COMMAND_REFERENCE block.

## Phase 3 — Suppression feedback loop (`src/analysis/suppressions.ts`)
- [x] Scan indexed sources for `scip-query: ignore-<category>` comments; inventory by
      detector category. Every suppression is a ground-truth label: "this finding was wrong
      or accepted-by-design."
- [x] Surface in health: per-detector suppressed counts beside active counts — a measured
      precision signal, not a guess.

## Phase 4 — Health axes + auditable score
- [x] Two new OPTIONAL health phases (`git-evidence`, `suppressions`) — older phase
      orchestrations without them still build a report (back-compat for `health-phase`).
- [x] Report gains `axes` (each with units): deletable LOC, cycle mass, change
      amplification (files/commit), hidden coupling (pairs), churn-weighted complexity
      (complexity × log₂(1+changes)), evidence quality (graph-fact vs heuristic finding
      counts).
- [x] Report gains `scoreBreakdown`: every deduction listed as {axis, points, detail} —
      the scalar becomes auditable. Existing deduction weights unchanged; one new deduction
      for hidden coupling.
- [x] Report gains `validation`: fix-density of flagged files vs unflagged baseline — the
      falsifiability check ("do our findings predict where fixes happen?").

## Phase 5 — Ratchet mode (`health --write-baseline` / `--baseline`)
- [x] `src/queries/health-baseline.ts`: stable finding identities (detector:file:symbol,
      sorted cycle/pair keys) collected from the same detector runs health uses.
- [x] `--write-baseline` writes `.scipquery-baseline.json` (committable); `--baseline`
      compares: prints new vs fixed findings, exit code 1 on any new finding. Objective CI
      semantics: "don't get worse," immune to absolute-score gaming.

## Phase 6 — Decision-time risk in `plan-context`
- [x] `risk` section per target (resolved to its file): churn, last-changed, fix density,
      fan-in (rdeps), co-change partners (what else usually changes with this file),
      suppressions present in file.
- [x] Renderer section in `query-commands/planning.ts`.

## Phase 7 — Verification
- [x] Full suite + build + typecheck green; contract tests confirm command wiring.
- [x] Self-run on this repo: co-change should surface doc/code and config/test coupling
      pairs; baseline write→check round-trip; health axes populated; validation ratio
      reported.
- [x] Update this plan with results + decisions.

## Status: ALL PHASES DONE (2026-06-09)

213/213 tests, typecheck clean, build green. Live verification on this repo:
- `co-change` immediately validated itself: top hidden-coupling pairs ARE the detector family
  (stale-abstractions <-> wrapper-candidates 17x/89%) — the change graph mechanically found the
  scattered-policy smell that this morning's review found by reading.
- `health` axes populated; score 92 with auditable breakdown (-3 wrappers, -5 hidden-coupling).
- Ratchet round-trip verified: write -> check exit 0; tampered baseline -> exit 1 with the
  exact new finding named.
- `plan-context src/queries/health.ts` HISTORY section: churn 24 (4 fix commits) + five
  co-change partners — the edit checklist an agent needs.

## Decisions log
- Validation axis reported an honest NEGATIVE on this repo: flagged-file fix-density is 0.36x
  baseline — i.e. current wrapper findings do not predict fixes here. That is the
  falsifiability loop working; we report it rather than tune it away.
- 21 wrapper findings appeared when health-baseline.ts imported all nine detectors, pushing
  each detector file's fan-in from 3 to 4 and crossing the wrapper detector's
  `callerFanIn <= 3` cliff. Deliberately NOT retuned — adjusting a threshold to quiet the
  tool's own repo is exactly the Goodharting this plan argues against. The findings are
  baselined; the cliff is documented as a known calibration issue (the discriminator should
  probably weight enclosing-function fan-in over file fan-in).
- Baseline excludes git-derived findings by design: new commits would churn them without any
  code change, breaking ratchet semantics.
- Drift detector caught my own layering leak during this work (report envelope re-exporting an
  analysis/ type into runtime/) — fixed by defining the summary shape in health-types.
- The suppression inventory surfaced 156 suppressions across src+tests — the measured-precision
  signal now visible in every health report (`evidenceQuality.userSuppressed`).
- `health-phase` orchestration treats the two new phases as optional, so older phase callers
  still compose a report.

## Field test: Stable_Management (2026-06-09)

Ran the full feature set against a foreign repo (BarnPulse — npm-workspaces monorepo,
1,167 files / 93k symbols / 491 commits analyzed; exercises the large-index budget path).

What worked out of the box:
- `co-change` found textbook hidden coupling: `schema.prisma <-> docs/security/
  stable-scope-table-inventory.md <-> scripts/stable-scope-inventory.mjs` (a generated-inventory
  triangle), `.env.example <-> config/env.ts`, `AGENTS.md <-> CLAUDE.md`, and
  `backend/src/schemas/onboarding.ts <-> frontend/src/stores/onboarding.ts` — cross-workspace
  API-contract coupling invisible to the reference graph.
- `health` (1m52s bounded): score 91, all axes populated, auditable breakdown.
- Ratchet: 155 findings baselined in 35s; round-trip clean.
- `plan-context backend/src/routes/onboarding/horses.ts` HISTORY: churn 12 + the
  onboarding-routes co-change cluster as an edit checklist.

Three refinements the field test motivated (all upstreamed + tested):
1. co-change: filter same-stem sibling files (Component.vue/.script.ts/.css are one unit).
2. stale-abstractions: `contracts/` joins the type-only-file conventions — contract modules
   define types for other modules by design, so only their UNUSED types are stale
   (fixture expectation updated deliberately).
3. health-baseline: applies the same large-index scan budget as health (was unbounded).

Honest negatives observed (falsifiability loop): validation ratio 0.6x on Stable_Management
and 0.36x on scip-query — candidate-style findings do not currently concentrate where fix
commits happen. Reported, not tuned away.
