# Contextual Signal Verdict Closure Result

Date: 2026-06-21

## Verdict

AVL-003 is complete. Every contextual analyzer family named in the ledger has a reviewed verdict and a score/output implication.

A contextual signal is an analyzer finding that names a concrete pattern in repository evidence but does not, by itself, select the repair. The facts are real: two functions may share behavior, a wrapper may have one caller, a component may be large, files may co-change, or a dependency chain may be long. The essential distinction is that the correct action depends on product meaning, boundary ownership, locality, or architecture rather than on the raw shape alone.

Raw evidence was captured across the existing validation roots, chiefly `/tmp/scip-query-validation/2026-06-21-pilot`, `/tmp/scip-query-validation/2026-06-21-budget`, and `/tmp/scip-query-validation/2026-06-21-direct-remaining`.

## Closure Matrix

| Family                                                                                                  | Final tier judgment                                                                                                                  | Reviewed evidence                                                                                                                                                                                                               | Score/output implication                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Similarity and reuse: `similar`, `similar-files`, `similar-chains`, `similar-signatures`, `convergence` | Contextual signal by default; direct only when evidence shows concrete shared domain behavior.                                       | Stable_Management similarity review had 3 true positives, 1 false positive, and 6 needs-judgment rows. The later evidence split found 217 Stable rows: 43 direct and 174 signal. Local scip-query rows were 3 signal, 0 direct. | Keep low-weight backlog pressure for ordinary similarity. Direct reuse wording requires domain-behavior evidence, grouped root causes, or echo/new-code directionality. |
| Recent duplicates and diff-gate `echo`                                                                  | More actionable than ordinary similarity, but still split by evidence.                                                               | Stable second confirmation showed echo grouping worked, then token-generation scaffolding forced a refinement so generic crypto/random overlap downgrades to signal.                                                            | Keep grouped direct echo for exact tiny helper duplication or compatible names/roles. Keep shared scaffolding as signal.                                                |
| Extraction pressure: `extract-candidates`                                                               | Contextual signal.                                                                                                                   | Vega produced 213 extraction rows, all `signal`: 174 workflow-orchestration, 14 broad-helper-cluster, and 25 cohesive-helper-cluster.                                                                                           | Do not score extraction as direct hygiene debt. Use extraction kind and future locality evidence to guide review.                                                       |
| Indirection: `wrapper-candidates`                                                                       | Contextual signal unless boundary counterevidence is absent and cleanup is locally obvious.                                          | Stable wrapper top 10 had zero direct cleanup wins and were accepted boundaries: DB context, middleware, audit, validation, route registry, and type guards. Wrapper output now carries boundary evidence and score counts.     | Discount boundary-shaped wrappers in health. Keep direct weighting only for rows without boundary roles.                                                                |
| Indirection: `passthrough-candidates`                                                                   | Contextual signal until it emits boundary evidence.                                                                                  | Vega and Synth samples were adapters, facades, service/provider boundaries, public entrypoints, or object API vocabulary; no safe default direct repair verdict.                                                                | Add action tier, boundary evidence, and recommendation before direct scoring.                                                                                           |
| Low-consumer abstractions: `stale-abstractions`                                                         | Split: zero-consumer abstractions are direct; one-consumer ownership rows are contextual signal.                                     | Vega produced 108 rows: 1 direct, 107 signal. Stable produced 63 rows: 3 direct, 60 signal.                                                                                                                                     | Score unused abstractions separately from one-consumer ownership signals.                                                                                               |
| Frontend duplicates and behavior candidates                                                             | Contextual signal for domain/mixed behavior; support for generic workflow or existing shared abstraction rows.                       | Vega React hook candidates produced 87 rows: 45 signal, 42 support. Stable Vue composable candidates produced 0 rows.                                                                                                           | Score only concrete behavior signal rows, not generic support rows. Vue score calibration needs a richer non-empty corpus.                                              |
| Large React/Vue pressure                                                                                | Direct repair pressure with review direction, not automatic extraction placement.                                                    | Vega React pressure produced 248 rows split into `route-page` and `component`. Stable Vue review threshold produced 59 rows with template/script/style/external-script pressure kinds.                                          | Pressure-kind output is valid. Pair with locality review before choosing destination directories; keep score thresholds conservative.                                   |
| Locality candidates design                                                                              | Contextual signal only.                                                                                                              | React consumer evidence was useful for route-local/component-local review. Vue reverse-dependency coverage was weak or coarse, requiring a consumer-coverage caveat.                                                            | Ship only as report/skill-first signal. No automatic moves or health scoring until repair outcomes improve.                                                             |
| Hidden coupling: `co-change` and `co-change-partner`                                                    | Contextual signal, strongest when partner class is doc/code, config/code, schema/script, model/view, test/code, or exact missing diff partner. | Stable co-change verdict review found 7 true positives and 3 needs-judgment rows. Diff-gate co-change partner examples were legitimate review prompts. Partner-class output and declared-coupling suggestions are now implemented. | Keep risk pressure. Avoid direct repair framing for broad feature sweeps and continue adding recency context.                                                           |
| Docs/history drift: staleness-only `doc-drift` and support `doc-reference`                              | Signal/support unless the citation is broken or the doc claim is clearly behavioral and current.                                     | Direct remaining verdicts kept 140 Vega broken references direct, while scip-query, Stable, and Synth staleness-only rows stayed signal. Doc citation-kind output reclassified README declared-coupling examples as support.    | Broken references are direct cleanup. Churn-based staleness and configuration examples remain review signals/support.                                                   |
| Architecture drift                                                                                      | Split: unused imports and explicit layer policy violations are direct; inferred policy and pattern deviations are contextual signal. | Stable drift produced 251 signal pattern-deviation rows. Vega drift produced 894 signal pattern-deviation rows. Health kept `driftedFiles` at 0 for those rows.                                                                 | Score direct drift only. Keep inferred/pattern drift as architecture backlog pressure.                                                                                  |
| Graph risk: `bottlenecks`, `coupling`, `deep-chains`, `hotspots`, `fan-in`, `fan-out`                   | Contextual signal/support.                                                                                                           | scip-query, Stable, and Vega graph-risk runs emitted signal rows; deep-chain strict suffix de-duplication fixed repeated top rows.                                                                                              | Keep out of direct health score unless combined with stronger evidence such as churn, cycles, explicit policy, or direct findings.                                      |

## Cross-Family Judgment

The contextual analyzers are worth keeping because they surface patterns that humans miss: repeated behavior, extraction pressure, indirection pressure, hidden historical coupling, drift pressure, centrality, and propagation risk. Their common failure mode is not bad evidence; it is over-direct wording or scoring.

The completed implementation slices addressed that failure mode by adding action tiers, evidence classes, pressure kinds, recommendations, citation kinds, policy bases, and support tiers. The remaining work is mostly score composition and schema finalization rather than verdict discovery.

## Residual Precision Actions

- Add passthrough boundary evidence before treating passthrough rows as direct repair.
- Keep Vue composable score changes blocked until a corpus with non-empty Vue behavior rows is reviewed.
- Keep locality out of health scoring until exact consumer coverage and repair outcomes improve.
- Group similarity, echo, and baseline findings by root cause before score/gate escalation.
- Keep support rows visible in reports but out of health deductions.

## Ledger Decision

AVL-003 moves to `complete`.

The remaining open validation work is now:

- AVL-006 score calibration finalization.
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

Close AVL-006 by turning the action-tier verdicts into a final score-calibration decision: direct findings should carry stronger base penalties, contextual signals should become lighter backlog pressure, and support evidence should not reduce health directly.
