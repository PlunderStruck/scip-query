# Reindex frequency optimization ledger

Date: 2026-07-24

| Pass | Hypothesis | Expected effect | Status |
| --- | --- | --- | --- |
| 0 | Establish global size, historical Vega frequency, and redundant-rerun control flow | A reproducible baseline and falsifiable target | measured |
| 1 | Use the completion freshness result to reject late duplicate watcher events | Constructed fresh workload falls from 2 reindexes to 1; stale/unknown workload remains 2 | passed: 1 vs. 2 in watcher tests |
| 2 | Persist bounded trigger/result/byte activity | Rolling 24-hour counts survive daemon restarts with at most two small segments | passed: activity and integration tests |
| 3 | Remove inactive global project caches while preserving live/recent caches | Reclaim old cache data without touching active caches | passed: 1,392 directories and 14,122,279,064 bytes removed |
| 4 | Retry event-backed source subscriptions with bounded polling after `EMFILE` | Preserve refresh correctness without changing the normal watcher path | passed: worktree watcher integration test |

## Cleanup result

The guarded cleanup used a seven-day inactivity cutoff, rechecked process locks
before deletion, and preserved 224 recent or live project caches, including the
two live watchers. Total global cache size fell from 18,059,676 KiB to
4,454,736 KiB. Repository-shared caches were retained because their lease and
generation lifecycle has separate ownership protection.

## Interpretation rule

Estimated logical output bytes count application artifacts produced by rebuilt refreshes. They are useful for comparing scip-query behavior across versions, but they are not physical SSD writes and cannot be converted directly into drive wear.
