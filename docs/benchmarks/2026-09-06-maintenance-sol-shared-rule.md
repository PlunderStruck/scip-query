# Sol medium shared-rule change trial

Runtime: `9ce8a0de`. Model: `gpt-5.6-sol`, medium reasoning. One matched control/treatment pair on the frozen `shared-rule` fixture, with an initial change and a follow-up change. The baseline commit, fixture digest, evaluator digest, runtime digest, model and effort match across conditions. Both temporary worktrees were cleaned.

The fixture asks for one cancellation rule and write owner across web, administrative and scheduled-job entry points, then changes the deadline rule. Independent checks cover behavior, unchanged rejection state, audit identity, shared ownership, dependency direction, submitted tests and preservation of evaluation inputs.

| Result                       | Native control | scip-query treatment |
| ---------------------------- | -------------: | -------------------: |
| Initial obligations passed   |          17/17 |                17/17 |
| Follow-up obligations passed |          17/17 |                17/17 |
| Agent phase time             |       188.661s |             304.109s |
| Index preparation            | Not applicable |               0.791s |
| Cumulative input tokens      |        438,615 |              973,609 |
| Cached input tokens          |        375,040 |              852,224 |
| Uncached input tokens        |         63,575 |              121,385 |
| Output tokens                |          7,154 |               11,021 |

Both implementations routed the scheduled job through the existing reservation owner and changed the existing policy. Both follow-ups changed that policy instead of scattering the new rule across adapters. These observed changes satisfy this fixture; source size differences are not a design-quality ranking.

There is **no measured correctness gain in this pair**. The treatment took 1.61 times as long and processed 2.22 times the cumulative input tokens (1.91 times uncached input). Token totals count text processed across successive model calls, including context processed repeatedly; they are not a count of unique repository text.

The treatment's transcript includes reading the shared/exploration skills, consulting command help, module overview, source reads, graph projections, cursor continuation, post-edit checks, and tests. The skill files it read are byte-identical to this repository. Some shell calls contain several commands, so the runner's command classification is an audit aid and undercounts actual command invocations.

This is a small fixture, one repetition, and treatment ran first. The detached worktree is not a security boundary. Host skills remained visible. The result does not establish effectiveness or ineffectiveness on large repositories, statistical significance, or general architectural quality. It does show that this workflow can perform the requested owner-preserving change and that its overhead warrants investigation. Do not tune the fixture or lower its obligations to manufacture a treatment win.

Next evaluation should separate evidence needed for an unresolved relationship from optional orientation and compare the same frozen cases after any workflow change. Broader claims require the remaining ownership, implementation-retirement and dependency-direction tasks, repeated trials, and realistic repository changes.

Machine summary: [maintenance-sol-shared-rule.json](2026-09-06-maintenance-sol-shared-rule.json). Raw local artifacts: `/tmp/scip-maintenance-sol-control-20260906`, `/tmp/scip-maintenance-sol-treatment-20260906`, and `/tmp/scip-maintenance-sol-comparison.json`.
