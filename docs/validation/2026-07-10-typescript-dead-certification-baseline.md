# TypeScript Dead-Code Certification Baseline

Date: 2026-07-10
Status: Complete baseline; detector verdict experimental
Roadmap: [`Accuracy Hardening and Health Certification`](../accuracy-hardening-goal.md)
Plan: [`Effectiveness Integrity and Accuracy Certification Slice`](../plans/2026-07-10-effectiveness-accuracy-certification-slice.md)
Verdicts: [`2026-07-10-typescript-dead-calibration-verdicts.json`](./2026-07-10-typescript-dead-calibration-verdicts.json)

## Result

The current TypeScript `dead` output does not meet the 90% public-signal or 95%
actionable-finding thresholds under the repository-health truth rule.

| Measure                        |           Result |
| ------------------------------ | ---------------: |
| Deterministic sampled rows     |               78 |
| Valid dead-code findings       |               25 |
| Invalid dead-code findings     |               53 |
| Observed precision             |            32.1% |
| 95% Wilson confidence interval |      22.7%–43.0% |
| Repositories represented       |                4 |
| Known-positive recall cases    |                0 |
| Certification                  | **Experimental** |

The sample contains 78 rather than the requested 100 rows because
Stable_Management emitted only three `dead-code` rows at its pinned commit.
The harness retained all three instead of substituting file-internal symbols
or resampling another repository.

## Truth Rule

A valid dead-code finding has no production, public-package, framework,
generated, reflective, configured, interface-conformance, or test-required
consumer. Certified deletion additionally requires an applicable checker.

This definition distinguishes repository-dead code from production-unreached
code. Repository-dead code has no role anywhere in the maintained repository;
production-unreached code may still be test infrastructure, a framework
entrypoint, or a declared contract. Only the former supports an immediate
deletion recommendation.

## Method

The extended `scripts/accuracy-calibration.mjs health-dead` mode:

1. created an isolated detached worktree at each repository's HEAD;
2. disabled automatic watch services and used a temporary cache;
3. ran a forced TypeScript reindex;
4. recorded the TypeScript capability matrix;
5. ran `dead --full --json` without candidate caps;
6. retained only `kind: "dead-code"`, excluding file-internal rows;
7. selected up to 25 rows per repository with seed
   `typescript-dead-v1`; and
8. captured source context and stable calibration identities.

Verdicts were assigned from pinned-commit source and reference evidence, not
from finding descriptions. Exact-name searches were used to expose test-only
consumers, package manifests/barrels established declared package surfaces,
and framework file conventions established implicit entrypoints.

| Repository        | Commit                                     | Total detector candidates | Sample | Valid | Invalid |
| ----------------- | ------------------------------------------ | ------------------------: | -----: | ----: | ------: |
| Vega_2.0          | `3da5ec1a6b7e1d74b3ce358896262977d5f7f585` |                       140 |     25 |     1 |      24 |
| openwork          | `1bc2b18ef426c4751a6d8c16fbbf8023f5da9f6e` |                       238 |     25 |    13 |      12 |
| Stable_Management | `bd221c3fa61034b4e52734f15ce6ef0b285ec78e` |                         3 |      3 |     1 |       2 |
| traceroot         | `c41ac2bb3801fc2ce882ea3bacba9b0c4c5afeb9` |                        46 |     25 |    10 |      15 |

All four repositories reported available TypeScript SCIP indexing, source
facts, ts-morph semantics, and TypeScript cleanup verification.

## Noise Archetypes

| Archetype                   | Count | Evidence                                                                                                         | Required correction                                                                                                  |
| --------------------------- | ----: | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Test-only consumer excluded |    26 | Exact imports, calls, assertions, or mocks existed in tests but no production consumer was counted               | Separate `production-unreached` from repository-dead; test use prevents a deletion claim                             |
| Framework file entrypoint   |    20 | Next.js `page.tsx`, `layout.tsx`, `middleware.ts`, and route configuration exports are loaded by file convention | Register framework roots before dead-code scoring                                                                    |
| Declared package surface    |     5 | Package exports/barrels exposed Drizzle relation objects and shared Zod schemas                                  | Treat declared package entrypoints and re-exported members as roots or report a separate unused-public-export signal |
| Interface contract member   |     1 | `Executor.readFile` is implemented by concrete executors and exercised through property dispatch                 | Exclude interface declarations from dead-code deletion claims; analyze implementations separately                    |
| Implicit constructor        |     1 | A base-class constructor initializes state when subclasses are instantiated                                      | Treat constructors as implicit members of reachable classes                                                          |

### Test-only is not dead

The largest failure family is terminological and behavioral. The current
detector intentionally asks whether production code references a symbol, so a
test helper or a function directly exercised by tests can be emitted as
`dead`. That result may be useful as production-surface information, but it is
not evidence that the symbol can be deleted. Health output currently
package-deals those two claims.

The detector should expose at least these states:

- `repository-dead`: no maintained consumer; eligible for verified deletion;
- `test-only`: maintained tests depend on it; not dead and not scoreable as
  deletable code;
- `framework-root`: reached by framework convention; not dead;
- `declared-surface`: exported contract with no observed repository consumer;
  review API policy before deletion; and
- `unconfirmed`: evidence capability or resolution is incomplete.

## Immediate Remediation Order

1. Stop `page.tsx`, `layout.tsx`, middleware, interface declarations, and
   implicit constructors from entering dead-code deletion output.
2. Preserve test-reference evidence and classify test-only rows separately
   instead of dropping test consumers before the deadness decision.
3. Add package-entrypoint and barrel-surface roots, retaining a separate
   advisory signal for unused declared exports when useful.
4. Re-run the same deterministic packet to prove all five archetypes disappear
   without losing the 25 accepted findings.
5. Generate a fresh holdout sample and known-positive mutation/history cases
   before awarding qualified or certified status.

## Limitations

- This baseline measures precision only. No known-positive recall cases have
  been executed, so certification remains impossible even after precision
  repair.
- Valid rows were source/reference-classified but not individually deleted and
  compiler-verified in this baseline. That verification belongs to the
  post-remediation holdout pass.
- The result applies to TypeScript `dead` at the pinned commits and current
  detector version. It does not establish Rust or Python accuracy.
- The generated packet is a local report artifact under `reports/accuracy/`;
  the committed verdict JSON and this report are the durable review record.

## Decision

Do not publish current TypeScript dead counts as defects, deletion
opportunities, or leaderboard penalties. Until remediation and holdout
calibration pass, label the detector experimental and keep its rows out of
public health comparisons.
