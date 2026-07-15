# Agent command latency campaign — 2026-07-15

## Goal

Reduce warmed latency for the agent-facing planning, impact, graph-analysis,
and import commands without changing their exit status, stdout bytes, evidence
scope, symbol choice, traversal depth, or ordering.

This is a performance campaign: several commands share query primitives, and
the dominant avoidable work is not yet proven. A change is kept only when a
seven-run warmed comparison improves a target by at least 10% or 30 ms at the
median, preserves its baseline SHA-256 output hash and exit status, and passes
the applicable correctness and repository gates.

## Current state

- `planContext` composes trace, call graph, complexity, dataflow, backward and
  forward slices, affected closure, change surface, dependencies, reverse
  dependencies, system, surface, and Git-backed history. Source:
  `scip-query code planContext`.
- The composite calls each public query independently, so it is the first place
  to look for repeated resolution, reference materialization, graph walks, and
  file/module lookup. Source: `scip-query plan-context planContext --json
  --full`.
- `planContext` has two indexed consumers and medium change risk; its query
  module depends on fourteen analysis, navigation, impact, and storage modules.
  Source: `scip-query plan-context planContext --json --full`.
- The compiler-derived index is fresh, TypeScript and Rust semantic providers
  are available, and the watch service is live and idle. Source:
  `scip-query status --capabilities`.
- The preregistered warmed baseline is recorded in
  `docs/benchmarks/2026-07-15-agent-command-latency-baseline.md` and
  `docs/benchmarks/runs/2026-07-15-agent-command-latency.jsonl`.

## Reuse audit

- Reuse the invocation-scoped project/Git context and per-database symbol
  resolution cache already implemented by the navigation latency campaign.
  Do not add a second command-global cache.
- Reuse existing public query implementations and extract a shared primitive
  only when profiles prove the same database work is repeated. Do not create a
  reduced-evidence fast path for `plan-context`.
- Reuse `profileSpan` and `profileAsyncSpan` from the existing env-gated
  instrumentation. Do not add a parallel timer or telemetry format.
- Prefer an existing prepared result or batch query over persisted caching;
  persisted results would add invalidation and generation-ownership risk.

## Testability design

| Behavior | Test seam | Dependencies | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Composite planning | `planContext` query tests and CLI JSON snapshot/hash | database, semantics, Git history | result assembly and match classification | SQLite, semantic provider, Git | every result section, warning, and order is identical |
| Impact traversal | affected/diff-impact/change-surface tests | changed files, symbol graph, Git diff | closure and risk classification | SQLite and Git | identical symbols, depths, and risk levels |
| Graph analysis | call-graph/dataflow/complexity/slice tests | resolved symbol and references | traversal/classification | SQLite and semantics | identical nodes, edges, counts, and ordering |
| Import analysis | imports tests | indexed file/import rows | import grouping | SQLite | identical imported symbols and source sites |
| Performance | machine-readable seven-run harness | idle watcher and fixed dirty worktree | median/hash comparison | spawned CLI processes | keep threshold and output identity |

## Phases

### 1. Profile and optimize `plan-context`

- Source: `scip-query plan-context planContext --json --full`.
- Measure the composite and each component with fixed inputs. Capture an
  env-gated profile and use `scip-query work-audit` when work identities exist.
- Remove only proven repeated work, preferably by passing one prepared symbol
  or reference result through existing queries.
- Validate focused plan-context tests, all component output hashes, typecheck,
  build, routed postchecks, and the repository gate.

### 2. Optimize shared impact work

- Targets: `affected`, `diff-impact`, and `change-surface`.
- Profile their database and Git boundaries, then remove repeated setup, batch
  scalar lookups, or replace broad scans only with output-equivalent indexed
  work.
- Validate the three baseline hashes, focused impact/runtime tests, and full
  phase gates.

### 3. Optimize graph analysis

- Targets: `call-graph`, `dataflow`, `complexity`, and `slice`.
- Profile shared symbol/reference materialization and graph traversal. Prefer a
  common prepared-query primitive only if at least two targets measurably
  benefit.
- Validate four baseline hashes, focused navigation/quality tests, and full
  phase gates.

### 4. Evaluate `imports`

- Profile `imports` after shared improvements land. Keep a command-specific
  change only if it clears the same threshold; otherwise record it as already
  near the process floor and stop.
- Run final full tests, lint, typecheck, build, routed postchecks,
  `scip-query reindex`, and `scip-query diff-gate --json --full`.

## Stress test and ship order

- Purpose: all result sections are evidence, not optional decoration; none may
  be dropped to win a benchmark.
- Blast radius: shared primitives can affect commands outside the measured set,
  so their existing tests and full CLI contract suite remain required.
- Intermediate states: each phase must build, pass focused tests, and preserve
  output hashes before the next phase starts.
- Reversibility: every candidate is a two-way door and is unwound when it misses
  the keep threshold.
- Failure and concurrency: no new daemon protocol, persistent cache, schema, or
  shared mutable state is authorized by this plan.
- Data integrity: database and generation formats remain unchanged unless a
  later profile proves an indexed-data design is necessary and the plan is
  revised before implementation.
- Observability: existing profiling remains opt-in and command output remains
  unchanged when profiling is disabled.
- Ship order: `plan-context`; impact group; graph-analysis group; `imports`;
  final campaign scoreboard.

## Execution note

The repository already contains an uncommitted, verified navigation-latency
campaign. This campaign will not manufacture per-phase commits inside that
shared dirty worktree; phase boundaries are instead recorded in the plan,
machine-readable run history, and verification ledger. No existing user change
will be reset or rewritten.

## Outcome

Completed. The retained changes batch affected-frontier caller evidence, reuse
single-file `system` dependency edges and the invocation's resolved Git HEAD in
`plan-context`, and consolidate `diff-impact` onto one five-read Git snapshot.
Three below-threshold experiments—TypeScript closure precomputation, grouped
symbol-analysis descriptors, and a leaf `imports` descriptor—were measured,
recorded, and removed. The final build, typecheck, lint, routed cleanup checks,
reindex, and eight-check `diff-gate` pass; the full suite passed 1,393 of 1,394
tests concurrently, and the sole watcher-timing failure passed in isolation.
