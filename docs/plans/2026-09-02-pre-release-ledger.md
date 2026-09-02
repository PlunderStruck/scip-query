# Pre-release ledger for 0.24.0

Started 2026-09-02. One row per item agreed before publishing; status is
`open`, `in progress`, `done`, or `deferred`, each with the evidence that
justifies it. Updated as work lands, committed with the work.

| #   | Item                                                                                        | Status      | Evidence |
| --- | ------------------------------------------------------------------------------------------- | ----------- | -------- |
| 1   | Project-at-a-time semantic loading, semantic-lane retirement mark, retry after worker death | in progress |          |
| 2   | Container-aware worker heap sizing (cgroup limit)                                           | open        |          |
| 3   | Classify Vega references-precision disagreements (0.956)                                    | open        |          |
| 4   | Build identity in the health report cache key                                               | open        |          |
| 5   | Reviewed label sets: wrappers, passthroughs, twin drift (Launchpoint, 20 rows each)         | open        |          |
| 6   | Full Launchpoint health under the release build, recorded                                   | open        |          |
| 7   | Audit checklist rows for every detector touched today                                       | open        |          |
| 8   | Final gate: tests, lint, release dry run, VM deploy                                         | open        |          |

## Log

- 2026-09-02 21:05 UTC: ledger created; starting item 1.
- 2026-09-02 21:40 UTC: item 1 implemented: lazy compiler project bundles routed by tsconfig membership (real-path aware), semantic worker soft-memory retirement mirroring the index lane, one worker restart after a failure, and memory-failed batches retried as file halves before the service counts as failed. 25 semantic tests pass including three new ones. Verification on the VM with a forced small worker heap pending.
- 2026-09-02 22:05 UTC: items 2, 4, 7 landed with tests; item 3 root cause found (test files outside every tsconfig are invisible to the compiler oracle) and the audit rule changed; Vega remeasure and VM small-heap verification for item 1 in flight.
