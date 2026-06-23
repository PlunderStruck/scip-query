# SCIP Maintainability Register - 2026-06-23

## Executive Read

This review asks: what future-maintenance mistakes does the current structure invite, and what smaller named mechanisms would prevent them without hiding real variation?

A maintainability pressure is a codebase fact visible in files, symbols, callers, tests, or docs that makes future edits harder because a maintainer must coordinate the same rule in more than one place. A system-compression opportunity is a source-code change that replaces several mechanisms doing the same job with fewer named mechanisms while preserving behavior and preserving real differences forced by framework contracts, language facts, or public APIs.

The repository remains mechanically clean: `scip-query health --json` reports score 100, no active dead, wrapper, passthrough, stale, drift, cycle, hidden-coupling, or recent-duplicate findings. That is not the maintainability conclusion. The current pressure is narrower: a few local policies are repeated by hand, while several older broad signals are now best treated as accepted boundaries rather than refactor targets.

## Completion Status

Completed implementation is tracked in `docs/plans/2026-06-23-maintainability-register-completion-plan.md`.

| Item                                              | Status                     | Resolution                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 / P1 frontend behavior evidence classification | Done                       | Added `src/queries/internal/frontend-behavior-evidence.ts` and rewired React/Vue behavior analyzers to share evidence-class, action-tier, token extraction, sorting, and behavior similarity policy while keeping framework-specific profile builders and meaningful-overlap thresholds local. The component duplicate analyzers also reuse the shared token extraction and sorting helpers. |
| C2 / P1 diff-gate finding construction            | Done                       | Added a local `DiffGateFindingDraft` and `recordFinding()` normalizer so every check gets the same suppression-hint format from `finding.check` and `finding.id`.                                                                                                                                                                                                                            |
| C3 / P2 query command order duplication           | Done                       | Exported `orderedQueryCommandDescriptors` from `query-command-specs.ts` and made `commandDescriptors` consume named slices of that ordered descriptor list instead of repeating every `query(...)` entry.                                                                                                                                                                                    |
| P2 suppression comments                           | Closed as deferred         | No direct code cleanup recommended. The June 21 suppression lifecycle review found sampled suppressions recent and justified; the remaining action is to use repeated rationales as design input when nearby code is touched.                                                                                                                                                                |
| P3 `ProjectIndex` facade                          | Closed as skipped          | The production-callable gate is already centralized; splitting `ProjectIndex` now would move stable facade behavior without reducing a current policy duplication.                                                                                                                                                                                                                           |
| Deferred boundaries                               | Closed as skipped/deferred | `watch.ts` vs `cli-context.ts` and language parser similarity remain false compression targets because their real-world units differ.                                                                                                                                                                                                                                                        |

## Scope Map

- Indexed scope: 226 documents, 11,068 symbols, 24,233 references; `scip-query status` reports the index as fresh with TypeScript semantics available.
- Query frontend scope: six files under `src/queries/frontend`, depended on by health, recent-duplicates, public query exports, and cleanup command handlers.
- Impact scope: six files under `src/queries/impact`; `src/queries/impact/diff-gate.ts` is the dominant unit at 1,101 lines and 14 external consumers.
- Command scope: nine files under `src/runtime/commands`; `commandDescriptors` is the CLI registration surface, while `queryCommandOrder` is the private query-order list.
- Detector probes: `similar-files` reports only the already-rejected `watch.ts`/`cli-context.ts` pair; `extract-candidates` reports 20 broad workflow candidates; `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions --include-low-confidence`, `drift`, `cycles`, and `recent-duplicates --full` are clean.

## Smell Ledger

