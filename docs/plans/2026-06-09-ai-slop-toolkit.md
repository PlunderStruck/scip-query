# AI-Slop Toolkit

Date: 2026-06-09. Goal: signals tuned to how AI-generated code actually rots a codebase.
Provenance tagging REJECTED (user: only Claude reliably tags commits; partial labels lie).

Order: (1) recent-duplicates, (2) doc-drift — these two attack the user's live problem
(agents re-implementing existing code; standards docs that agents read going stale) —
then (3) compile-verified deletion, (4) unused trailing params.

## 1 — `recent-duplicates` ✅ DONE — "the new code re-implements the old code"
AI agents re-implement helpers they didn't know existed. Generic `similar` finds pairs;
the AI-cleanup question is *directional*: which side is the established original and
which is the recent echo.
- [x] `src/queries/recent-duplicates.ts`: run `similarAll`, then classify each pair by
      file age from git history (first-seen commit index within the bounded window).
      Report pairs where one side first appeared within `--window` commits (default 100)
      and the other predates it → "recent re-implementation of established code".
      Both-new pairs flagged too (agent duplicated itself in one session).
- [x] Render: established vs echo, ages, similarity; advice is "use/extend the
      established one, delete the echo".
- [x] Wire (Cleanup family) + graceful no-git degradation.

## 2 — `doc-drift` ✅ DONE — standards docs that stopped tracking the code they govern
The user's workflow: standards documented in-repo, agents read them before implementing.
Failure mode: the code moves, the doc doesn't — agents then implement to a stale spec.
Detection inverts the hidden-coupling trick: a doc that *historically* co-changed with
code files but has NOT changed while those files kept churning is drifting.
- [x] `src/queries/doc-drift.ts`: for each doc file (md/mdx/rst/txt incl. AGENTS.md,
      CLAUDE.md), find code partners with co-change support ≥3; staleness per partner =
      commits touching the partner AFTER the doc's last change; doc score = Σ.
- [x] `doc-drift [doc]` detail mode: one doc's partners and what changed since.
- [x] Also: co-change noise filter for changelog-by-policy files (CHANGELOG.md co-changes
      with everything by design — same class as tests/sibling stems).
- [x] Wire (Cleanup family) + tests on the synthetic git fixture.
- [x] CONTENT-REFERENCE MODE (added after Stable_Management testing exposed the blind
      spot): only 2 of 56 agent-os standards had co-change history — write-once docs were
      invisible. Now every tracked doc is scanned for file-path citations, resolved
      against git ls-files (exact + unambiguous 2-3 segment suffix); subjects merge both
      evidence sources ('reference' | 'co-change' | 'both'). BROKEN REFERENCES detected:
      cited paths that existed in history but no longer exist (spec points at deleted
      code) — weighted 10x in staleness. Result on agent-os: domain-model.md cites four
      deleted frontend/src/api/* files; prisma-migrations.md unchanged through 43 schema
      changes; waitlist.md standard behind 22 endpoint-contract changes. 318 docs in 0.4s.

## 3 — `cleanup-plan --verify` ✅ DONE — compile-verified deletion (the universal oracle)
Every language ships its own ground truth (tsc, cargo check, ...).
- [x] `src/runtime/cleanup-verify.ts`: throwaway `git worktree add --detach` at HEAD,
      node_modules symlinked in (worktrees lack untracked deps), CARGO_TARGET_DIR reuse
      for Rust; batches applied CUMULATIVELY (also exercises the cascade claim);
      dirty-overlap warning; worktree always removed.
- [x] Truncated-range hardening: index ranges sometimes cover only a declaration's first
      line — deletions extend until brackets balance (on comment/string-stripped text) so
      a statement is never bisected. Caught live on scip-query: a 5-line declaration with
      a 1-line index range; verify failed, fix applied, then COMPILER-VERIFIED in 6s.
- [x] DIFFERENTIAL BASELINE: most repos don't check clean at the root (Stable_Management:
      3,329 pre-existing tsc errors from workspace tsconfigs). The unmodified worktree is
      checked first; pass = no NEW errors (position-independent error identity, tested).
- [x] Live catch on Stable_Management: 5 new errors distilled from 3,329 — the entry
      file backend/src/index.ts imports all three "dead" startup functions and wires
      `shutdown` into signal handlers. The dead detector's evidence missed import +
      callback references there; the oracle stopped a build-breaking deletion. Failure
      output = the exact missed references. 53s end-to-end.

Follow-up (queued): the Stable_Management catch indicates dead-code misses
import-specifier/callback references in `backend/src/index.ts`-style entry files that
classifyFile doesn't recognize as entry surfaces (monorepo `*/src/index.ts`). Investigate
both the classifier pattern and the reference counting before trusting dead on that shape.

## 4 — `unused-params`: speculative generality
AI's signature move: parameters and options nobody uses. V1 scope: TRAILING unused
parameters only (safe to delete without breaking positional contracts), skipping
`_`-prefixed names. Needs param names from source facts + body identifier usage.
- [ ] Check ast-callables for param-name availability; extend if absent (TS-first).
- [ ] Detector + command (Cleanup family), conservative gates (no interface-conformance
      breakage: trailing-only), heuristic disclaimer.

## Verification
Suite + build green; live runs on scip-query, Stable_Management, Vega_2.0,
VegaAssistant; record per-repo results + decisions here.

## Live results (2026-06-09)
- doc-drift Vega_2.0 (0.6s): flagged `docs/backend-http-route-api-standard.md` — a literal
  standards doc — with route files coupled 17-23x historically now changing without it;
  AGENTS.md drifting from vega-assistant.service.ts. Exactly the user's stated failure mode.
- doc-drift VegaAssistant: a runbook 48 code-changes stale; an ADR 45 changes stale.
- recent-duplicates Vega_2.0 (15s bounded): 2 directional echoes, e.g. ProjectCardVisual
  (added 62 commits ago) duplicating established RecentProjectRow at 91%.
- CHANGELOG noise filter added to co-change (changelog-by-policy coupling is intentional).
- Synthetic git fixture extended (distinct commit timestamps) + doc-drift unit test.

## Decisions log
- Items 3 (cleanup-plan --verify) and 4 (unused-params) remain QUEUED — next session.
- Detail mode `doc-drift <doc>` filters by substring; staleness = raw change count (no decay)
  for v1 — revisit weighting once more repos give calibration data.
