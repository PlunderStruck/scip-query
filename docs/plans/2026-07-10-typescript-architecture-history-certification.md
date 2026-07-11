# TypeScript Architecture and History Detector Certification

Date: 2026-07-10
Status: Complete

## Goal

Audit and harden six TypeScript architecture/history analyzers against the
pinned Vega_2.0, openwork, Stable_Management, and traceroot corpus:
`co-change`, `doc-drift`, `drift`, `wrapper-candidates`,
`passthrough-candidates`, and `stale-abstractions`.

Done means every analyzer has a written relationship rule, an uncapped
candidate frame, deterministic subtype-aware samples, source or Git evidence,
named noise archetypes, regression coverage for proven defects, a fresh
holdout replay, and an evidence-bounded state. Relationship correctness and
recommendation utility remain independent verdicts.

## Current State

- `coChange()` reads the Git evidence product, applies minimum together-count
  and confidence gates, removes missing/noise/test/obvious-colocation pairs,
  excludes structurally linked pairs in repository-wide mode, classifies the
  surviving relationship, and is consumed by health, plan context, the public
  query index, and the impact CLI. Source:
  `scip-query plan-context coChange --json` and
  `scip-query code coChange --json`,
  `src/queries/impact/co-change.ts:95-176`.
- `docDrift()` builds one history/reference scan, filters to living
  non-snapshot docs by default, resolves cited and historically coupled code,
  counts changes after the doc's last update, and ranks broken references plus
  stale subjects. Source: `scip-query plan-context docDrift --json` and
  `scip-query code docDrift --json`,
  `src/queries/cleanup/doc-drift.ts:149-255`.
- `drift()` combines conservative unused-import evidence, architectural layer
  policy violations, and opt-in sibling pattern deviations. Pattern deviations
  are already disclosed as exploration-only because prior calibration found
  recommendation walls. Source: `scip-query plan-context drift --json`,
  `scip-query code drift --json`, and
  `scip-query code patternDeviationDrift --json`,
  `src/queries/cleanup/drift.ts:61-95` and `:225-267`.
- `wrapperCandidates()` reports short callables used from exactly one external
  caller file only when that caller has material fan-in; boundary evidence
  changes the action tier. Source:
  `scip-query plan-context wrapperCandidates --json` and
  `scip-query code wrapperCandidateForSymbol --json`,
  `src/queries/cleanup/wrapper-candidates.ts:147-195`.
- `passthroughCandidates()` requires one unique callee and the literal
  `return inner(args)` body shape, then distinguishes boundary/facade signals
  from direct candidates. Source:
  `scip-query plan-context passthroughCandidates --json` and
  `scip-query code passthroughCandidateForSymbol --json`,
  `src/queries/cleanup/passthrough-candidates.ts:62-94`.
- `staleAbstractions()` evaluates low-consumer types/classes, preserves
  transitive, barrel-public, singleton-backed, and type-only usage evidence,
  and returns a confidence plus recommendation tier. Source:
  `scip-query plan-context staleAbstractions --json`,
  `scip-query code staleAbstractions --json`, and
  `scip-query code scoreStaleCandidate --json`,
  `src/queries/cleanup/stale-abstractions.ts:98-169` and `:302-332`.

## Truth Rules

- `co-change`: both current files occurred together in the reported number of
  accepted commits, the individual change counts and confidence agree with the
  declared full-history filters, and the structural-link/classification fields
  match repository evidence. Hidden coupling is a separate recommendation.
- `doc-drift`: the doc currently cites or historically co-changed with the
  reported subject, the subject changed after the doc's recorded update, any
  broken reference is genuinely unresolved, and the staleness arithmetic
  agrees. A need to update the prose is a separate recommendation.
- `drift`: the reported dependency edge exists and the stated subtype is true:
  no accepted import use survived, an explicit/inferred layer rule rejects the
  edge, or exactly one accepted sibling has the dependency. Architectural harm
  and remediation are separate judgments.
- `wrapper-candidates`: the short production callable has exactly one external
  caller file and its enclosing caller or file has the reported fan-in after
  semantic/source fallback. Removing the named layer is a separate judgment.
- `passthrough-candidates`: the callable has one unique callee and its body
  literally forwards its parameters through a return expression; public or
  boundary value is a separate judgment.
- `stale-abstractions`: the reported type/class has the disclosed real,
  transitive, barrel, singleton, and defining-file use counts and therefore
  matches the stated low-consumer class. Folding or deleting it is a separate
  judgment.

## Reuse Audit

- Extend `scripts/accuracy-calibration.mjs`; it already owns detached
  worktrees, isolated caches, pinned commits, production-analyzer invocation,
  source excerpts, timing, and packet rendering.
- Extend `scripts/accuracy-calibration-core.mjs`; reuse stable row identity,
  grouped relationship/utility verdicts, Wilson intervals, parser validation,
  and per-detector summaries.
- Reuse `normalizeSimilarityCandidate()` and `similarityPacketSummary()` for
  this relationship-plus-utility family. Do not add a third verdict schema.
- Add one generic deterministic stratified sampler because `drift` and
  `doc-drift` contain materially different evidence subtypes whose dominant
  population would otherwise hide the others. No existing sampler preserves
  subtype coverage inside a fixed total sample.
- Import and call the six production analyzers from `dist/queries/index.js`;
  do not reproduce detector logic in the harness.

## Testability Design

