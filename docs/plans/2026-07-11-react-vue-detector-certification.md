# React and Vue Detector Certification Plan

Date: 2026-07-11
Status: Complete

## Goal

Certify or honestly qualify scip-query's React and Vue health detectors against
real framework repositories, fix every source-proven factual defect found in
the reviewed samples, and audit whether Vue augmentation supplies the
compiler-resolved references that downstream graph answers rely on.

A framework detector is an analyzer whose real-world inputs are React
components or Vue single-file components and whose wider class is a
source-analysis command; what distinguishes it is that its claims depend on
framework syntax and lifecycle conventions that a language-only graph cannot
fully identify. A Vue augmented reference is an indexed occurrence whose
real-world referent is a template or script identifier resolved by Volar to a
definition; it is a compiler-derived graph edge distinguished from a textual
name match by preserving the resolved symbol identity.

Done means the six detector families have written truth rules, uncapped
candidate counts from at least three applicable repositories per framework,
deterministic source-reviewed samples, known-positive fixture coverage, final
certification states, and updated roadmap records. `augment-vue` receives a
reference-completeness verdict with its limitations stated explicitly.

## Current State

- React component duplication compares component JSX-token profiles and emits
  shared and unique structural evidence after minimum-overlap and Jaccard
  gates. Source: `scip-query code reactComponentDuplicates` and
  `scip-query code compareReactComponentProfiles`.
- React hook candidates compare behavior-token profiles and disclose shared
  hooks, effects, state, requests, handlers, and handler verbs. Source:
  `scip-query code reactHookCandidates` and
  `scip-query code compareReactHookProfiles`.
- React pressure maps component/file lines plus JSX and behavior token counts
  into pressure axes and context-sensitive recommendations. Source:
  `scip-query code reactLargeComponentPressure` and
  `scip-query code reactPressureResult`.
- Vue component duplication and composable candidates use the shared Vue
  behavior product, then compare template or behavior-token profiles. Source:
  `scip-query code vueComponentDuplicates`,
  `scip-query code compareVueComponentProfiles`,
  `scip-query code vueComposableCandidates`, and
  `scip-query code compareVueComposableProfiles`.
- Vue pressure reports SFC, template, script, style, external-script, custom
  block, and delegated-composable line evidence. Source:
  `scip-query code vueLargeViewPressure` and
  `scip-query code vuePressureResult`.
- Vue augmentation runs auxiliary-document augmentation, computes Volar-backed
  occurrences for every Vue file, deduplicates them, and replaces the Vue
  document chunks in one transaction. Source:
  `scip-query plan-context augmentVueResolvedReferences`,
  `scip-query code computeVueResolvedReferencesForFiles`, and
  `scip-query code runVueAugmentationTransaction`.
- The calibration scripts are executable native ESM and are not represented in
  the project's SCIP index. Source: `scip-query change-surface
scripts/accuracy-calibration.mjs --json --full` returned no indexed target;
  their current mode and packet contracts were located with `rg -n
"health-graph-risk|runTypeScriptDetectorMode|normalizeSimilarityCandidate"
scripts/accuracy-calibration*.mjs`.
- The final applicable read-only corpus is React: Vega_2.0, openwork, and
  traceroot; Vue: Stable_Management, on_main_mvp, Element Plus, and PrimeVue.
  `agent_chat` and Nuxt UI failed TypeScript indexing and were retained as
  explicit capability failures rather than zero-result repositories. Source-file
  inventory was established with `rg --files -g '*.tsx' -g '*.jsx'` and `rg
--files -g '*.vue'` against the pinned Git checkouts.

## Reuse Audit

- Extend `parseTypeScriptDetectorOptions()` through one exported framework
  parser; do not introduce another argument parser. Source: `rg -n
"parseTypeScriptDetectorOptions" scripts/accuracy-calibration-core.mjs`.
- Reuse `runTypeScriptDetectorMode()`, `normalizeSimilarityCandidate()`,
  deterministic stratified sampling, relationship summaries, and relationship
  packet rendering. Framework rows need different collectors and applicability
  metadata, not a second harness. Source: `rg -n
