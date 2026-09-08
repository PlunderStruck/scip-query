# Property-based verification of scip-query

## Outcome and counting contract

Add fast-check to the existing Vitest suite and exercise all eight agreed areas. A property is a rule asserted for a generated input or operation sequence. A case is one completed fast-check predicate invocation; assertions, sequence steps, rejected inputs and shrinking attempts are not additional passing cases. The requested thorough run must complete at least **200,000 cases in each area**, with seeds, actual counts, failures and durations recorded. Expensive integration runs are counted separately; a generated change-planning case is not a compiler rebuild.

Existing fixed regression tests remain. Each new property must have an independently specified expected result, a simple reference model, or a justified relationship between executions. Comparisons between production paths alone cannot establish accuracy when those paths share an implementation.

## Existing flow

- `package.json:299` runs Vitest with two workers; `vitest.config.ts:5` includes `tests/**/*.test.ts`. Tests import production TypeScript directly. CLI integration tests additionally exercise the built `dist` artifact. Build before these tests and do not rebuild while they run.
- Incremental indexing detects snapshot changes (`src/domain/project-input.ts`), chooses affected files (`src/reindex/affected-set.ts`, `typescript-incremental-index.ts`), emits compiler documents, and publishes a candidate SQLite generation (`incremental-sqlite-publication.ts`). The accepted database must survive failed candidate publication unchanged.
- Graph consumers share `src/analysis/strongly-connected-components.ts`. Existing tests establish target-only vertices and reverse dependency order; generated small graphs can be checked against exhaustive reachability independently of Tarjan's implementation.
- Source complexity and duplication consume `src/source/ast/function-metrics.ts`. Existing `tests/source/function-metrics.test.ts` demonstrates exact branch counts, lexical binding normalization, significant literals/property keys, and parse-error reporting.
- Query service ingress decodes an envelope with protocol, session, request identity and timing (`src/runtime/query-service-envelope.ts`). `WorkerRequestLane` owns admission and completion, and watch lifecycle code owns shutdown. Boundary injection is already used by `tests/runtime/worker-request-lane.test.ts` and the lifecycle regressions.
- CLI output flows through `runWithCliOutputPagination` and immutable saved pages; `continueCliOutput` consumes these independently of repository state. Existing tests inject stdout and use real temporary snapshot directories.
- Source/configuration caches and suppression inventories are exercised by the previous behavior audit. Suppression decisions have category, scope, time and source-evidence validity; expired or unrelated records cannot erase findings.

## Comparable features, conventions and ownership

Reuse Vitest, the existing evidence/SQLite fixture builders, real temporary directories with `finally` cleanup, and injected external worker/time boundaries. fast-check is a development dependency only. Property suites live under `tests/properties/`, with a small shared runner responsible only for budgets, reproducibility and result receipts. Production policies and thresholds remain owned by their current modules. No public API or command is added for testing.

The larger run uses generated bounded structures so failures can shrink and runtime stays finite. Stateful checks compare observable production transitions with a smaller model. Integration subsets must call real parser/database/filesystem/compiler consumers and be explicitly distinguished from the high-volume component cases.

## Worklist

- [x] Add locked fast-check dependency, normal/thorough scripts, replay controls, machine-readable receipts and scheduled automation.
- [x] **Indexing:** exact manifests and affected closure/fallback; generated SQLite patch sequences versus independent final facts; bounded compiler incremental/fresh equivalence.
- [x] **Graphs:** component partition, mutual reachability, direction and dependency order; generated dependency consumer checks.
- [x] **Evidence/pagination:** exact item recovery, stable ordering, bounds and omission accounting; real saved-output continuation.
- [x] **Scanner:** generated valid source with independently known cyclomatic/cognitive counts, duplication identity and parse failures; source-health integration.
- [x] **Cache freshness:** current source/configuration/generation invalidation, isolation and retained observations; real source/cache integration.
- [x] **Suppressions:** category, scope, expiry and changed counterevidence; inventory integration.
- [x] **Files/protocols:** admitted byte bounds and exact content; generated request envelopes and malformed identity/timing states; real file mutation cases.
- [x] **Service lifecycle:** generated admission, responses, failures and shutdown sequences; exact-once settlement and resource ownership with injected worker boundaries, plus real lifecycle integration.
- [x] Map public commands to direct/shared property coverage and record provider/feature gaps without claiming exhaustive correctness.
- [x] Run at least 200,000 cases per area, investigate every failure, preserve minimal regressions, and repeat affected runs after fixes.
- [x] Run complete tests, typecheck, lint/format, API/skill contracts, source review, diff-impact and architecture as applicable; record final outcomes.

