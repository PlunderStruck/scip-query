# Score Calibration Finalization Result

Date: 2026-06-21

## Verdict

AVL-006 is complete. The score model now has a validated interpretation for direct repair evidence, contextual signal evidence, support evidence, suppressions, and blocked evidence gaps.

A health score is a compact judgment about repository maintenance risk. Its reliable unit is not a raw analyzer row; it is a row interpreted through action tier, evidence quality, and validation history. Direct findings should move the score more sharply because they usually point to a bounded repair. Contextual signals should move the score as backlog pressure because they may reveal design work but require judgment. Support evidence should inform review without reducing score by itself.

## Final Score Rules

| Evidence class                   | Score treatment                                                                                                                                                      | Validated examples                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct repair evidence           | Strong base deduction, with normal pressure when counts accumulate.                                                                                                  | Dead runtime code, isolated symbols, real dependency cycles, unused params/imports, unused stale abstractions, explicit layer drift, broken doc references, verified cleanup-plan batches, runtime `new-dead`, strong `incomplete-migration`, and private redundant re-exports with actual barrel exports and zero consumers. |
| Direct repair pressure           | Base deduction is allowed, but the row should still carry review direction.                                                                                          | High complexity, large React/Vue pressure, and similarity rows that expose concrete shared domain behavior rather than scaffolding.                                                                                                                                                                                           |
| Contextual signal evidence       | Light base deduction only when the family has validated usefulness; otherwise pressure-only. Counts should use `scoreCount` or action-tier filtering when available. | Ordinary similarity, React/Vue duplicate structure, domain/mixed behavior candidates, wrapper and passthrough boundary signals, co-change/hidden coupling, graph risk, inferred/pattern drift, one-consumer stale abstractions, extraction candidates, and staleness-only doc drift.                                          |
| Support evidence                 | No direct health deduction. It can appear in reports, actions, validation lift, or gate context.                                                                     | Navigation commands, `affected`, `change-surface`, `plan-context`, `self-audit`, support-tier frontend rows, configuration-example `doc-reference`, baseline mechanics, and suppression inventory.                                                                                                                            |
| Blocked or conservative evidence | Keep visible, but do not strengthen score until the missing evidence exists.                                                                                         | Vue composable rows need a richer non-empty corpus; locality needs exact consumer coverage and repair outcomes; co-change-only doc staleness still needs historical-note intent classification.                                                                                                                               |

## Implemented Calibration

The completed implementation slices already moved the scoring behavior toward the action-tier model:

- Extraction candidates no longer receive a direct base deduction; they remain visible as pressure.
- Stale abstractions score unused rows as direct cleanup while single-consumer rows become lower-weight pressure.
- Drift scoring uses direct drift rows for base deductions and signal drift rows for pressure.
- React/Vue behavior candidates use score-count style weighting so support rows do not count like domain behavior.
- Wrapper candidates carry boundary evidence and health score counts, so accepted boundary-shaped rows can be discounted without disappearing.
- Passthrough candidates now carry boundary evidence and health score counts, so literal direct forwarding and boundary-shaped forwarding are scored separately.
- Redundant re-exports now carry package-surface evidence, so private barrels remain direct while package-public barrels become signal rows.
- Echo, baseline, and doc-reference findings now carry metadata that lets diff-gate distinguish direct, signal, and support interpretations.

## Accepted Current Weights

- Keep `hidden-coupling` as risk pressure because Stable_Management reviewed co-change rows were strong: 7 true positives and 3 needs-judgment rows. Use score-weighted counts so broad-sweep or stale co-change history does not score like focused current coupling.
- Keep ordinary `similar` as low-weight hygiene/signal pressure. The evidence split makes direct reuse narrow; the broader family still deserves backlog visibility.
- Keep React/Vue large pressure in health, but rely on pressure-kind recommendations and locality review before extraction placement.
- Keep support-only findings out of score deductions even when they remain visible in diff-gate or reports.

## Conservative Or Blocked Decisions

- Do not lower Vue large-view score thresholds globally from the review-mode threshold. The 300-line probe found useful rows, but the default threshold should stay conservative.
- Do not score Vue composable behavior more strongly until a second corpus produces non-empty reviewed rows.
- Do not make locality a health-scored analyzer until exact consumer coverage and repair-outcome evidence improve.
- Do not treat signal-tier passthrough rows as direct score debt; the boundary-evidence implementation now discounts them while leaving direct rows as cleanup pressure.
- Do not make support-tier `doc-reference` rows hard blockers; only behavioral/current cited claims should be direct doc-review evidence.
- Do not score one-consumer stale abstractions like unused abstractions.

## Suppression And Trust Adjustment

Suppressions are meta evidence about detector trust, not code health by themselves. The current inventory found 174 source suppression comments: 72 extract, 62 wrapper, 17 stale, 15 similar, and 8 passthrough. That distribution supports lower default confidence for broad candidate analyzers and higher demand for action-tier output before scoring them strongly.

Structured suppressions should continue validating file freshness. Stale suppression or declared-coupling paths reduce output trust because they make the analyzer context stale, but they should be repaired through config validation rather than counted as product code debt.

## Ledger Decision

AVL-006 moves to `complete`.

The remaining open validation work is:

- AVL-007 output/schema quality finalization.

## Verification

Completed after this doc update:

- Markdown formatting passed with Prettier.
- `npm run typecheck` passed.
- `npm run build` passed.
- `npm test` passed 64 files / 324 tests. The run still prints the known noisy `git diff` usage warning from the existing incomplete-migration fixture.
- `node dist/cli.js recent-duplicates --json` returned 0 findings.
- `node dist/cli.js unused-params --json` returned 0 findings.
- `node dist/cli.js reindex` rebuilt the TypeScript shard successfully.
- `node dist/cli.js diff-gate --json` exited 1 with two accepted warning-level findings:
  - `echo`: `isCompileTimeContractAssertion()` remains signal-tier similarity with `indexedDefinitionFromRow()` because both use symbol leaf parsing but make different product decisions.
  - `doc-reference`: README declared-coupling examples remain support-tier `configuration-example` citations and still point at the intended files.

## Next Slice

Close AVL-007 by consolidating every output/schema verdict and missing-field list into one final output-quality record.
