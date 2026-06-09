# Killer Roadmap: Oracle → Cascade Plans → Risk Split

Date: 2026-06-09. User goal: (1) a real "this is how you clean up" signal, (2) every
command as accurate as it can be, (3) a health score that measures objective
maintainability. Order chosen: oracle first (trust the answers), cascade plans second
(act on them), score split third (report them honestly).

Builds on: `2026-06-09-maintainability-implementation.md` (detector accuracy),
`2026-06-09-health-accuracy-plan.md` (axes, ratchet, git evidence, validation loop).

## Pillar 1 — Accuracy oracle (`self-audit` command) ✅ DONE

Premise: accuracy you don't measure is a feeling. ts-morph (the TS compiler) is already
embedded as the semantic provider — use it as ground truth and score the cheap evidence
paths against it.

- [x] `src/queries/self-audit.ts` — deterministic stride sampling, file-level set
      comparison, per-question P/R, top disagreements as debugging targets.
- [x] Honest oracle semantics, discovered on first run: ts-morph findReferences is a
      COMPLETE oracle (precision + recall valid) but calleesFor is PARTIAL (it only
      reports confidently-resolved call shapes) — so for callees, cheap-only answers are
      "unverified", not wrong, and only recall is claimed. The harness audited its own
      oracle on day one.
- [x] Wired through the full command machinery; contract tests green first pass.
- [x] Graceful-unavailable test (non-TS / no tsconfig fixtures).

Measured numbers (file-level agreement, first benchmark):
- scip-query (60 samples): references precision 1.0 / recall 0.902; callees recall 1.0
  (18 unverified). The 10% reference recall gap has named symbols attached — concrete
  accuracy work for the cheap path.
- Stable_Management (40 samples, 23s): references precision 1.0 / recall 1.0;
  callees recall 1.0 (10 unverified).
- Headline: the cheap evidence paths NEVER fabricated a reference on either repo
  (precision 1.0) — misses, not lies. That is now a tracked, ratchetable number.

## Pillar 2 — Cascade cleanup plans (`cleanup-plan` command) ✅ DONE (verify deferred)

- [x] `src/queries/cleanup-plan.ts`: graph-fact dead seed (health/dead profile, entry/
      rooted/suppression filtered) + worklist fixpoint over the removed code's callees.
      Conservative cascade rule: every resolved reference site must fall inside an
      already-removed definition's range; unattributable references block.
- [x] Ordered batches with depth, LOC, files-emptied; blocked list explains WHY each
      non-cascadable candidate is stuck (with blocking files).
- [x] Evidence tier per entry: `graph-fact` vs `cascade`.
- [x] Wired through full machinery; suite + build green; pure-logic test for the
      removed-range index.
- DEFERRED: `--verify` (worktree + tsc) — the plan output already instructs "typecheck
  between batches"; automated verification is the next increment.

Live results:
- Stable_Management (19s, bounded): 7 symbols / 88 LOC in 2 batches. Batch 1 contains
  `runCommand` (21 LOC) — dead ONLY after its sole caller (batch 0's `syncPrismaSchema`)
  is deleted. Single-pass dead-code analysis cannot see this symbol; the cascade can.
  Blocked list correctly held back candidates referenced from a .spec.ts and from import
  statements outside removed ranges.
- Known refinement: import-statement reference sites block cascades even when the
  importing file's real uses are all inside removed ranges — conservative, not wrong.

## Pillar 3 — Risk/Hygiene score split + calibration ✅ DONE

- [x] `riskScore` (graph facts + change-graph signals: dead, isolated, cycles,
      complexity, hidden coupling) and `hygieneScore` (candidate detectors); headline
      `score` = min(risk, hygiene) for compat. Every deduction tagged risk|hygiene.
- [x] `validation.byCategory`: per-detector fix-density lift, auditable. First data
      (Stable_Management): wrappers 1.25 (mildly predictive there!), stale 0.4,
      dead/isolated 0 — expected: dead files attract no commits at all, so fix-density
      is the wrong validator for graph-fact categories; they are validated by definition
      (zero references). Interpretation note recorded.
- [x] Wrapper fan-in cliff fixed: function-level fan-in keeps threshold >3; file-level
      fallback (the proxy one new importer can bump) now requires >5. The 21
      borderline findings from the health-baseline.ts import vanished; scip-query
      baseline regenerated (22 → 2 findings).
- [x] Evidence tags on health actions: graph-fact | heuristic | change-graph.
- DEFERRED: dynamic weight calibration from byCategory lifts (zero risk weights when
  lift < 1) — wait for more than two repos of lift data before automating.

Final state: scip-query risk 95 / hygiene 100; Stable_Management risk 95 / hygiene 96.
215/215 tests, build green, both ratchets regenerated and green.

## Decisions log (final)
- ts-morph calleesFor proved to be a partial oracle — self-audit reports recall-only for
  callees and labels cheap-only answers "unverified". The harness audited its own oracle.
- Cleanup-plan cascade rule is deliberately conservative (import-line references block);
  better a smaller plan that is safe than a bigger one that breaks the build.
- Fix-density validates heuristic detectors, not graph-fact ones (dead files get no
  commits — that's what dead means). byCategory lifts should only gate hygiene→risk
  promotion, never demote graph facts.