"runTypeScriptDetectorMode|normalizeSimilarityCandidate|deterministicStratifiedSample|renderRelationshipPacket"
scripts/accuracy-calibration*.mjs`.
- Call the six existing public detector functions with an effectively unbounded
  result limit. Do not duplicate detector calculations in the harness. Source:
  the six `scip-query code <detector>` commands listed above.
- Reuse existing React and Vue rich-internals fixtures for known-positive recall
  coverage and add only archetype-specific regressions if real-repository review
  proves a defect. Source: `rg -n
"reactComponentDuplicates|reactHookCandidates|reactLargeComponentPressure"
tests/queries/frontend` and the corresponding Vue query.
- Reuse the augmentation transaction and existing augmentation test seams;
  completeness checks should query produced occurrences and source referents,
  not add another reference resolver. Source: `scip-query code
runVueAugmentationTransaction` and `rg -n "augmentVueResolvedReferences"
tests/reindex`.

## Testability Design

| Behavior                   | Test seam                                                | Dependencies to inject                     | Pure core                                                         | Side-effect shell                                                  | Contract                                                                                           |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Framework option selection | `parseFrameworkCalibrationOptions()`                     | Default roots and root resolver            | Argument validation and detector selection                        | None                                                               | Repeatable detector flags, deterministic seed, explicit roots                                      |
| Candidate packet creation  | `collectFrameworkCandidates()`                           | Existing database and source root          | Row normalization, subtype stratification, applicability metadata | Detached worktree/index lifecycle in `runTypeScriptDetectorMode()` | Uncapped count plus bounded deterministic review rows                                              |
| Detector truth             | Existing six query functions                             | Fixture database/source files              | Existing compare and pressure functions                           | Source/profile loading                                             | Every disclosed token, line, subtype, and score agrees with source                                 |
| Vue reference completeness | Augmentation test fixtures and real-repo packet metadata | Volar language service, temporary database | Occurrence deduplication and expected-reference comparison        | Detached worktree indexing and SQLite publication                  | Resolved Vue identifiers become exact-symbol occurrences; unsupported/skipped cases remain visible |
| Certification summary      | Existing verdict application and summary functions       | Verdict JSON                               | Wilson interval and level selection                               | Packet/report writes                                               | Facts and recommendation utility remain independently classified                                   |

## Design Phases

### 1. Add a framework calibration mode

- [x] **Files**: `scripts/accuracy-calibration-core.mjs`,
      `scripts/accuracy-calibration.mjs`,
      `tests/scripts/accuracy-calibration-core.test.ts`
- **Source**: `rg -n
"parseTypeScriptDetectorOptions|runTypeScriptDetectorMode|renderRelationshipPacket"
scripts/accuracy-calibration*.mjs`; `scip-query code
reactComponentDuplicates`; `scip-query code vueComponentDuplicates`.
- **What**: The harness supports factual, similarity, architecture, and
  graph-risk modes but has no framework detector manifest or collector.
- **Change**: Add framework detector constants, parser coverage, truth rules,
  a `health-framework` mode, uncapped collectors for the six detector outputs,
  delayed source materialization after sampling, and explicit applicability
  metadata. Keep recommendation utility separate from factual validity.
- **Testability**:
  - Test seam: parser unit tests plus packet generation on detached worktrees.
  - Injected dependencies: default roots and database supplied by the harness.
  - Pure core: option parsing, row identity, stratification, and summarization.
  - Side-effect shell: worktree/index/report creation.
  - Contract: no absent framework is reported as a successful zero.
- **Validation**: `npm test -- tests/scripts/accuracy-calibration-core.test.ts`.
- **Why**: A repeatable, uncapped sampling frame must exist before detector
  output can earn a verdict.

### 2. Generate and review React evidence

- [x] **Files**: generated packets under `reports/accuracy/` and final records
      under `docs/validation/`.
- **Source**: `scip-query code reactComponentDuplicates`, `scip-query code
reactHookCandidates`, `scip-query code reactLargeComponentPressure`.
- **What**: The three React detectors expose measurable structural, behavioral,
  and line/token evidence, but have not been certified across real repositories.
- **Change**: Run all three detectors uncapped against Vega_2.0, openwork, and
  traceroot; review a deterministic subtype-stratified sample from cited source;
  record every invalid archetype and recommendation-utility class.
- **Testability**:
  - Test seam: sampled packet rows with both source endpoints.
  - Injected dependencies: read-only repository commits.
  - Pure core: evidence comparison and verdict aggregation.
  - Side-effect shell: detached indexing and report generation.
  - Contract: a valid row proves disclosed evidence, not that extraction is wise.
- **Validation**: summarized reviewed packet plus existing rich-internals known
  positives.
- **Why**: React findings cannot inherit TypeScript certification because JSX
  structure and hook lifecycles are framework-specific evidence.

### 3. Generate and review Vue evidence and augmentation coverage

- [x] **Files**: generated packets under `reports/accuracy/`, final records
      under `docs/validation/`, and augmentation tests if a defect is found.
- **Source**: `scip-query code vueComponentDuplicates`, `scip-query code
vueComposableCandidates`, `scip-query code vueLargeViewPressure`,
  `scip-query plan-context augmentVueResolvedReferences`.
- **What**: The Vue detectors consume template/script profiles and downstream
  graph answers rely on Volar augmentation, but neither has a real-repository
  certification record.
- **Change**: Run the three detectors uncapped against Stable_Management,
  on_main_mvp, and agent_chat; record augmentation counts, skipped-reference
  counts, and source-verified known references; classify completeness gaps as
  defects, explicit unsupported shapes, or insufficient evidence.
- **Testability**:
  - Test seam: sampled SFC pairs/files and focused augmentation fixtures.
  - Injected dependencies: Volar language service and temporary indexes.
  - Pure core: disclosed-evidence comparison and occurrence deduplication.
  - Side-effect shell: reindex/augmentation publication.
  - Contract: missing capability is `not analyzed`, never a clean zero.
- **Validation**: reviewed packet and targeted augmentation tests.
- **Why**: Vue SFC resolution differs from ordinary TypeScript indexing, so
  detector precision and reference completeness need separate evidence.

### 4. Harden defects and replay fresh samples

- [x] **Files**: only source/profile/query files implicated by reviewed invalid
      archetypes, plus focused regression tests.
- **Source**: rerun the exact `scip-query plan-context <affected-symbol>` and
  `scip-query change-surface <affected-file> --json --full` before each edit.
- **What**: No production defect is assumed; reviewed invalid rows determine
  the smallest correction.
- **Change**: Fix root-cause archetypes rather than individual repository rows,
  preserve additive public contracts where possible, and replay both the
  original deterministic sample and a fresh holdout seed.
- **Testability**:
  - Test seam: pure comparison/profile helper or augmentation fixture nearest
    the defect.
  - Injected dependencies: fixture source and database only.
  - Pure core: token, line, classification, or reference decision.
  - Side-effect shell: index/cache publication remains unchanged unless it is
    the proven defect.
  - Contract: fixed invalid archetype disappears without hiding valid findings.
- **Validation**: targeted tests, original reviewed sample, and holdout packet.
- **Why**: Certification measures the hardened implementation, not the first
  implementation sampled.

### 5. Publish verdicts and update the roadmap

- [x] **Files**: `docs/accuracy-audit-checklist.md`,
      `docs/accuracy-hardening-goal.md`,
      `docs/validation/2026-07-11-react-vue-detectors.md`,
      `docs/validation/2026-07-11-react-vue-detector-verdicts.json`, this plan,
      and `.scipquery/ledger/events.jsonl` when the gate records outcomes.
- **Source**: reviewed packet summaries and the certification thresholds in
  `docs/accuracy-hardening-goal.md`.
- **What**: The roadmap still lists all React/Vue detectors and augmentation as
  pending.
- **Change**: Record exact corpus commits, uncapped counts, sample counts,
  precision intervals, known-positive cases, false-positive archetypes,
  recommendation utility, certification states, and unresolved limits.
- **Testability**:
  - Test seam: deterministic verdict application and document cross-check.
  - Injected dependencies: reviewed packet and verdict groups.
  - Pure core: certification summary.
  - Side-effect shell: committed Markdown/JSON records.
  - Contract: no qualified or insufficient detector is described as certified.
- **Validation**: `scip-query doc-drift --json --full` and manual count parity
  between reviewed JSON and Markdown.
- **Why**: Publication trust depends on durable evidence, not an ephemeral run.

### 6. Verify and commit

- [x] **Files**: full diff.
- **Source**: `scip-query diff-impact --json` and routed postchecks from the
  `scip-verify` shared reference.
- **What**: Framework query files are medium-risk public surfaces with health,
  recent-duplicate, query export, and CLI consumers. Source: `scip-query
