# TypeScript breadth repairs — 2026-09-09

The five finding groups from the [breadth audit](2026-09-09-typescript-breadth-audit.md) are repaired. All 3,799 regular tests pass across 415 files. The discovery report and its original results remain unchanged.

## What changed

| Finding                      | Observed failure                                                                                                                                                                                                                                  | Repair and its limit                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B01: shared mutable values   | Objects exposed through another exported function, getter, closure or container could retain a stale exact value after a caller changed them.                                                                                                     | Compiler-linked binding analysis now follows those exported routes and qualifies values whose mutation cannot be ruled out. Unchanged direct-import properties and primitive-return controls retain their precision. This can intentionally return uncertainty for mutable exported aliases.                                                                                        |
| B02: runtime value precision | Numeric addition could become text concatenation; an uncertain value could become a supposedly literal HTTP path during graph extraction.                                                                                                         | Concatenation requires a proven string operand, and value precision survives the conversion into runtime keys. Unknown arithmetic remains unknown; this is not a general numeric evaluator.                                                                                                                                                                                         |
| B03: slice completeness      | A backward slice could omit input-dependent changes from nested callables, getters, class initialization or direct `eval` while claiming completeness.                                                                                            | Nested callable bodies participate in the selected owner's analysis. Cross-callable dependencies and unsupported effects qualify coverage. Supported straight-line and branch controls remain complete. General analysis of effects across arbitrary calls and object memory remains unsupported.                                                                                   |
| B04: constructor evidence    | Callable filtering dropped a compiler-observed construction when its implementation could not be established. Complexity and call-graph also disagreed about exact and candidate callees.                                                         | Qualified construction rows remain visible as candidates. Complexity obtains the same filtered, calibrated evidence through `ProjectIndex`. An unresolved implementation does not become an exact executable body.                                                                                                                                                                  |
| B05: database publication    | Old SQLite journal pages could affect a replacement stable database; invalid database bytes could be published. Later lifecycle replay also found standalone augmentation mutating the accepted database without updating its generation pointer. | Candidates are checkpointed and integrity-checked before publication; replacement removes journals belonging to the previous stable file. Standalone augmentation runs against a private SQLite backup under the existing writer lock and uses the existing generation publisher on success. A failed augmentation discards its candidate and preserves accepted data and metadata. |

A backward slice is a set of source operations that can influence a selected value. Its completeness claim is valid only for the kinds of effects the analysis supports. A generation is a published database snapshot with a pointer identifying the version readers should open; already-open readers retain their prior snapshot.

The B05 implementation preserves SQLite journal mode. Changing it was an intermediate hypothesis, not the explanation for the remaining lifecycle failure: per-command hashes ultimately showed unpublished writes by `augment-sources` and by `augment-vue` before a missing-provider error. Both commands now publish through the same owner. Tests cover successful publication, an existing reader staying on its earlier snapshot, and failure after candidate writes.

`ProjectIndex.callableCallees` is an additional method on the existing exported facade. Existing method signatures are unchanged. Its API acceptance record explains why the conservative class-signature detector's breaking classification is a compatible correction.

## Verification method and results

Tests compare tool output with independently executed TypeScript programs, compiler observations, fresh full indexes, and SQLite integrity checks. The CLI replays check returned facts and state transitions; successful exit status alone is insufficient. These are deterministic tool tests, with no coding-agent benchmark.

