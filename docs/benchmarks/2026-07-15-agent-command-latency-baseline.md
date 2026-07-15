# Agent command latency baseline — 2026-07-15

## Harness

- Corpus: this repository's fresh SCIP database with 23,318 symbols and 340
  indexed files.
- State: dirty worktree with a compatible live, idle watcher. The original
  composite sample followed an index generation change and therefore includes
  cold semantic-reference materialization; the same-build A/B records the
  separately warmed state.
- Runtime: local Node executable launching `dist/cli.js`.
- Runs: seven per command; median is the fourth sorted observation.
- Correctness: exit status, stdout byte length, and SHA-256 must remain stable.
- Keep threshold: at least 10% or 30 ms median improvement, plus output identity.
- Run history: `docs/benchmarks/runs/2026-07-15-agent-command-latency.jsonl`.

## Baseline

| Command | Input | Median | Stdout bytes |
| --- | --- | ---: | ---: |
| raw Node | empty program | 69 ms | 0 |
| `plan-context` | `findFirstSymbolMatch --json --full`, cold semantic generation | 1,722 ms | measured hash recorded |
| `affected` | `findFirstSymbolMatch --json` | 941 ms | 11,685 |
| `diff-impact` | current dirty diff, JSON | 1,342 ms | 20,077 |
| `change-surface` | `src/symbols/symbol-lookup.ts --json --full` | 549 ms | 9,039 |
| `call-graph` | `findFirstSymbolMatch --json --full` | 453 ms | 6,908 |
| `dataflow` | `findFirstSymbolMatch --json --full` | 464 ms | 20,076 |
| `complexity` | `findFirstSymbolMatch --json --full` | 415 ms | 972 |
| `slice` | `findFirstSymbolMatch --json --full` | 396 ms | 7,736 |
| `imports` | `src/queries/impact/plan-context.ts --json` | 327 ms | 3,574 |

The raw Node median is context, not a value subtracted from command timings.
Spawn scheduling and CLI initialization are part of the user-visible command.

The controlled warmed legacy medians captured with the first candidate were
1,272 ms for `plan-context` and 774 ms for `affected`. They are the acceptance
baseline for that candidate because both variants ran alternately in one build
against one index generation.

## Output contract

For the same database generation, worktree, arguments, and semantic state, each
command must return the same exit code and byte-identical stdout. A candidate
that changes evidence membership, symbol resolution, traversal depth, ordering,
diagnostics, or JSON shape is rejected even when faster.
