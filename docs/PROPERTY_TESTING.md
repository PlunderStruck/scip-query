# Property-based verification

A property-based test checks a stated rule against generated inputs. Each case is one completed predicate invocation, potentially containing several edits, assertions or service events. fast-check reduces failures to simpler inputs and records a seed and replay path. A passing case count measures executions within the documented generators; it is not a count of unique inputs or proof of exhaustive correctness.

The suites use the existing Vitest runner and production TypeScript owners. fast-check is a development dependency. The shared runner is `tests/properties/support.ts`; the eight area suites are `tests/properties/<area>.property.test.ts`. The external compiler comparison is registered through `indexing-compiler.ts`.

## Running and replaying

```sh
npm run build # Required for the real daemon and worker entrypoints used by indexing histories.
npm run test:properties
npm run test:properties:thorough
npm run test:properties:thorough -- --area indexing --seed 20260907
npm run test:properties:types
```

Normal runs execute 200 component cases, five integration cases, two compiler sequences and two system histories per property. Thorough runs execute 200,000 component cases, 200 integration cases, 30 compiler sequences and 30 system histories per property. All area suites also run at normal budgets under `npm test`. A sequence contains multiple operations; those operations are not added to the case totals. The compiler check launches the independently packaged scip-typescript CLI after each generated edit and compares exact retained document bytes, with separately known file membership and definition checks.

The runner prints a unique temporary result directory. `summary.json` includes actual per-area/tier counts and individual receipts containing the fast-check version, seed, duration, skipped inputs, shrinking count, counterexample and failure message. Failed or interrupted properties cannot contribute passing-case credit; the runner also fails if Vitest reports an error or a full area misses its requested component budget. A raw test pass with a runner/worker error is not accepted.

Replay one failed property with its recorded seed and path, selecting its exact Vitest test name:

```sh
npm run test:properties -- --area scanner --test 'scanner: generated branches' --seed 12345 --path '0:1:2'
```

The example seed/path above is illustrative. Use the receipt from the failure. To vary local budgets, set `SCIP_PROPERTY_COMPONENT_RUNS`, `SCIP_PROPERTY_INTEGRATION_RUNS`, `SCIP_PROPERTY_COMPILER_RUNS`, or `SCIP_PROPERTY_SYSTEM_RUNS`. Values must be positive integers. A full thorough invocation still requires at least 200,000 passing component cases per area. Targeted `--test` invocations report only their selected work and do not claim full-area completion.

The GitHub workflow runs normal budgets on pushes and pull requests, and thorough budgets weekly or through manual dispatch. Unspecified seeds vary between invocations and are saved. It uploads the actual receipts even on test failure. The workflow becomes active after the commit reaches GitHub; local execution does not verify hosted CI.

## Guarantees and independent expectations

| Area | Generated checks | Independent expectation and bounds |
| --- | --- | --- |
| `indexing` | Add/edit/delete manifests; affected consumers; compiler shard membership; SQLite publication and failures at all four patch stages; retained compiler documents versus fresh compiler output | Plain before/after arrays, exhaustive small-graph reachability, explicit relational facts, unchanged accepted database bytes, and the external compiler. Component graphs have up to 10 vertices; SQLite sequences up to eight operations; compiler sequences two to five edits across four modules plus their consumer. |
| `graphs` | Component membership/order, target-only vertices, resolved module dependencies, isolated modules and cycle membership | Exhaustive reachability, independent of production Tarjan/queue traversal; generated source imports directly specify expected edges. Up to 10 vertices and 100 proposed edges. |
| `pagination` | Cursor identity; count/completion consistency; exact saved-output recovery across UTF-8 byte boundaries | Input strings and independently calculated counts, with real snapshot files and continuation reads. Includes ASCII, astral characters, combining marks, control characters, quotes and empty strings. This checks transport accounting, not whether a selected graph contains every task-relevant fact. |
| `scanner` | Exact cyclomatic/cognitive counts, local renaming and significant-literal duplication distinctions, comment invariance, parse failures, first-use health and file-budget failures | Constructed branches have known counts. Up to five branch groups with five nesting levels, else branches and while loops. Integration scans measure one to 20 sequential conditions and subsequent edits. Other syntax forms retain their existing fixed tests. |
| `cache` | Source equality, database isolation, LRU eviction, computation failure and scoped/global invalidation; actual source reads after edits/deletions | A small list-based cache model and current file contents. Up to 25 operations, two ownership keys and five files; separate real database/file integration. Source readers are invalidated through the documented cache registry, not assumed to poll disk on each cached read. |
| `suppressions` | Exact comment categories, source location bounds, finding identity, expiry, changed evidence and cached inventory/configuration changes | Constructed categories, explicit wall-clock comparisons and content identities, plus real indexed source comments. These checks do not establish the correctness of a human's suppression rationale. |
| `boundaries` | All 20 registered query-service request kinds, identity/timing/payload corruption, binary file limits, hashing and descriptor ownership | Shared fixed request fixtures are exhaustive at compile time; generated envelope fields and independent bytes/hash expectations. Real file cases cover up to 2,048 bytes; existing mutation/race regressions remain. |
| `lifecycle` | Admission, success, rejection, malformed/mismatched response, timeout, worker error, cancellation, duplicate response and delayed termination; watch finalization failures | Observable settlements, timers, admission state, termination calls, signal listeners and finalization order. The production lane/lifecycle runs with controlled worker/timer boundaries. Generated schedules cover the modeled events, not every OS thread/process interleaving. |

## Command coverage map

Direct coverage below means a generated test invokes the production consumer used by that command. Shared coverage means the command benefits from tested indexing, caches, protocols or transport, while its particular analysis still relies on existing fixed tests. Coverage of a dependency is not coverage of the entire command.

