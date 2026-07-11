# Accuracy Hardening and Health Certification Roadmap

Date: 2026-07-10
Status: Active; TypeScript dead-code, four factual detectors, and three similarity relationships certified; Rust dead-code hardened but insufficiently evidenced

## Goal

Make scip-query's reported health findings trustworthy enough to publish for
real open-source repositories. Trust is earned per detector, language, and
evidence capability; it is not inherited from the composite health score or
from calibration on a different ecosystem.

This program uses existing repositories as its primary evidence. Small
fixtures remain regression tests, while historical fixes and temporary
mutations in disposable worktrees provide known-positive cases for measuring
what a detector misses.

## Accuracy Contract

Precision is the share of reported findings that satisfy the detector's truth
rule after the cited code is inspected. Recall is the share of known real
problems that the detector reports. Precision protects users from false
accusations; recall measures the problems the tool fails to show. Neither can
substitute for the other.

A truth rule is the repeatable decision procedure that makes two reviewers
classify the same candidate consistently. Every detector must define its rule
before its findings are sampled.

### Certification levels

| Level                 | Evidence requirement                                                                                                                                                 | Public treatment                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Certified             | Observed precision at least 95%, conservative 95% confidence lower bound at least 90%, evidence from at least three repositories, and known-positive recall coverage | Actionable finding                               |
| Qualified             | Observed precision at least 90% but not all certified gates are met                                                                                                  | Investigation signal                             |
| Experimental          | Observed precision below 90% or a known unresolved noise archetype can produce finding walls                                                                         | Omit from public results; retain for development |
| Unsupported           | Required parser, semantic provider, checker, framework model, or repository input is unavailable                                                                     | Report `not analyzed`, never zero                |
| Insufficient evidence | Too few reviewed findings or known-positive cases to estimate performance                                                                                            | Report uncertified status, never imply accuracy  |

The conservative lower bound is the plausible floor after accounting for
sample size. For orientation, 95 valid rows out of 100 is 95% observed
precision but does not establish a 90% lower bound; about 97 out of 100 or 190
out of 200 does.

Certification is recorded independently for each detector-language pair and,
where framework behavior changes reachability, for the applicable framework
cohort. An aggregate percentage may summarize certified rows, but it must
never hide an uncertified combination.

## Publication Contract

Until certification is complete, the composite health score is a local
prioritization aid and is not eligible for a public cross-repository
leaderboard.

Public output must:

- separate derived measurements, compiler/graph-backed candidates, and
  investigation signals;
- identify language, detector version, indexer or semantic provider, commit,
  dependency-install state, and capability status;
- report applicable production files or lines, excluded candidates, and
  exclusion reasons;
- distinguish a supported zero from `unsupported`, `degraded`, and `not
analyzed`;
- normalize applicable findings by production lines or applicable files, not
  by every indexer-emitted symbol;
- keep React, Vue, Rust macro/trait, Python framework, and other stack-specific
  cohorts out of universal comparisons unless applicability is normalized;
- disclose Git-history coverage and commit filters for history-derived
  measurements; and
- preserve the raw result and analysis version so a published result can be
  reproduced after detector changes.

Facts and recommendations must remain separate. Identical bodies, dependency
cycles, branch counts, or Git change counts can be reproducible facts; a claim
that code should be consolidated, split, or deleted requires additional
evidence.

## Real-Repository Corpus

The first calibration corpus uses repositories already available locally.
They remain read-only; any deletion test or planted known-positive case runs
in an isolated worktree or temporary clone.

| Cohort     | Initial repositories                                 | Coverage purpose                                                                                                    |
| ---------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| TypeScript | Vega_2.0, openwork, Stable_Management, traceroot     | React, workspaces, packages, backend code, and mixed-language boundaries                                            |
| Rust       | openai/codex, SynthRunnerRust                        | Large workspace plus small crate; traits, derives, macros, generated code, async runtimes, and public APIs          |
| Python     | scip-python, traceroot, Python files in openai/codex | Large Python codebase, mixed repositories, decorators, framework registration, and current semantic-capability gaps |

