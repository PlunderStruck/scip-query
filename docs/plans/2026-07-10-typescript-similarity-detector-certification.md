# TypeScript Similarity Detector Certification

Date: 2026-07-10
Status: Complete

## Goal

Audit and harden the six general TypeScript similarity analyzers against the
same pinned, read-only four-repository corpus used for factual certification:
`recent-duplicates`, `similar`, `similar-files`, `similar-chains`,
`similar-signatures`, and `twin-drift`.

Done means every analyzer has an uncapped candidate frame, deterministic
source-reviewed samples, named noise archetypes, known-positive fixtures, a
fresh replay, and an evidence-bounded certification state. Relationship
correctness and recommendation usefulness are recorded separately.

## Current State

- `recentDuplicates()` orients candidates with Git first-add evidence and then
  ranks echo direction before similarity. Source:
  `scip-query code recentDuplicates --json`,
  `src/queries/cleanup/recent-duplicates.ts:133-183`.
- `similarAll()` builds compiler/source-backed fingerprints, narrows candidate
  pairs through shared callees, applies weighted similarity, and keeps ranked
  results. Source: `scip-query code similarAll --json`,
  `src/queries/cleanup/similar.ts:336-466`.
- `similarFiles()` compares file dependency profiles after classifying
  distinctive dependencies. Source: `scip-query code similarFiles --json`,
  `src/queries/cleanup/similar-files.ts:32-58`.
- `similarChains()` generates dependency paths, removes infrastructure-heavy
  chains, compares edit distance, and deduplicates the results. Source:
  `scip-query code similarChains --json`,
  `src/queries/cleanup/similar-chains.ts:42-64`.
- `similarSignatures()` groups callable definitions by normalized compiler or
  source signatures and LOC band. Source:
  `scip-query code similarSignatures --json`,
  `src/queries/cleanup/similar-signatures.ts:47-66`.
- `twinDrift()` returns same-name or near-name callable groups whose bodies
  diverge after existing delegation, synthetic-leaf, and test-only filters.
  Source: `scip-query code twinDrift --json`,
  `src/queries/cleanup/twin-drift.ts:73-88` plus
  `scip-query plan-context twinDrift --json`.
- All six are public query surfaces consumed by `src/queries/index.ts` and CLI
  cleanup handlers. Source: the `referencedBy` sections of
  `scip-query plan-context <analyzer> --json` for each analyzer.
- The existing calibration scripts are intentionally outside the TypeScript
  SCIP project: `scip-query outline scripts/accuracy-calibration.mjs --json`
  and the core equivalent return no indexed definitions. Their current
  factual packet, verdict, Wilson-confidence, detached-worktree, and renderer
  machinery was therefore inspected through the repository filesystem as the
  narrow fallback.

## Truth Rules

- `recent-duplicates`: the reported echo file is genuinely newer within the
  declared history window, the established side predates it, and the reported
  domain-specific similarity evidence is present.
- `similar`: the two reported callables have the disclosed shared callee or
  source-token evidence and score; generic scaffolding alone is not a direct
  consolidation recommendation.
- `similar-files`: the two files have the disclosed distinctive dependency
  overlap and score; matching framework imports alone is a support signal.
- `similar-chains`: both sequences are real dependency paths and the reported
  edit distance, divergence, prefix, suffix, and similarity agree.
- `similar-signatures`: every grouped callable has the same normalized
  parameter/return shape and compatible LOC band; equal shape alone does not
  imply duplicate behavior.
- `twin-drift`: group members represent the same or credibly near concept by
  name and context, have materially divergent bodies, and are not homonyms,
  generated leaves, tests, or intentional delegation layers.

## Reuse Audit

- Extend `scripts/accuracy-calibration.mjs`; do not add a second corpus runner.
  It already owns detached worktrees, isolated caches, pinned commits, source
  excerpts, rendering, and reviewed packet generation.
- Extend `scripts/accuracy-calibration-core.mjs`; reuse deterministic identity,
  sampling, Wilson intervals, per-detector summaries, and grouped verdicts.
- Reuse each production analyzer directly from `dist/queries/index.js` so the
  packet tests the same query functions shipped by the package.
- Add no detector helper until a reviewed false-positive archetype proves the
  existing filter or classifier cannot express the required distinction.

## Testability Design

| Behavior                    | Test seam                                | Dependencies                       | Pure core                                                | Side-effect shell                           | Contract                                                         |
| --------------------------- | ---------------------------------------- | ---------------------------------- | -------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| Parse batch options         | `parseSimilarityCalibrationOptions()`    | argument vector, root resolver     | option validation and detector selection                 | none                                        | deterministic selected roots, detectors, sample size, seed       |
| Normalize pair/group rows   | calibration-core normalizer              | analyzer result and context        | stable row identity and pair metadata                    | source excerpt reader remains in runner     | both endpoints survive packet serialization                      |
| Separate truth from utility | verdict application and summary tests    | reviewed overlay                   | relationship precision and recommendation utility counts | JSON read/write in runner                   | one truth verdict and one optional utility verdict per row       |
| Collect analyzers           | `collectSimilarityCandidates()` adapters | `ScipDatabase`, analyzer functions | result-shape mapping and sampling                        | detached worktree, Git, cache, source reads | uncapped count plus deterministic sample per detector/repository |
| Publish evidence            | similarity packet renderer               | packet object                      | deterministic Markdown projection                        | report file writes                          | zero-finding detectors and evidence states remain visible        |