| Priority | Smell                                                                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Why it hurts                                                                                                                                                                                                                                                                        | Better shape                                                                                                                                                                                                                                                                                                     | Disposition |
| -------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| P1       | Frontend behavior evidence classification is duplicated across React and Vue analyzers.                         | `src/queries/frontend/react-hook-candidates.ts` and `src/queries/frontend/vue-composable-candidates.ts` both define evidence class, action tier, `compareProfiles`, name classification, domain-word filtering, behavior similarity, token extraction, sorted tokens, recommendation text, and reason rendering. `extract-candidates` flags both `compareProfiles()` functions as broad helper clusters. `change-surface` reports each file has 10 external consumers.                                                                                                                              | Tuning "domain behavior vs generic scaffolding" means editing two parallel classifiers and keeping the same output vocabulary aligned by memory. The framework profile builders are different, but the evidence-class decision shape is the same.                                   | Extract a small behavior-evidence classifier that accepts framework vocabulary, token groups, and recommendation copy. Keep React/Vue profile collection and meaningful-overlap thresholds local because those are essential framework variation.                                                                | `extract`   |
| P1       | Diff-gate finding construction repeats the same lifecycle in each check.                                        | `src/queries/impact/diff-gate.ts` has local `run*Check()` functions for echo, incomplete-migration, co-change-partner, doc-reference, unused-params, new-dead, and baseline. Each pushes `DiffGateFinding` objects with repeated `id`, `check`, `severity`, `evidence`, `actionTier`, `file`, `relatedFiles`, `message`, `why`, `remediation`, and `suppressionHint` conventions. `outline` shows the file spans 1,101 lines; `change-surface` reports 14 external consumers; `extract-candidates` flags `diffGate()`, `runEchoCheck()`, `runCoChangePartnerCheck()`, and `runDocReferenceCheck()`. | A new diff-gate check can easily drift on identity, suppression hints, root-cause grouping, or check-run/skipped bookkeeping. The file currently centralizes the workflow, which is good; the risk is that the per-check result contract is caller folklore inside object literals. | Introduce one small local finding-construction mechanism, such as a `DiffGateFindingDraft` normalizer or `recordDiffGateFinding()`, that owns stable IDs, suppression hints, and default fields. Do not split checks into separate files yet; the cross-check grouping and shared impact plan are real cohesion. | `enforce`   |
| P2       | Query command order is represented twice.                                                                       | `src/runtime/commands/query-command-specs.ts` defines private `queryCommandOrder` and guards that every family descriptor is ordered. `src/runtime/commands/command-descriptors.ts` still hand-lists 61 individual `query('...')` entries. Tests prove CLI commands match `commandDescriptors`, but they do not derive command registration from `queryCommandOrder`.                                                                                                                                                                                                                               | Adding a query requires touching the family descriptor, `queryCommandOrder`, and the hand-written `query(...)` registration list. The guard catches descriptors missing from the order, but not an ordered query that never reaches `commandDescriptors`.                           | Export an ordered query descriptor list from `query-command-specs.ts`, then spread it into `commandDescriptors`. Keep explicit custom commands around that generated list where their placement is intentional.                                                                                                  | `generate`  |
| P2       | Suppression comments still form a distributed architecture vocabulary.                                          | `health --json` reports 174 source suppressions: 72 extract, 62 wrapper, 17 stale, 15 similar, and 8 passthrough. `rg "scip-query: ignore"` shows comments naming accepted boundaries in source evidence, storage caches, AST runtime, diff-gate, Vue augmentation, and language parsers. `docs/validation/2026-06-21-suppression-lifecycle-result.md` says the sampled suppressions are recent and justified.                                                                                                                                                                                      | The comments are not cleanup debt, but they are how maintainers learn which boundaries are intentional. That knowledge is currently spread across many source files.                                                                                                                | Keep the comments for detector calibration, but use them as a design corpus: repeated rationales should graduate into module-level decision notes or typed policy names only when a nearby refactor touches that code.                                                                                           | `defer`     |
| P3       | `ProjectIndex` remains the high-blast-radius evidence facade, but the latest evidence says not to split it now. | `change-surface src/core/project-index.ts` reports 122 external consumers, 26 consumers of `ProjectIndex`, 24 of its constructor, and 10 consumers of `productionCallableDefinitions()`. The production-callable gate is now centralized in `src/core/production-callables.ts`, and `ProjectIndex.productionCallableDefinitions()` is deliberately marked as a facade.                                                                                                                                                                                                                              | A maintainer can still overuse the facade as a dumping ground, but the previous pressure around scattered detector exclusion policy has been compressed. Splitting `ProjectIndex` now would mostly move stable public entry points around.                                          | Preserve the facade. Any future extraction should be driven by a new policy owner with multiple direct consumers, not by file-risk score alone.                                                                                                                                                                  | `skip`      |

## Compression Opportunities

### C1 - Shared Frontend Behavior Evidence Classifier

The real units are React hook-candidate results and Vue composable-candidate results: both classify shared behavior tokens into domain behavior, generic workflow scaffolding, mixed evidence, or shared abstraction. The wider class is a pairwise frontend behavior analyzer; the distinguishing fact is that it turns framework-specific token groups into the same action-tier and recommendation vocabulary.

Conservative model: leave both files alone and accept duplicated policy. This preserves framework clarity but keeps future score/reason tuning synchronized by hand.

Shape-level model: extract a private `frontend-behavior-evidence` helper that owns `classifyNames`, domain-word filtering, evidence-class selection, `behaviorSimilarity`, `tokenValues`, and `sortedTokens`, with React/Vue supplying token-group labels, generic word sets, and recommendations. This removes duplicated policy while keeping framework facts local.

Radical model: merge React and Vue candidate analyzers behind one metadata-driven analyzer. This is false compression today because React components and Vue SFCs have different source profiles, token kinds, line counts, route signals, and user-facing result fields.

Recommendation: choose the shape-level model when this area is touched next.

### C2 - Diff-Gate Finding Normalizer

The real units are seven diff-gate checks that each produce `DiffGateFinding` records. The wider class is a check result emission lifecycle; the distinguishing fact is that each check must produce stable identity, suppression, grouping, severity, evidence, and remediation fields for the same gate result.

