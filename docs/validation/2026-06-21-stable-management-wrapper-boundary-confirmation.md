# Stable_Management Wrapper Boundary Confirmation

Date: 2026-06-21

Repository: `/Users/aydansalois/Documents/GitHub/Stable_Management`
Revision: `2354b4e385088aa90559c20ea8b270f14bfa47f3`

## Scope

This confirmation reruns `wrapper-candidates` and `health` against `Stable_Management` using the local scip-query build from `docs/validation/2026-06-21-wrapper-boundary-evidence-result.md`.

The repo worktree was already dirty from the broader validation pilot. The scip-query index was current and reused:

```text
Index unchanged; reused existing SQLite index in 0.1s
```

## Raw Outputs

- `/tmp/scip-query-validation/2026-06-21-pilot/Stable_Management/wrapper-boundary/wrapper-candidates-default-refined.json`
- `/tmp/scip-query-validation/2026-06-21-pilot/Stable_Management/wrapper-boundary/health-refined.json`

Earlier unrefined comparison outputs are also retained in the same directory:

- `wrapper-candidates-default.json`
- `health.json`

## Result

Final refined `wrapper-candidates --json --limit 120`:

- Total wrapper candidates: 48
- Signal: 37
- Direct: 11

Final refined `health --json`:

- Raw wrappers: 48
- `wrapperScoreCount`: 20.25
- Wrapper score detail: `48 wrapper candidate(s) (20.25 score-weighted)`

## Judgment Sample

The examples called out in the verdict review moved to `signal` with useful evidence:

| Candidate                         | Tier     | Evidence summary                                           |
| --------------------------------- | -------- | ---------------------------------------------------------- |
| `runDbRequestContextWithTransaction` | `signal` | context and transaction terms                              |
| `applyDbRequestContext`           | `signal` | context policy terms                                       |
| `assignRouterMount`               | `signal` | registry terms                                             |
| `notFoundHandler`                 | `signal` | middleware terms                                           |
| `writeAuditLog()`                 | `signal` | audit/log side-effect boundary terms                       |
| `validateQuery`                   | `signal` | middleware and validation terms                            |
| `validateBody`                    | `signal` | middleware and validation terms                            |
| `validateParams`                  | `signal` | middleware and validation terms                            |
| `registerRoute`                   | `signal` | registry terms                                             |

The first Stable sample also exposed a missed family: HTTP response type guards stayed `direct`. The implementation was refined to recognize route/response/access/scope boundary terms and type-guard boundary shapes. After the refinement:

| Candidate              | Tier     | Evidence summary                                      |
| ---------------------- | -------- | ----------------------------------------------------- |
| `isBinaryResponse`     | `signal` | type-guard shape, response terms, route caller terms  |
| `isNoContentResponse`  | `signal` | type-guard shape, response terms, route caller terms  |
| `isCookieResponse`     | `signal` | type-guard shape, response terms, route caller terms  |

Remaining direct examples look more like ordinary local helpers or domain-specific wrappers that still need human review:

- `breedFormFields`
- `joinHorseList`
- `dateOnlyUtcComparableFromString`
- `instantFromStableDateAndTime`
- `assertBookedScheduleNoConflictEffect`
- `createStableNotifications`
- `deletePendingWorkOccurrencesForSchedule`
- `historyRowWithPreservedSchedule`
- `codeCandidate`
- `ladderPlansAtOrBelow`

## Verdict

Confirmed with one refinement. The boundary evidence catches the known accepted-design wrapper families in a second repo, preserves raw discovery, and reduces score pressure by more than half without hiding remaining direct candidates.

## Next Action

Continue the next calibration implementation slice: Vue pressure-kind output for large-view findings.