| Check                                    | Result                                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| New breadth corpus                       | 109 compiler-valid programs; zero wrong claimed literal values                                                          |
| HTTP behavior                            | 51 executed programs; zero wrong claimed literal paths; five public CLI projections checked                             |
| Slice behavior                           | 34 programs, 102 executions with varied inputs; zero falsely complete slices; five public CLI projections checked       |
| Additional call-graph consumers          | 35 comparisons                                                                                                          |
| General public commands                  | 71 command runs and 42 checked facts                                                                                    |
| Operational lifecycle                    | 48 checks passed                                                                                                        |
| Output transport                         | 58 checks passed                                                                                                        |
| Architecture fixtures                    | Eight checks passed                                                                                                     |
| Frontend and augmentation fixtures       | 34 checks passed                                                                                                        |
| SQLite integrity during lifecycle replay | 28 checks passed                                                                                                        |
| Previous accuracy corpus                 | 686 programs; zero wrong claimed literal values or established executable bodies                                        |
| Previous update histories                | 18 histories, including 16 actual incremental updates; zero compiler or normalized graph differences from full rebuilds |
| Focused regular tests                    | 157 tests passed across five files                                                                                      |
| Full regular suite                       | 3,799 tests passed across 415 files                                                                                     |
| Build and static checks                  | Build, complete TypeScript checks, formatting, ESLint, public API and skill links passed                                |

The strict repair gate requires positive controls to remain informative. It also explicitly replaces two historical assertions that counted an unresolved constructor as exact: the general fixture now reports two exact callees and one candidate in both call-graph and complexity. The other 40 historical command assertions remain unchanged.

The first full-suite run passed 3,761 tests and failed 36 tests in the reindex reliability file. Its mocked converters wrote the text `new-db` instead of a SQLite database, so the new publication integrity check rejected the fixtures. Those mocks now create real SQLite databases using the shared test schema. All 46 tests in that file pass, including in the final full-suite run. Two standalone augmentation-publication tests were added after the first full-suite run, bringing the final total to 3,799.

The [machine summary](typescript-accuracy-audit/2026-09-09-breadth-repairs.json) preserves the counts, remaining repository findings and digests identifying the tested production source and distribution. The final API surface matches `9217c44ff0f30a77` across 66 package export paths.

## Reproduction

Use the built checkout and a fresh output directory. The audit files record observations; the strict verifier makes their semantic assertions fail the run when violated.

```sh
npm run build
SCIP_QUERY_AUDIT_SCOPE=breadth SCIP_QUERY_AUDIT_OUTPUT=/tmp/scip-breadth-repaired/isolated npx vitest run --config benchmarks/typescript-accuracy-audit/vitest.config.ts benchmarks/typescript-accuracy-audit/run.audit.ts benchmarks/typescript-accuracy-audit/breadth-public.audit.ts benchmarks/typescript-accuracy-audit/breadth-slices.audit.ts benchmarks/typescript-accuracy-audit/breadth-call-consumers.audit.ts
```

The command and lifecycle fixture runners documented in the discovery report produce the `commands`, `controls`, `transport`, `architecture` and `frontend` subdirectories. Run controls, transport and frontend in that order. Then check all repair assertions together:

```sh
node benchmarks/typescript-accuracy-audit/verify-breadth-repairs.mjs /tmp/scip-breadth-repaired
npm test
npm run typecheck
```

## Remaining limits

These finite test programs establish that the reproduced failures are fixed; they do not prove complete TypeScript accuracy. Some repairs expose uncertainty instead of manufacturing a precise answer. The previous compiler comparison still reports nine missing compiler targets and 15 imprecise declaration ranges; those do not acquire exact implementation claims. Arbitrary runtime mutation, effects across arbitrary calls, and dynamic execution remain bounded by the reported provider coverage.

The frontend replay covers the available providers and failure behavior, including a missing Volar provider. It does not establish the correctness of a separately installed Volar provider. No VM installation was performed in this repair pass.

Repository review and diff-impact cover the whole current worktree, which includes earlier uncommitted repairs. Their results must not be attributed solely to this repair pass. Current-source review captured all 587 eligible production TS/JS files without capture problems and reports 14 maintainability findings relative to HEAD: 13 complexity findings and one source-module file-count limit. These remain separate cleanup work; this repair pass does not claim a clean repository review.

The architecture command reports no forbidden edges or cycles within its indexed/current-import coverage, while also disclosing excluded files and unresolved imports; it cannot establish a repository-wide absence claim on that basis. Indexed diff-impact reports 44 changed files, 175 changed symbols and 211 affected files, with 62 changed paths omitted by that index's coverage. Current-source review provides the complementary view of those unindexed changes.
