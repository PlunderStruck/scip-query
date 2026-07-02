# Plan 6 seed — Performance as architecture (caching, invalidation, monorepo scale)

Status: SEED — queued behind Plan 5. Full plan to be written measurement-first
via the scip-hyper-optimization methodology (baselines, ledgers, scoreboard —
the June campaign's own discipline).

## User intent (2026-07-02)

Optimize the slow commands, but structurally: caching/reuse/invalidation as
first-class architecture, not one-off wins. Must be provably correct in
monorepos with multiple languages and workspaces. One-off optimizations
allowed, but prefer mechanisms the whole feature set inherits.

## Measured baselines (today, real repos)

- Vega_2.0 (7,495 files, 186k symbols): reindex 29.8s cold / 0.4-0.8s shard-reuse;
  `health` 26.5s (everything else sub-4s); retro-gate ~36s/commit
  (reindex-per-commit dominates). Index 122 MB.
- Stable_Management (2,284 files): reindex 13.9s; full detector battery cheap.
- scip-query itself: reindex 2.5-3s; health ~1.2s.

## Existing structural assets to extend (not reinvent)

- evidence.db (src/storage/evidence-cache.ts): content-hash + VERSION keyed,
  fail-closed, well-tested — the proven pattern; today it covers only some
  detectors' intermediate products.
- Per-language shard reuse (content-digest fingerprints, tested) + TS
  workspace project-mode sharding.
- analysisBudget: the current mitigation is CAPPING work on big indexes —
  a cache-first architecture should make most caps unnecessary.
- src/instrumentation/profile.ts wired into 16 modules (profiling exists).
- Health already groups cheap phases / runs phases in workers (June work).

## The open questions (the plan must answer with experiments, not assumptions)

1. Which derived products are recomputed per command that could live in
   evidence.db with content-keyed invalidation? (candidate list: definition
   catalogs, callee fingerprints, git-history extracts, co-change pair maps,
   source facts per file, react/vue profiles — some cached today, audit all.)
2. Incremental indexing: can a single-file edit avoid a whole-language
   scip-typescript rerun? (per-project shards exist; per-FILE granularity is
   the big unlock — feasibility experiment needed.) What does `reindex` cost
   proportional to on each repo shape?
3. Monorepo correctness: are evidence.db keys correct under workspace mode,
   multi-language shards, and the 23.2 workspace-package resolution? Does a
   change in packages/shared invalidate dependents' cached facts?
4. Cache identity across checkouts: cache dirs key on project root path —
   branch switches, worktrees, and clones each pay cold cost. Content-keyed
   sharing across checkouts of the same repo? (Retro-gate at 36s/commit is
   the motivating workload.)
5. health's 26.5s: which detectors dominate at 186k symbols, and which shared
   intermediate (corpus memo?) would collapse the sum? Profile first.
6. Invalidation contract: one written rule for what busts each cache tier
   (content, config, tool version, index identity) — enforced by a coverage
   contract or test, not convention.

## Process requirements

- scip-hyper-optimization skill methodology; baselines on all three repos
  before any change; every optimization lands with its ledger entry.
- Structural bias: prefer extending evidence.db / shard machinery over
  bespoke per-command caches; every new cache documents its invalidation
  key and gets a staleness test (integrity-audit drill 1 applies: witness
  every cache serving stale data in a constructed scenario before trusting
  invalidation).