Additional public repositories may be added to cover a missing framework or
repository shape. Corpus additions must address a named gap rather than merely
increase volume.

## Detector Truth Rules

Each detector gets a more detailed rule in its calibration manifest. The
starting rules are:

- **Dead code:** no production, public API, framework, generated, reflective,
  configured, FFI, macro, or test-required consumer exists, and removal passes
  every available checker covering the file. A missing checker prevents a
  certified deletion claim.
- **Dependency cycle:** the reported files and dependency edges exist in the
  accepted index. The cycle is factual; architectural harm is a separate
  signal.
- **Exact duplicate body:** normalized callable bodies are equal. The equality
  is factual; consolidation is a recommendation.
- **Complexity measurement:** source lines, branches, and cyclomatic estimate
  match the stated AST or fallback basis. The composite hotspot product is a
  prioritization signal, not cyclomatic or cognitive complexity.
- **Similarity, twins, wrappers, passthroughs, stale abstractions, extraction,
  frontend pressure, and hidden coupling:** the emitted evidence must match
  the code, but actionability is an investigation verdict until the
  detector-language pair earns certification.

## Roadmap

### Phase 0 — Freeze the calibration and publication schemas

- Define the machine-readable calibration manifest, reviewed-row schema,
  detector truth rule, verdict vocabulary, and noise-archetype vocabulary.
- Record repository, commit, tool version, detector version, language,
  framework cohort, evidence provider, capability state, finding ID, file and
  line, exclusion reasons, reviewer verdict, checker result, and review notes.
- Add Wilson confidence intervals and per-detector-language certification
  status. Do not calculate one global accuracy number as the primary result.

Exit: the same reviewed rows always produce the same precision, confidence,
and certification decision.

### Phase 1 — Extend the real-repository calibration harness

The current `scripts/accuracy-calibration.mjs` harness proves selected
navigation answers against known source facts and records timing. Extend it
without making local repositories a normal test dependency.

- Run health detectors in full, uncapped mode against temporary indexes.
- Select deterministic random and stratified samples instead of only top
  findings.
- Produce a review ledger with `valid`, `invalid`, and `uncertain` verdicts.
- Preserve candidate evidence and source locations needed for code review.
- Group invalid findings by named noise archetype.
- Support a fresh holdout sample that was not used while fixing the detector.
- Replay selected historical commits and temporary known-positive mutations
  in isolated worktrees for recall.

Exit: one command can generate a reproducible calibration packet without
modifying any corpus repository.

### Phase 2 — Certify TypeScript dead-code findings

- Review approximately 25 deterministic candidates each from Vega_2.0,
  openwork, Stable_Management, and traceroot for a 100-row baseline.
- Verify public exports, ambient declarations, decorators, framework
  registration, workspace/barrel consumers, generated entry points, and test
  boundaries.
- Fix shared false-positive archetypes rather than suppressing individual
  examples or raising thresholds until output looks clean.
- Re-run the original sample and a fresh holdout sample.
- Exercise known positives from historical deletions or isolated worktree
  mutations to establish recall coverage.

Exit: TypeScript dead code is certified, qualified, or explicitly retained as
experimental with every failed criterion recorded.

### Phase 3 — Certify TypeScript measurements and remaining detector families

Work in evidence order:

1. cycles, exact duplicates, raw complexity measurements, unused imports, and
   unused parameters;
2. recent duplicates, similarity, co-change, and doc drift;
3. twins, wrappers, passthroughs, stale abstractions, extraction candidates,
   React/Vue duplication and pressure, and hidden coupling.

Detectors below 90% remain absent from public output even when useful during
interactive exploration.

Exit: every TypeScript health family has a current certification state and a
published list of unresolved noise archetypes.

### Phase 4 — Certify Rust and replace silent bias with visible applicability

- Calibrate on openai/codex and SynthRunnerRust, then add at least one more
  public Rust repository before awarding certified status.
- Measure trait, trait-implementation, derive, attribute-macro, test,
  generated-code, async-runtime, ABI/export, and public-library behavior.
- Replace silent broad exclusions with reported applicability states and
  exclusion counts wherever the tool cannot prove runtime reachability.