change-surface src/queries/frontend/react-component-duplicates.ts --json
--full` and the corresponding Vue command.
- **Change**: Run targeted tests, typecheck, lint, formatting, build, full tests,
  framework detector postchecks when production files changed, reindex, health
  baseline, doc drift, self-audit when generated surfaces changed, and the diff
  gate; commit all code, docs, and required repository records together.
- **Testability**:
  - Test seam: project commands and diff-specific graph checks.
  - Injected dependencies: none.
  - Pure core: covered by unit tests.
  - Side-effect shell: exercised by detached calibration and project reindex.
  - Contract: final index is fresh and diff gate passes or every row is explained.
- **Validation**: `scip-query reindex && scip-query diff-gate --json` plus the
  repository's full test/build checks.
- **Why**: The campaign is complete only when its implementation and evidence
  records ship together.

## Stress-Test Findings

- **Purpose**: Preserve the distinction between a true similarity/pressure
  measurement and a useful refactoring recommendation.
- **Blast radius**: Detector result shapes feed health, recent duplicates,
  public exports, and CLI rendering; additive fields are preferred and every
  touched consumer must be tested.
- **Valid intermediate state**: Harness and evidence commits can describe the
  current detectors even if no production fix is required.
- **Reversibility**: Harness/report changes are two-way doors; any public result
  semantics change is treated as a medium-risk contract correction.
- **Failure**: Missing repositories, failed indexers, absent Volar support, and
  malformed cache/report data remain explicit errors or unsupported states.
- **Concurrency**: Each corpus run gets a detached worktree and unique cache;
  no target checkout or shared project index is mutated.
- **Boundaries**: Framework applicability is checked from indexed file kinds
  before interpreting a zero finding count.
- **Data integrity**: Raw generated packets remain ignored artifacts; distilled
  verdict JSON and Markdown are committed and tied to exact commits.
- **Observability**: Per-repository duration, candidate counts, subtype counts,
  capability state, and augmentation metrics are recorded.
- **Human experience**: Reports explain facts in source terms and avoid telling
  users to extract components/hooks merely because a score crossed a threshold.
- **Reuse**: Existing packet, sampling, detector, and augmentation paths are the
  extension points; no parallel resolver or certification engine is introduced.
- **Testability**: Every behavior has a pure or fixture-level seam before the
  detached real-repository run.

## Execution and Ship Order

1. Add and test the reusable framework calibration mode.
2. Run and review the React corpus.
3. Run and review the Vue corpus and augmentation evidence.
4. Apply only source-proven hardening fixes and replay a holdout sample.
5. Commit the final verdict JSON, validation narrative, checklist, roadmap,
   plan completion state, and any ledger event with the implementation.

The only potential one-way door is a correction to a public detector result
shape or meaning. If required, it must be additive where possible and disclosed
as an API-impact note; otherwise all phases are independently reversible.

## File Summary

- Create: framework certification plan, verdict JSON, and validation narrative.
- Edit: calibration core/runner, parser tests, roadmap/checklist, and only those
  detector/profile/augmentation tests and sources justified by reviewed defects.
- Delete: none planned.
- Verify: all affected frontend queries, augmentation, health consumers,
  generated documentation if touched, and the final repository diff.