## Design Phases

### 1. Extend the calibration schema without breaking prior packets

- [x] **Files**: `scripts/accuracy-calibration-core.mjs`,
      `tests/scripts/accuracy-calibration-core.test.ts`
- **Source**: existing script filesystem fallback; production consumers are
  absent from SCIP by the outline evidence above.
- **Change**: Add the six-detector option manifest, pair/group normalization,
  and optional recommendation-utility verdict summaries. Preserve schema-1
  dead and factual packet compatibility.
- **Testability**: Pure parser, normalizer, identity, verdict, and summary tests;
  no repository processes required.
- **Validation**: focused calibration-core Vitest suite and typecheck.
- **Why**: Evidence capture must be trustworthy before corpus output is read.

### 2. Add the detached-worktree similarity battery

- [x] **File**: `scripts/accuracy-calibration.mjs`
- **Source**: `scip-query code recentDuplicates`, `similarAll`, `similarFiles`,
  `similarChains`, `similarSignatures`, and `twinDrift`.
- **Change**: Add `health-similarity`, direct uncapped analyzer adapters,
  pair/group source excerpts, candidate counts, durations, and a renderer that
  displays both endpoints and both review dimensions.
- **Testability**: Adapter results normalize before any file write; the runner
  remains the sole Git/process side-effect shell.
- **Validation**: build, one-detector smoke run, packet schema assertions.
- **Why**: CLI caps and renderer differences must not hide the population frame.

### 3. Run and classify the pinned baseline

- [x] **Repositories**: Vega_2.0, openwork, Stable_Management, traceroot
- **Source**: corpus and commits recorded by the generated packet.
- **Change**: Generate counts and ten deterministic rows per repository and
  detector; review from both cited source sites and supporting graph/Git facts.
- **Testability**: Reviewed JSON overlays are stable inputs to `summarize`.
- **Validation**: Every sampled row has a truth verdict, utility verdict,
  evidence note, and named archetype when invalid or non-actionable.
- **Why**: Similarity arithmetic and consolidation usefulness fail differently.

### 4. Harden only proven shared archetypes

- [x] **Files**: selected production analyzers and focused tests, chosen after
      baseline classification.
- **Source**: query-specific `scip-query code`, `trace`, and source excerpts for
  every reproduced row.
- **Change**: Fix the narrowest fingerprint, candidate, classifier, or ranking
  boundary. Never raise thresholds merely to erase a noisy population.
- **Testability**: Each archetype gets a positive and boundary-negative fixture;
  existing intended matches remain.
- **Validation**: focused tests plus a fresh seeded holdout.
- **Why**: Shared archetypes are upstream defects; individual corpus rows are
  not suppressions or tuning targets.

### 5. Publish certification and workflow parity

- [x] **Files**: `docs/validation/2026-07-10-typescript-similarity-detectors.md`,
      reviewed overlay JSON, `docs/accuracy-audit-checklist.md`, and
      `docs/accuracy-hardening-goal.md`
- **Source**: generated baseline and reviewed replay packets.
- **Change**: Record relationship precision, Wilson confidence, utility rate,
  exclusions, and one evidence state per analyzer. Verify `convergence` parity
  with `similar --plan`; keep `twin-ab` scaffold correctness as its own later
  workflow audit.
- **Validation**: summaries regenerate from committed overlays and no state
  exceeds its evidence gates.
- **Why**: Public credibility requires distinguishing a true measurement from a
  useful recommendation.

### 6. Repository verification

- [x] Run focused and full tests, typecheck, lint, and build.
- [x] Run `scip-query reindex`, matching postchecks, `self-audit`, and
      `scip-query diff-gate --json`.
- [ ] Fix or explain every finding and update this plan to Complete.

## Stress-Test Findings

- An uncapped pair detector may be computationally expensive; duration is
  evidence, but a timeout is `incomplete`, never a clean zero.
- A structurally exact match can be intentionally duplicated at a process,
  framework, serialization, or trust boundary. It remains a valid relationship
  and a non-actionable recommendation.
- Same-name twins can be homonyms. Context is essential to `twin-drift` truth,
  not merely recommendation utility.
- Signature equality says nothing about implementation behavior; certification
  is limited to normalized shape.
- `recent-duplicates` depends on Git history availability and must report
  unsupported history separately from zero echoes.

## Ship Order

1. Backward-compatible schema and tests.
2. Batch runner and smoke packet.
3. Baseline classification.
4. Narrow detector hardening and regressions.
5. Holdout replay, reviewed overlays, and certification report.
6. Repository-wide verification.

All phases are reversible. Detector thresholds and public recommendation tiers
are externally visible and require replay evidence before changing.