| Commands / surfaces | Property coverage | Remaining specificity |
| --- | --- | --- |
| `health`, `review`, `system --source` | Direct current-source scanner/module report consumers; current edits, incompleteness, dependency direction and cycle membership | Generated Git-base diff comparisons, every architecture rule and coverage-backed CRAP are not included. |
| `reindex` | Direct affected-file planning, sharding, SQLite patch publication and compiler document updates; real reindex/daemon histories, generation readers and interrupted publication | Generated repositories use one small TypeScript project; every configuration and non-TypeScript indexer is not covered. |
| `watch` | Direct worker-lane/lifecycle transitions; real daemon compiler requests, service restarts and an automatic filesystem refresh | Selected process interruptions and completion schedules do not exhaust OS event delivery or locking behavior. |
| `continue` | Direct immutable saved-output producer/consumer | Output beyond configured caps and every storage failure retain existing regressions. |
| `search`, `outline`, `entrypoints`, `inspect`, `code`, `files`, `methods`, `refs`, `imports`, `imported-by`, `members`, `by-kind`, `kind-counts`, `hierarchy`, `stats`, `surface` | Shared indexed identities/source freshness; generated protocol checks for registered request kinds; cursors and output transport | Locator relevance, semantic resolution and exact content selection are not established by envelope validation. |
| `evidence`, `session`, `deps`, `rdeps`, `system`, `cycles`, `architecture`, `dependency-depth`, `entry-map`, `call-graph`, `affected`, `diff-impact`, `change-surface`, `context`, `hotspots`, `fan-in`, `fan-out`, `coupling`, `bottlenecks`, `dependence-slice` | Shared indexing, graph component/ordering foundations, source module evidence and transport | Symbol-level execution/dataflow/provider completeness and task relevance retain dedicated fixed tests; source-module tests do not prove these relations. |
| `complexity`, `duplicate-bodies`, `similar`, `similar-files`, `similar-signatures`, `recent-duplicates`, `twin-drift`, `dead`, `unused-imports`, `unused-params`, `drift`, `passthrough-candidates`, `slice-cohesion`, `redundant-reexports`, `not-implemented`, `decorative-checkers`, `test-quality`, `cleanup-plan`, `locality-candidates`, `co-change`, `doc-drift`, `incomplete-migration` | Shared source metrics/fingerprints, cache validity, suppression parsing and transport | Indexed detector-specific scoring, history interpretation, cleanup safety and precision are not inferred from shared properties. |
| `react-component-duplicates`, `react-hook-candidates`, `react-large-component-pressure`, `vue-component-duplicates`, `vue-composable-candidates`, `vue-large-view-pressure` | Shared source/cache/index/transport foundations | Framework-specific structures remain covered by existing examples; no generated React/Vue suite is claimed. |
| `augment-sources`, `augment-vue`, `install-skills`, `check-deps`, `capabilities`, `init`, `config-validate`, `suppress`, `doctor`, `setup`, `setup-agent`, `uninstall`, `status` | Shared boundaries/suppression foundations where used | Installation effects, migrations, project discovery, provider support, skill prose and configuration semantics retain existing contracts. |
| `hook-architecture-stop`, `__diff-impact-batch`, `__health-phase`, `__health-semantic-prewarm` | Shared service and analysis foundations | These internal routes retain their existing end-to-end tests. |

## Scope and results

The indexing system suite (`indexing-history.ts`, `indexing-interruptions.ts`, `indexing-mutations.ts`) runs the actual reindex entrypoint, daemon/worker and SQLite publication. It supplies source edits, never an affected-file list. An initial function-to-constant change must publish incrementally with expensive fallback disabled. Every successful checkpoint compares all fixture-file compiler occurrences (symbols, roles, ranges and enclosing ranges) against the independently packaged compiler, checks exact file membership and database integrity, and checks that an already open reader retains its prior snapshot. The source map supplies independent expected membership and an untouched definition. Compiler semantic bugs shared by both paths can still escape this comparison; it is not a comparison of every analysis provider's output.

Generated histories contain 3–12 actions drawn from function/constant changes, deletion, restoration, rename, import rewiring, invalid syntax, configuration edits, no-op, revert and service restart. A separate fixed history exercises every kind. Short-history enumeration checks every sequence of length 1–2 (12 histories, 21 edit checkpoints) normally and length 1–3 (39 histories, 102 edit checkpoints) in thorough mode, over three owner states: function, constant and absent. Enumeration counts are printed separately, not added to generated-case totals.

Five real process-death checks kill a child indexer before/after its authoritative pointer change and during stable mirror replacement, then recover using retained crash files. Two I/O checks inject ENOSPC. Further checks cover cancellation, competing writers serialized by the lifecycle lock, a moving-input build's rejection, and automatic watcher catch-up. Checkpoints are controlled at real filesystem/status boundaries in an isolated test process. They do not simulate machine power loss or every possible OS schedule. Two temporary production-function mutations deliberately omit dependent files or retain old candidate database rows; both must be caught by the same clean-build assertion. These are negative controls, not production defects found by chance.

The state-verification worklist, confirmed production defects and validation receipts are recorded in [the indexer state plan](plans/2026-09-07-indexer-state-verification.md).

This suite increases the combinations exercised through the tool's shared foundations and selected real consumers. It cannot determine whether business module boundaries are well chosen, infer task intent, validate every language provider, or prove no future defects exist. No agent benchmarks are required. Tests do not alter production thresholds or suppressions.

The implementation worklist, execution receipts and discovered issues are recorded in [the property-testing plan](plans/2026-09-07-property-testing.md).