## Validation record

Implementation is present: 17 property checks across eight area suites, with two helper-runner negative controls and two executable-runner failure controls. fast-check 4.9.0 is locked as a development dependency. Normal and thorough npm scripts, strict type checking of the new tests, replay controls, unique result directories and scheduled CI are added. The command coverage document accounts for all **86 commands** listed by `--help-all`, distinguishing shared guarantees from direct consumer tests and ungenerated detector/provider behavior.

The accepted thorough run (`npm run test:properties:thorough -- --seed 20260907`) exited zero in **334.38 seconds**: **1,600,000 component cases**, **1,600 integration cases**, **30 compiler edit sequences**. Every area completed 200,000 component cases and 200 integration cases; indexing additionally completed the compiler sequences. All 17 properties passed with zero skipped inputs or shrinking attempts in that run. Receipts are preserved in [2026-09-07-property-results.json](2026-09-07-property-results.json); original artifact directory `/var/folders/4c/wsjvhgw90t7f31d7s68ddhtc0000gn/T/scip-query-properties-6VvH7J`, log `/tmp/scip-query-properties-final.log`.

Issues investigated while constructing the suite:

- Initial pagination assertions incorrectly expected an envelope for a short first response and omitted `--json` from saved invocation arguments. Current behavior correctly emits a complete short result directly and reconstructs continuation formatting from the saved invocation. Corrected the fixtures and validated both direct and paged results; no production bug is claimed.
- The first 200,000-case scanner loop passed its predicates but blocked Vitest's worker RPC long enough to produce an unhandled timeout. That run is not accepted as a clean validation. The scanner property now yields through `setImmediate` every 100 cases; the accepted full run completed without worker errors. This does not alter generated inputs or assertions.
- Strictly type-checking the new tests exposed an existing fixture helper's inability to narrow `readonly string[]` with `Array.isArray`. Switched to `typeof source === 'string'`, preserving runtime behavior and the shared fixture owner.
- Source review identified the new test runner as an unmapped architectural file. Assigned it to the existing `contract-tooling` boundary; no policy, thresholds or suppressions were weakened.
- Runner controls deliberately fail a property, reproduce its minimized counterexample from the saved seed/path, reject zero budgets and invalid seeds, and prove that incomplete or pre-property-failed CLI runs write failing receipts and exit nonzero. These controls do not contribute to the passing property-case totals.

No production analysis defect was found within these generated cases. The unrelated untracked LaunchPoint benchmark report is preserved. Agent benchmarks are outside this task. Full repository validation is recorded below. Hosted GitHub Actions has not been executed for this change; the workflow will become active when pushed.


## Final repository validation

- Full Vitest suite: **3,347 tests in 387 files passed**, 192.34 seconds, `/tmp/scip-query-property-full-tests.log`. This includes the new properties at normal budgets and existing real CLI, database, index, watcher and provider tests. No agent benchmarks were run.
- Build and production/property/protocol type checks passed. New property tests are now included in `npm run typecheck`; their shared existing fixture required the behavior-preserving narrowing correction described above.
- Source review against `b1a93d26`: **568/568 eligible TS/JS files**, **13,565 functions**, accounted coverage, **zero findings or scan problems**. Tests remain excluded from this production-source metric, as before. CRAP remains unavailable without source-matched coverage.
- Architecture: zero forbidden edges, cycles, stale allowances, boundary limits, test-boundary violations or coarse boundaries in indexed coverage. The existing 32 fragile-edge candidates are unchanged. The new script is explicitly covered by the current-source policy check.
- Public API remains **b74137d6c422ca9c**, **66 paths**; public API consumer compile and skill-link checks passed. Production dependency audit reports zero vulnerabilities.
- The complete `npm run lint` composite passed, including formatting, all configured ESLint targets, build, public API/consumer checks and skill links. Final diff checks passed.
- Production runtime and skill behavior did not change, so the dev-agent VM does not need reinstallation for this test-only addition.

- Final `diff-impact` disclosed 29 unindexed changed paths, including the preserved unrelated benchmark report. It cannot establish symbol consumers for these test/tooling/documentation changes; no `src` implementation changed, and the complete regression suite establishes the exercised behavior. The commit contains only the 28 task-owned paths.
