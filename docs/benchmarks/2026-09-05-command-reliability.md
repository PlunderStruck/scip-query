# Command reliability pass — 2026-09-05

The original 98-command inventory now contains 97 commands. TLA is retired. Every original command has a purpose, retention decision, coverage limit and test evidence in [the command ledger](../../benchmarks/full-tool-audit/2026-09-05/followup/COMMAND_DECISIONS.md). The [machine ledger](../../benchmarks/full-tool-audit/2026-09-05/followup/command-ledger.json) links individual regression files and CLI assertions.

## Removed

Removed the `tla` command, its seven implementation modules, CLI registration, dedicated tests, generated recorder/scaffold support, model fixtures and active skill/reference guidance. Dated audit reports remain historical evidence. The shared verified-binary downloader remains because Windows SCIP installation uses it. The public TypeScript API contract still passes.

No other command was removed in this pass. Similarity, wrapper, stale-abstraction and locality commands retain a distinct use as optional inspection aids. Their output does not establish that code should be deleted, merged or moved. The ordinary workflow remains search/outline → selected evidence/source → health/review and diff-impact; agents need not choose among all 97 controls for each task. Four commands are internal worker/hook protocols.

## Correctness repairs

| Failure reproduced | Result after repair |
| --- | --- |
| A call inside an unindexed nested function was labeled an exact call by its outer function. | Both source and TypeScript compiler adapters assign calls to their nearest callable. Nested declarations, arrows, callbacks and same-line shadowing have regression coverage. |
| Cached TypeScript evidence retained the old incorrect caller. | Callee schema v4 and source-facts version 11 invalidate old evidence. An already-warm CLI fixture recovered without erasing its cache. |
| An aggregate object alias produced an unqualified complete backward slice. | Object/array construction and expression wrappers expose unsupported aliases as incomplete coverage. |
| A deleted property retained its old assignment as exact reaching data. | Delete invalidates prior local definitions and reports the unsupported mutation. |
| An automated exception could cite a config file without tracking the finding's target. | Every target file requires hashed content evidence; changing any target reopens the finding. Multi-site acceptance/invalidation is tested. |
| Existing directory selectors returned empty `system` and `surface` results. | Exact directory prefixes resolve their indexed descendants while preserving exact-file refusal and outside-root checks. |
| `locality-candidates sum` selected `src/consumer.ts` by filename substring. | Only exact/suffix file matches precede symbol resolution. The fixture resolves the actual `sum` symbol. |
| `hierarchy` returned shortened display labels as though they were compiler identities. | Every fallback ancestor is an actual indexed symbol. Unindexed descriptor prefixes are omitted. |
| `members` dropped fields indexed without a full declaration range. | Definition occurrences recover those members and their identifier locations. Shared symbol lookup uses the same evidence. |

The final self-review also led to simpler helpers: callable binding recovery is separate from owner matching; aggregate alias values are separate from reporting; decoding occurrence ranges is separate from cache aggregation. The three introduced complexity findings on those helpers no longer appear. This preserves the same tested behavior rather than silencing their findings.

## Validation

The final frozen-source suite passed **2,841 tests in 333 files**, with zero failures or skipped tests.

- All **82 retained read-command CLI probes** succeeded on a real compiler-indexed TypeScript fixture. This establishes valid execution, not arbitrary-repository accuracy.
- **44 explicit CLI assertions** checked hand-written facts: source bytes, files/fields/owners, exact calls, dependency direction and cycle witness, changed/new functions, complexity deltas, duplicate bodies, data relationships and missing coverage. Their expected values are derived from fixture source, not copied from command output.
- A separate **first-use scan with no SCIP index and an empty cache** analyzed all 13 TypeScript files and 28 functions, found the seeded dependency cycle, reported accounted coverage, and created no index.
- Positive and negative React/Vue detector cases and setup/index/watch/output-transport lifecycle contracts ran in the regression suite. The plain TypeScript CLI fixture provides only negative framework smoke evidence. This is not an installation trial on every operating system.
- Build, TypeScript checks, lint, API compatibility and whitespace checks passed. Final focused cleanup checks also passed: 52 ownership/slice/navigation tests, 38 suppression/review tests and 16 semantic-provider/local-flow tests.
- A fresh repository index completed for TypeScript/Python with a reused Rust shard. Final diff impact completed both semantic and source tiers: **376 changed symbols and 24 affected consumer files** across the entire uncommitted diff. This includes work from earlier turns. The temporary watch service used to warm semantic evidence was stopped afterward.
- Architecture reports **zero forbidden boundary edges and zero boundary cycles**. Its coverage explicitly leaves ten Python audit scripts unmapped. This is a check against declared project rules, not proof of ideal architecture.

Artifacts, source hashes, the compiler fixture, test names, CLI packets and review/impact results are in [followup/final](../../benchmarks/full-tool-audit/2026-09-05/followup/final). `create-fixture.py`, `extend-fixture.py`, `command-cases.py`, `assert-command-cases.py` and `finalize-ledger.py` preserve the reproduction path. Historical failing captures are under `followup/before`; they are not passing results.

## Limits and remaining work

A value-flow relationship records an observed assignment or argument/return transfer. A local backward slice collects the modeled definitions and control decisions that can contribute to one selected variable occurrence within a function. Neither is a general proof about heap aliases, unknown call effects, arbitrary dynamic dispatch or execution across functions. Unsupported alias/delete cases are now explicit; unsupported semantics must still be read as limits.

`health` and `review` measure implemented TS/JS function rules, token duplication and resolved source dependencies. CRAP combines complexity with measured test coverage; no matching coverage artifact means unavailable CRAP, never invented zero coverage. The scanner does not determine business ownership or whether an abstraction is conceptually right. Framework extraction, wrappers, similarity and locality remain candidates requiring source and contract review.

The final repository-wide review has **42 blocking complexity findings** (30 introduced and 12 worsened relative to HEAD), and no blocking architecture findings. Many belong to earlier uncommitted implementation work. Remaining warnings in code touched by this pass include the local-flow statement/access dispatchers, AST callee scan, source callable classification and suppression policy. They were assessed as ordered syntax/policy cases with dedicated regression coverage; they are not waived or represented as a clean review. Further refactoring should preserve those cases and be assessed independently, rather than split functions solely to lower a count.

This pass repairs reproduced failures and adds executable evidence. It does **not** establish a global accuracy percentage, validate all of LaunchPoint, or prove that a cheaper coding agent produces better changes with the tool. That last claim requires a controlled task comparison using the intended model, with independent checks of the resulting changes. No new model benchmark was run in this pass.