| Behavior                         | Test seam                               | Dependencies to inject             | Pure core                            | Side-effect shell                           | Contract                                     |
| -------------------------------- | --------------------------------------- | ---------------------------------- | ------------------------------------ | ------------------------------------------- | -------------------------------------------- |
| Parse architecture batch options | `parseArchitectureCalibrationOptions()` | argument vector, root resolver     | detector/root/sample/seed validation | none                                        | stable selected roots and detector order     |
| Preserve subtype coverage        | `deterministicStratifiedSample()`       | rows, seed, key selector           | deterministic allocation and ranking | none                                        | at most N rows, fair subtype representation  |
| Normalize relationship rows      | existing relationship normalizer        | analyzer result and packet context | stable identity, endpoints, details  | source/Git excerpt lookup in runner         | both evidence sites survive serialization    |
| Collect production analyzers     | `collectArchitectureCandidates()`       | `ScipDatabase`, analyzer functions | result-shape mapping                 | detached worktree, Git, cache, source reads | uncapped count plus deterministic sample     |
| Publish reviewed evidence        | existing relationship renderer/summary  | packet and verdict overlay         | truth and utility summaries          | report writes                               | every detector and zero frame remain visible |

## Design Phases

### 1. Extend the reusable calibration core

- [x] **Files**: `scripts/accuracy-calibration-core.mjs`,
      `tests/scripts/accuracy-calibration-core.test.ts`
- **Source**: the scripts are outside the SCIP TypeScript project; production
  source and consumers are cited in Current State.
- **Change**: Add the six-detector manifest, option parser, and deterministic
  fixed-total stratified sampler. Preserve every existing packet mode.
- **Testability**: Pure option and sampling tests, including dominant strata,
  small strata, duplicate detectors, invalid options, and deterministic replay.
- **Validation**: focused calibration-core Vitest suite.
- **Why**: The sampling method must be trustworthy before corpus results are
  reviewed.

### 2. Add the architecture/history battery

- [x] **File**: `scripts/accuracy-calibration.mjs`
- **Source**: the six `scip-query code` and `plan-context` commands listed in
  Current State.
- **Change**: Add `health-architecture`, direct uncapped analyzer adapters,
  subtype metadata, both evidence endpoints, Git/doc context, durations, and
  the existing relationship/utility packet format.
- **Testability**: Normalize adapters before writing; keep Git, worktree,
  source, and cache operations in the existing runner shell.
- **Validation**: build plus one-detector smoke packets.
- **Why**: CLI display limits must not become calibration population limits.

### 3. Run and classify the pinned baseline

- [x] **Repositories**: Vega_2.0, openwork, Stable_Management, traceroot
- **Source**: commits and capabilities recorded in the generated packet.
- **Change**: Generate complete candidate counts and ten deterministic,
  subtype-aware rows per repository/detector. Review from cited source and Git
  facts, recording truth and utility separately.
- **Validation**: Every sampled row has evidence notes and named archetypes for
  invalid or non-actionable cases.
- **Why**: Relationship errors and poor advice require different fixes.

### 4. Harden only reproduced shared archetypes

- [x] **Files**: selected detector files and focused tests, chosen only after
      source/Git review proves a detector defect.
- **Source**: query-specific `scip-query code`, `trace`, `refs`, and packet
  excerpts for every changed behavior.
- **Change**: Fix the narrowest evidence/filter/classification boundary. Do not
  raise thresholds merely to hide a population.
- **Testability**: Every fix gets a positive and boundary-negative regression.
- **Validation**: focused detector suites and a fresh holdout seed.
- **Why**: Corpus rows are evidence of a shared defect, not tuning targets.

### 5. Publish certification states

- [x] **Files**: reviewed overlays,
      `docs/validation/2026-07-10-typescript-architecture-history-detectors.md`,
      `docs/accuracy-audit-checklist.md`, and
      `docs/accuracy-hardening-goal.md`
- **Source**: baseline, holdout, and regenerated reviewed summaries.
- **Change**: Record relationship precision, Wilson confidence, subtype
  coverage, utility rate, exclusions, performance, residual archetypes, and one
  honest state per analyzer.
- **Validation**: summaries regenerate from committed overlays; no claim exceeds
  its evidence gates.
- **Why**: Public results need reproducible facts and clearly bounded advice.

### 6. Verify the repository

- [x] Run focused and full tests, typecheck, lint, and build.
- [x] Run `scip-query reindex`, matching postchecks, `self-audit`, and
      `scip-query diff-gate --json`; fix or explain every finding.

## Stress-Test Findings

- Full Git history is required for history relationships; unavailable history
  is `unsupported`, never zero.
- A real co-change pair can be planned coordination rather than hidden
  coupling.
- A cited file changing after a doc does not prove the cited claim changed.
- Explicit layer-policy violations are stronger than inferred or unknown-layer
  signals; the packet must preserve the policy basis.
- A one-caller wrapper or literal passthrough may be an intentional trust,
  serialization, process, API, or ownership boundary.
- A single-consumer type may be valuable domain vocabulary; use-count truth
  cannot decide whether the name earns its existence.

## Ship Order

1. Parser and stratified-sampling core.
2. Six production adapters and smoke packets.
3. Four-repository baseline classification.
4. Narrow hardening and regression fixtures.
5. Fresh holdout, overlays, report, and roadmap updates.
6. Full verification and diff gate.

All detector changes are reversible. Public recommendation tiers are externally
visible and require a fresh replay before changing.
