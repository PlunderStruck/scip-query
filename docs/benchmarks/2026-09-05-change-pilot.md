# Sol medium change pilot — 2026-09-05

All 16 editing sessions passed the independent acceptance checks: eight with native tools and eight with scip-query. The scip-query sessions took 1.87 times as long and used 1.50 times as much uncached input and 1.89 times as much output. This small pilot demonstrated no correctness advantage. Its index-refresh limitation also prevents a clean assessment of change analysis.

A change benchmark gives an agent a fixed repository and a requested edit, then checks the submitted code against requirements specified independently of that agent. Here, each of four tasks also receives a maintenance change in a fresh agent session. Responsibility ownership means the code controlling a rule or resource also enforces its valid use; for example, all cancellation channels must reach the operation that controls eligibility and records cancellation.

| Task                              | Native initial / follow-up | scip-query initial / follow-up | Native time | scip-query time |
| --------------------------------- | -------------------------- | ------------------------------ | ----------: | --------------: |
| Shared cancellation rule          | Pass / pass                | Pass / pass                    |    2.35 min |        4.75 min |
| Shared quote; independent fees    | Pass / pass                | Pass / pass                    |    2.43 min |        4.39 min |
| Retire old receipt implementation | Pass / pass                | Pass / pass                    |    2.47 min |        3.21 min |
| Restore dependency direction      | Pass / pass                | Pass / pass                    |    1.51 min |        4.05 min |

Measurements count both editing stages. Initial index preparation is separate; the agent-initiated refresh in the dependency task is included in its editing time. Token totals include repeated context across turns; cached input is reported separately and is not equivalent to uncached input cost. No dollar estimate is made.

| Measurement               |   Native tools | scip-query |
| ------------------------- | -------------: | ---------: |
| Editing-session time      |       8.76 min |  16.39 min |
| Initial index preparation | Not applicable |    3.403 s |
| Total input tokens        |      1,316,398 |  3,282,293 |
| Uncached input tokens     |        138,030 |    206,453 |
| Cached input tokens       |      1,178,368 |  3,075,840 |
| Output tokens             |         23,665 |     44,772 |

The compact [measurements, checks and diagnostic outputs](../../benchmarks/change-results/2026-09-05-sol-medium/results.json) include links to all submitted patches. Raw events, source snapshots and the exact protocol archive remain at `/tmp/scip-change-pilot-sol-medium-20260905b` on the machine that ran the pilot.

## What the run establishes

The benchmark now runs actual edits with `gpt-5.6-sol` at `medium`, using separate disposable checkouts for native tools and scip-query. Both receive the same investigation discipline. Agents cannot change the declared architecture policy or original smoke tests under the task instructions. The evaluator independently compiles source, executes the original and agent-added tests, checks runtime behavior, and checks compiler-resolved dependency and call relationships. Known incorrect submissions exercise the evaluator's rejection paths.

The tasks exercise a shared cancellation rule and its writes, a shared quote calculation alongside independently changing fees, retirement of an old notification implementation and its configuration, and moving caller-specific configuration out of domain code. Maintenance changes test the resulting arrangements rather than only the first edit. These are separate acceptance requirements, not an architectural quality score.

In the quote task, the scip-query submission exported the shared function directly through both adapters. The native submission used forwarding functions. Adding the optional discount argument consequently changed two production files in the former and four in the latter. Both preserved behavior and independent fee policies. This is a source observation from one pair, not evidence that scip-query caused a better design. The review was not blind or independent human review.

## Reliability findings and protocol limits

The runner deliberately disabled background services and prepared the index before the first stage. It did not automatically refresh between stages. Installed scip-query skill instructions nevertheless led the treatment agents to attempt the disabled watcher. The dependency-direction agent successfully ran `reindex --allow-expensive-rebuild` after ordinary `reindex` refused without the incremental service; the other treatment trials did not reindex. This is a test integration limitation: semantic queries could lack newly created code during maintenance. Current-source reads and independent verification still worked. These runs cannot establish the effectiveness of a consistently refreshed change-analysis workflow.

One recorded query selected the newly added `src/pricing/quote.ts:1`, reported that selector as missing, and still labeled the result `accounted`. Its process exited unsuccessfully, but the coverage wording could mislead an agent. A missing requested root must remain visible in the overall completion status.

The logs also contain a failed fold expansion after the agent dropped the required `fold:` prefix, and a `health --json --agent-output` response that exceeded the output safety limit on this small project. These are actionable interface and output observations; neither was an observed code-correctness failure in this run. The diagnostic excerpts are retained with the measurements. Treatment logs contain 185 shell invocations classified as scip-query commands, plus one native listing of test filenames. Classification is an audit aid, not proof of complete protocol adherence; command strings can combine operations.

The source fixture has only 19 TypeScript files and 106 lines before task-specific changes. Its responsibilities are explicit. One pair per task cannot estimate model variability or show that results extend to larger projects. The model had installed skill metadata available, even though user configuration and rules were disabled; installed skill bytes were not independently pinned. Worktrees isolate cleanup and edits operationally, but are not security sandboxes. Access restrictions were instructions, not operating-system enforcement.

An earlier attempt at `/tmp/scip-change-pilot-sol-medium-20260905a` was stopped and retained. Its instructions ambiguously froze tests added by the initial agent, and its evaluator did not independently execute all such tests. The corrected protocol explicitly permits maintaining agent-added tests and independently executes them. Both conditions restarted equally under `dispatch-desk-changes-v2`. Reported measurements exclude that superseded attempt and the preliminary model probe; they are not the total expenditure for developing this benchmark.

## Next experiment

First make index refresh explicit and compatible with the runner's service isolation, including after edits and before a fresh maintenance session. Correct missing-root coverage reporting and reduce navigation overhead where the logs show recovery or repeated boilerplate. Preserve these results as the development baseline rather than editing their protocol after seeing outcomes.

Then repeat matched runs on a separate, larger repository with real ownership and consumer relationships. Retain failures, measure maintenance changes, and obtain review without disclosing the tool condition. Additional aggregate reports or architectural grades should wait until this demonstrates an improvement worth their cost.

Run the implemented suite with `npm run bench:change -- pilot --output <new-directory> --model gpt-5.6-sol --reasoning medium`. The [benchmark protocol](../../benchmarks/change/README.md) describes the checks and artifacts. This command currently reproduces the initial-index protocol and its refresh limitation described above.

Validation of the implementation: 17 new benchmark tests and 19 existing exploration-runner tests passed. Type checking, lint, build, public API consistency, formatting, and the repository architecture check passed. Saved timing and token totals, all 16 patch files, and raw-event digests were checked against the original run artifacts. All eight temporary worktrees were cleaned up.