- Prefer rust-analyzer or SCIP evidence over framework-name rules. A
  conservative exclusion may protect precision, but it must not make a
  macro-heavy repository appear objectively healthier through invisible
  omissions.
- Verify candidate deletion with `cargo check` when available and report when
  build scripts, features, targets, or missing dependencies limit coverage.

Exit: each Rust detector is certified, qualified, experimental, unsupported,
or insufficiently evidenced, with exclusion coverage visible.

### Phase 5 — Build and certify Python semantic and framework coverage

- Establish the current indexing, semantic, and checker capability separately
  for each corpus repository.
- Add or integrate semantic reference evidence before making strong dead-code
  claims.
- Model decorator and registration behavior for Django, FastAPI, Flask,
  pytest fixtures, Click/Typer, dataclasses, and Pydantic as corpus evidence
  requires.
- Treat unsupported semantic or checker paths as `not analyzed`, not clean.
- Calibrate on scip-python, traceroot, and at least one additional public
  Python repository with a different framework shape.

Exit: Python findings meet the same thresholds as TypeScript and Rust, or the
public capability matrix clearly withholds unsupported families.

### Phase 6 — Replace the leaderboard score with certified evidence views

- Publish per-language and per-framework finding families, coverage, and
  certification status before considering a composite score.
- Normalize only within comparable cohorts and applicable production code.
- Version methodology and retain historical results under the detector version
  that produced them.
- Ensure health actions use calibrated language: facts, candidates, signals,
  and unsupported analyses cannot share defect wording.

Exit: two repositories cannot change relative rank merely because one uses a
framework-specific detector or contains more excluded/test/generated symbols.

### Phase 7 — Run a private cloud shadow leaderboard

- Analyze immutable clean checkouts for new commits with reproducible
  dependency setup or an explicit degraded-mode disclosure.
- Reuse parent-commit indexes and semantic evidence through the completed
  automatic incremental indexing system.
- Run for several weeks across diverse public repositories, auditing top
  findings, commit-to-commit stability, coverage changes, and detector-version
  rank changes.
- Publish only after certified detector output remains stable and
  reproducible; keep experimental detectors private.

Exit: the service can reproduce any result from repository commit, analysis
version, configuration, capability record, and preserved raw output.

## Completed Foundation

The previous accuracy-hardening program established:

- source-backed fixture/oracle checks for navigation commands;
- an optional real-repository calibration script using temporary caches;
- fail-closed mixed-language indexing with explicit partial opt-in;
- Rust path-qualified lookup and call-graph regression coverage;
- candidate/disclaimer language for heuristic commands; and
- optional timing and index-size metadata.

Those checks prove that selected commands retrieve expected source and graph
facts. They do not certify health-finding precision or recall, which is the
active program above.

## Immediate Next Slice

Continue Phase 3 with TypeScript extraction/locality and graph-risk signals:
`extract-candidates`, `locality-candidates`, coupling, bottlenecks, deep chains,
hotspots, and fan-in/fan-out; then certify React and Vue duplication,
composition, and pressure analyzers.
Expand targeted corpus or historical cases for the factual and similarity
detectors that remain insufficiently evidenced. In parallel, renew Rust `dead`
against additional repositories or historical commits until its sparse
post-hardening frame satisfies the same statistical gates.

## Progress — 2026-07-10

The first TypeScript dead-code baseline is complete:
[`2026-07-10-typescript-dead-certification-baseline.md`](./validation/2026-07-10-typescript-dead-certification-baseline.md).
Across 78 deterministic rows from Vega_2.0, openwork, Stable_Management, and
traceroot, 25 were valid and 53 invalid: 32.1% observed precision with a 95%
Wilson interval of 22.7%–43.0%. The detector remains experimental.

Those five causes were fixed, and a second review exposed React lifecycle,
implemented-protocol, and nested Next.js proxy roots. The final certificate is
recorded in
[`2026-07-10-typescript-dead-certification.md`](./validation/2026-07-10-typescript-dead-certification.md).
The final fixed-seed sample contained 43 valid findings and zero invalid
findings across four repositories: 100% observed precision with a 91.8% 95%
Wilson lower bound, plus three positive-recall fixtures. TypeScript `dead` is
therefore certified under its repository-dead truth rule. This does not certify
Rust, Python, other TypeScript detectors, or the aggregate health score.

