# Detector guide

A detector is a repository analysis that selects source locations with a
shared evidence pattern. Compiler-graph detectors report resolved program
relationships. Heuristic detectors report candidates that require source
confirmation.

## Repository overview

```bash
scip-query health --full
```

The health report combines graph structure, duplication, drift, complexity,
history, suppressions, coverage contracts, and React and Vue analyses. Its
score is a summary, not proof of correctness.

## Focused detector families

| Concern | Commands |
| --- | --- |
| Exact or near duplication | `duplicate-bodies`, `similar`, `recent-duplicates` |
| Parallel implementations | `twin-drift`, `incomplete-migration`, `drift` |
| Unused or disconnected code | `dead`, `isolated`, `unused-params` |
| Excess indirection | `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `redundant-reexports` |
| Change pressure | `complexity-hotspots`, `co-change`, `cycles` |
| Documentation | `doc-drift` |
| React | `react-component-duplicates`, `react-hook-candidates`, `react-large-component-pressure` |
| Vue | `vue-component-duplicates`, `vue-composable-candidates`, `vue-large-view-pressure` |
| Team structure policy | `architecture` |

Run focused commands through the `scip-query` CLI. Add `--full` only when that
command supports it and exhaustive command coverage can change the decision.

## Acting on findings

1. Read the cited source.
2. Identify the shared concept or violated rule.
3. Preserve intentional variation.
4. Make one coherent edit.
5. Run native checks and the relevant detector again.
6. Use `scip-query diff-impact` when downstream consumers may have changed.

Suppress a false or accepted finding with `scip-query suppress <id>` and a
specific reason. A suppression addresses one finding; it must not disable an
unrelated detector family.
