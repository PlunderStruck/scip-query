# Performance optimization campaigns

For making a command, workflow, service, page, or tool faster without changing its observable result. Hyper optimization is a bounded campaign that improves runtime, memory, or computational cost against repeatable measurements. Campaign-level conduct (delegation, handoff verification, benchmark pre-registration across multiple phases) belongs to `references/conductor.md`; this file is the performance-domain method that runs inside it or standalone for a single target.

If the repo is not a reliable scip-query workspace, invoke the `scip-setup` skill first, before starting an optimization target.

## Choose QUICK or CAMPAIGN

- **QUICK** — a single command/function target with an obvious hot path: capture one `docs/benchmarks/runs/YYYY-MM-DD-<target>.jsonl` baseline, skip the ledger and the rest of the campaign artifact set, fix the hypothesis, measure after, done.
- **CAMPAIGN** — multiple targets, an unclear bottleneck, or a decision between competing designs: requires the full machinery — baseline doc, ledger, profiling, and an alternative-design track.

Decide with one test: if you can already name the one function you expect to fix and a single before/after number will settle it, use QUICK; if naming that function requires investigation or the fix might be architectural, use CAMPAIGN.

## Definitions

- **Measurement harness** — the repeatable set of commands, fixtures, corpora, environment notes, and result documents used to decide whether performance changed.
- **Run history** — the durable time series of measurements, one record per run, command, subprocess, or profiled stage.
- **Profile span** — one named timed piece of work inside the target process (input loading, cache reads, database queries, graph traversal, rendering, a child process, ...).
- **Hierarchical profiling** — measuring coarse spans first, then recursively splitting only the dominant span until the expensive operation is concrete enough to fix.
- **Command ledger** — the living document for one optimization target: output contract, current pipeline, timings, tried ideas, and decisions.

## Scenario: target-and-harness (both modes)

For a scip-query command target, start with `scip-query bench --json` (baseline timings, command outcomes, environment, optional sampled profiles), then `scip-query bench --json --cold-index --include-heavy --timeout-ms 600000` for cold-path and heavy-detector timings. Do not optimize until a measurement harness exists or is created. Capture representative inputs, the output contract, and correctness checks before editing anything for performance. Record every benchmark in machine-readable run history; measure cold and warm paths separately when they can diverge. Choose the target from user pain, telemetry, benchmark ranking, regression data, cost, frequency, or risk.

Artifacts: CAMPAIGN mode creates/updates `docs/benchmarks/YYYY-MM-DD-<target>-baseline.md` (QUICK mode skips this file); both modes create/update `docs/benchmarks/runs/YYYY-MM-DD-<target>.jsonl` — the one required run-history artifact in every mode.

Done only when baseline timings, output identity evidence, corpus, environment, and run-history location all exist.

## Scenario: the ledger (CAMPAIGN only)

QUICK mode skips this and goes straight to tracing behavior, using the single run-history file as its record. Write `docs/benchmarks/YYYY-MM-DD-<target>-ledger.md` with sections: Output Contract, Target Selection, Current Pipeline, Run History Location, Profile Spans, Bottleneck Candidates, Measurements, Current-Pipeline Optimizations, Alternative Designs, Decisions. Done only when the ledger can explain what must not change.

## Scenario: trace behavior

Run `scip-query plan-context`, `trace`, `call-graph`, `code`, `dataflow`, and `complexity` on the entry/hot symbol — `call-graph <entry-symbol>` returns callers/callees, `complexity <hot-symbol>` returns LOC, branch, complexity, callee, fan-in/out counts — then `scip-query change-surface <touched-file> --json --full` to verify blast radius. Record input parsing, option resolution, subprocesses, lookups, database queries, graph traversal, source scans, semantic calls, cache reads/writes, rendering, serialization, and verification. Done only when each major pipeline step can be timed as a profile span.

Before adding profiling spans, check whether the target app already has an instrumentation layer — a bespoke profiling harness competes with the one the codebase already trusts. When the optimization target is scip-query itself, its instrumentation is `src/instrumentation/profile.ts` (`profileSpan`/`profileAsyncSpan`), env-gated by `SCIP_QUERY_PROFILE` and `SCIP_QUERY_PROFILE_OUT`, with `SCIP_QUERY_PROFILE_CACHE_STATE` for cache-state labels and inherited workload/subsystem identities — use it instead of adding a parallel harness.

## Scenario: profile the chain

Measure the target unprofiled, then measure profiled once and compare overhead. Measure distinct states: cold index, cold evidence/cache fill, warm cache hit, repeated focused run, production-like mixed state. Add coarse spans covering the whole chain, then split the largest workload-weighted span, repeating until the slow operation is a repeated lookup, initialization, scan, traversal, subprocess, serialization step, or wait. Attach cardinality to spans: files, rows, symbols, candidates, cache hits/misses, bytes, edges, nodes, retries, or output rows — write span records with cardinality to run history. When spans carry work identities, run `scip-query work-audit <profile> --json` on the profiling JSONL to separate exact repeats from same-name work on different inputs, ranking repeated-work groups by measured avoidable time (bounded coverage). Done only when the dominant cost is concrete enough to form a falsifiable hypothesis.

## Scenario: diagnose and fix

Classify the dominant performance shape as one of: cold-only setup, warm slow path, repeated setup, N+1 work, broad scan, database time, subprocess startup, serialization, or cache invalidation. Prefer fixes in this order: remove accidental repetition; batch scalar work; move stable derived work to an index/cache with invalidation; replace broad scans with indexed lookups; replace wrapper APIs only after output identity proves equivalence; add pruning only when mathematically equivalent or corpus-proven. Make the smallest reversible change that tests one hypothesis at a time. Work both tracks in parallel — tune the current pipeline and evaluate alternative algorithms or data models — and keep only changes that improve real workloads without reducing accuracy, diagnostics, safety, or supported inputs. Reject faster changes that alter the output contract unless the user explicitly approved a behavior change. Done only when before/after timings, profile deltas, and output identity are recorded.

## Scenario: verify, report, and close

Run the narrow correctness check, benchmark cases, and routed postchecks, then invoke `scip-verify`. End the campaign with a scoreboard from run history containing: starting value, current value, delta, scenario, corpus, commit/version, output identity, accepted changes, rejected ideas, remaining bottlenecks, and next target.