Conservative model: add tests for suppression hints and IDs only. This catches drift late but leaves repeated construction policy in every check.

Shape-level model: add a small local normalizer or recorder that derives suppression hints and applies defaults from `{ check, idParts, file, message, why, remediation }`. This keeps check-specific evidence local while making the shared contract explicit.

Radical model: split every check into its own module and registry. This is premature because `diffGate()` intentionally shares one `DiffImpactPlan`, one changed-file set, one structured suppression pass, and one root-cause grouping pass.

Recommendation: choose the shape-level model, with focused tests around finding IDs, suppression hints, and skipped/checks-run behavior.

### C3 - Ordered Query Descriptor Export

The real units are the private query order and the CLI registration list. The wider class is command surface metadata; the distinguishing fact is that user-visible command registration should be derived from the same ordered descriptor set used to check query family coverage.

Conservative model: add a test that scrapes `command-descriptors.ts` and compares the `query(...)` calls to `queryCommandOrder`. This catches drift but blesses string scraping.

Shape-level model: export `orderedQueryCommandDescriptors` from `query-command-specs.ts` and replace the 61 hand-written `query(...)` calls with a spread. This deletes the duplicate list and makes the existing order guard stronger.

Radical model: move all command descriptors, including non-query operational commands, into one generated manifest. This would hide intentional placement of lifecycle commands such as `health`, `install-skills`, `doctor`, and `watch`.

Recommendation: choose the shape-level model.

## Deferred Boundaries

- `src/runtime/watch.ts` and `src/runtime/cli-context.ts` remain a false compression target. `similar-files` reports them as 100% similar because they share config, gitignore filtering, and runtime paths, but their referents differ: one is a long-running watcher state machine, the other is a CLI project/database context opener.
- Language-parser similarity remains mostly essential variation. Per-language AST walkers share parse helpers, but the grammar facts differ.
- Suppression count is a calibration signal, not proof of debt. The June 21 validation result found sampled suppressions justified; this register treats them as design evidence.
- Health score remains a smoke signal only. A score of 100 means current detectors are quiet; it does not prove concept boundaries cannot be improved.

## Implementation Verification

The register items are now closed in code or explicitly closed as deferred/skipped boundaries. The completion slice removed duplicated frontend evidence policy, normalized diff-gate finding emission, and derived CLI query registration from the ordered query descriptor list.

Post-change verification:

- `npm run typecheck` passed.
- `npm test` passed: 68 test files, 354 tests.
- `scip-query incomplete-migration` passed with no incomplete migrations.
- `scip-query recent-duplicates --full`, `unused-params`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions --include-low-confidence`, `drift`, and `co-change src/runtime/commands/query-command-specs.ts` reported no actionable findings.
- `scip-query health --json` reported score 100 with no active dead, wrapper, passthrough, stale, drift, cycle, hidden-coupling, or recent-duplicate findings. It reports one accepted heuristic similarity signal for the React/Vue component duplicate `compareProfiles()` pair.
- `scip-query health --write-baseline` recorded that accepted React/Vue component comparer signal in `.scipquery-baseline.json`; `scip-query health --baseline` then passed with no new findings.
- `scip-query similar classifyFrontendBehaviorEvidence` reported only a low-similarity internal helper/function overlap inside the new helper, not a separate extraction target.
- `scip-query similar-files` still reports the accepted `watch.ts`/`cli-context.ts` false-compression pair and intentional frontend analyzer family pairings caused by the shared frontend evidence helper.
- `scip-query redundant-reexports` still reports public-barrel API signals and an analyzer-noise cleanup descriptor helper; none were introduced by C1-C3 and none are part of this register's actionable closure.
- `scip-query doc-drift` reports pre-existing stale historical validation notes; diff-gate doc-reference checks pass after the 2026-06-23 citation-refresh notes.
- `scip-query diff-impact` reports 8 changed code files, 37 changed symbols, and 1 affected consumer file.
- `scip-query reindex && scip-query diff-gate` passed: this change introduces no gate findings.

Commands run for this register:

- `scip-query status`
- `scip-query stats`
- `scip-query system src`
- `scip-query surface src`
- `scip-query files 'src/**/*.ts'`
- `scip-query health --json`
- `scip-query similar-files`
- `scip-query similar-chains`
- `scip-query extract-candidates`
- `scip-query wrapper-candidates`
- `scip-query passthrough-candidates`
- `scip-query stale-abstractions --include-low-confidence`
- `scip-query drift`
- `scip-query cycles`
- `scip-query complexity-hotspots`
- `scip-query hotspots`
- `scip-query recent-duplicates --full`
- `scip-query co-change` for `diff-gate.ts`, `react-hook-candidates.ts`, and `command-handlers.ts`
- `scip-query outline`, `change-surface`, `refs`, `system`, and `code` for the files named above