The Rust `dead` baseline and hardening replay are also complete:
[`2026-07-10-rust-dead-certification-baseline.md`](./validation/2026-07-10-rust-dead-certification-baseline.md)
and
[`2026-07-10-rust-dead-certification.md`](./validation/2026-07-10-rust-dead-certification.md).
The baseline found 1 valid and 51 invalid rows. Cargo library rooting and an
explicit `implicit-usage` signal tier removed every reviewed false positive;
the pinned replay produced three valid findings and zero invalid findings.
That is 100% observed precision, but the 43.8% Wilson lower bound and
one-repository finding sample are too small for certification. Rust `dead`
therefore remains insufficiently evidenced and must not be presented as a
public actionable metric. Three positive fixtures protect private-library and
binary-only recall while the corpus is expanded.

The TypeScript factual-detector campaign is complete:
[`2026-07-10-typescript-factual-detectors.md`](./validation/2026-07-10-typescript-factual-detectors.md).
`unused-imports` (59/59), `duplicate-bodies` (40/40), raw `complexity`
(40/40), and `redundant-reexports` (40/40) are certified under their narrow
fact rules. `unused-params`, `cycles`, `isolated`, `not-implemented`,
`decorative-checkers`, and `test-quality` were audited and hardened but remain
insufficiently evidenced because their surviving real-repository frames lack
the required row count or repository breadth. The campaign removed import-use,
ambient dependency-edge, framework-contract, re-export-attribution,
delegated-checker, and implicit-test-assertion false-positive archetypes.

The TypeScript general-similarity campaign is also complete:
[`2026-07-10-typescript-similarity-detectors.md`](./validation/2026-07-10-typescript-similarity-detectors.md).
The `similar`, `similar-files`, and `similar-signatures` relationship claims are
certified at 36/36, 40/40, and 40/40 valid rows across four repositories.
`similar-chains` is qualified because its correct 40/40 sample came from a
bounded 500-path input frame, and none of its sampled consolidation advice was
actionable. `twin-drift` is qualified at 37/40 (92.5%) after constant,
near-name, test-helper, and convention-only filtering. `recent-duplicates` is
8/8 after generic React-plumbing hardening but remains insufficiently
evidenced. The campaign now records factual relationship validity separately
from recommendation utility.

The TypeScript architecture/history campaign is complete:
[`2026-07-10-typescript-architecture-history-detectors.md`](./validation/2026-07-10-typescript-architecture-history-detectors.md).
The `co-change`, `doc-drift`, and `stale-abstractions` relationship claims are
certified at 40/40 valid rows across four repositories. `drift` is qualified at
40/40 because the population was 39 pattern deviations, one inferred layer,
and a supported zero for unused-import rows; none of the sampled drift advice
was actionable without ownership evidence. `wrapper-candidates` is qualified
at 30/30 with an 88.6% confidence floor, while `passthrough-candidates` remains
insufficient at 21/21. The campaign removed ambient-declaration, generated
co-change state, and structural-token feature-label noise.

## Program Acceptance Criteria

- Every health detector-language pair has a visible certification state.
- Public actionable findings meet the certified threshold; public signals
  meet the qualified threshold; lower-precision rows remain private.
- Precision samples span at least three repositories, and recall has
  known-positive evidence.
- False positives are tracked as named archetypes with regression coverage,
  not hidden by unreasoned suppressions.
- Unsupported and degraded analyses cannot appear as zero findings.
- Rust exclusions and framework-specific applicability are reported rather
  than silently improving comparative results.
- Python does not make strong semantic health claims until the required
  provider and checker evidence exists.
- Public comparisons are reproducible, versioned, coverage-aware, and limited
  to comparable cohorts.
- `npm test`, `npm run typecheck`, and `npm run build` pass after each
  implementation slice.
- Completed code or documentation changes pass `scip-query reindex` and
  `scip-query diff-gate` before being declared finished.
