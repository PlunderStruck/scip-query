# Exploration surface calibration: held-run results

Date: 2026-08-09

## Decision served

These runs test whether scip-query can be the repository exploration surface for an agent answering an arbitrary end-to-end code question without losing material facts relative to native search and source reads. Accuracy is the release gate. Token use, rendered evidence, command count, indexing time, and wall time are costs measured after accuracy.

This report does not treat one successful run as proof of the mechanism. The repositories, fixed commits, questions, model, prompt, and manual adjudication rule below are scope conditions. Repeated results across different task shapes are independent evidence only to the extent that the tasks exercise different code and relationships.

## Conditions

- Model: `gpt-5.6-luna`
- Reasoning effort: `max`
- Treatment: detached worktree, private fresh index, installed scip-query and scip-explore guidance, scip-query as the only tracked-text exploration surface
- Control: detached worktree at the same commit, no index, every PATH directory containing a scip-query executable removed
- Time and query count: recorded, never used as correctness cutoffs
- Cleanup: every detached worktree and private cache was removed after its run
- Treatment CLI commit: `45bd509d` (`fix: audit answers against delivered evidence`), including the preceding exploration-surface calibration commits

The automatic matcher requires one literal phrase bundle for each fact. It is retained as a reproducible diagnostic, but it is not a semantic evaluator. Manual strict recovery gives credit only when the answer states every material conjunct in the frozen fact description. A useful but incomplete explanation therefore receives no strict credit for that compound fact.

## Results

| Repository and task                  |    Condition | Manual strict | Automatic | Total tokens | Uncached input | Rendered evidence | Exploration calls | Native reads | Duration |
| ------------------------------------ | -----------: | ------------: | --------: | -----------: | -------------: | ----------------: | ----------------: | -----------: | -------: |
| TSLint config inheritance            |      control |           6/7 |       3/7 |      739,022 |        102,611 |     277,363 chars |                22 |           22 |  224.1 s |
| TSLint config inheritance            | treatment r4 |           6/7 |       1/7 |      386,715 |         67,470 |      67,944 chars |                13 |            0 |  330.7 s |
| meta-harness bash lifecycle          |   control r1 |           2/7 |       0/7 |      890,159 |        118,222 |     333,771 chars |                13 |           13 |  244.2 s |
| meta-harness bash lifecycle          | treatment r1 |           3/7 |       3/7 |      411,792 |         57,883 |      96,694 chars |                27 |            0 |  244.7 s |
| meta-harness bash lifecycle          |   control r2 |           2/7 |       1/7 |      589,569 |         98,927 |     487,623 chars |                45 |           45 |  209.7 s |
| meta-harness bash lifecycle          | treatment r2 |           1/7 |       0/7 |      411,522 |         66,246 |     117,359 chars |                19 |            0 |  280.7 s |
| OpenCode session compaction          |   control r1 |           1/7 |       0/7 |    2,317,547 |        144,272 |     387,388 chars |                26 |           26 |  370.6 s |
| OpenCode session compaction          | treatment r1 |           3/7 |       0/7 |    1,787,958 |        112,664 |     313,594 chars |                50 |            0 |  476.8 s |
| OpenCode session compaction          |   control r2 |           1/7 |       0/7 |    2,652,156 |        167,540 |     492,558 chars |                25 |           25 |  388.1 s |
| OpenCode session compaction          | treatment r2 |           1/7 |       0/7 |    1,349,099 |         92,478 |     236,750 chars |                44 |            0 |  532.4 s |
| agentic_cad chamfer lifecycle (Rust) |      control |           0/7 |       0/7 |    1,091,236 |        100,783 |     404,004 chars |                19 |           19 |  252.0 s |
| agentic_cad chamfer lifecycle (Rust) |    treatment |           0/7 |       1/7 |    1,167,703 |         83,052 |     159,767 chars |                23 |            0 |  335.3 s |

Relative treatment changes:

| Task               | Total tokens | Uncached input | Rendered evidence | Accuracy relation                           | Interaction relation                                   |
| ------------------ | -----------: | -------------: | ----------------: | ------------------------------------------- | ------------------------------------------------------ |
| TSLint             |       -47.7% |         -34.2% |            -75.5% | strict parity                               | 13 queries instead of 22 reads; 47.6% longer wall time |
| meta-harness r1    |       -53.7% |         -51.0% |            -71.0% | +1 strict compound fact                     | 27 queries instead of 13 reads; equal wall time        |
| meta-harness r2    |       -30.2% |         -33.0% |            -75.9% | -1 strict compound fact; equal two-run mean | 19 queries instead of 45 reads; 33.9% longer wall time |
| OpenCode r1        |       -22.9% |         -21.9% |            -19.1% | +2 strict compound facts                    | 50 queries instead of 26 reads; 28.7% longer wall time |
| OpenCode r2        |       -49.1% |         -44.8% |            -51.9% | strict parity                               | 44 queries instead of 25 reads; 37.2% longer wall time |
| agentic_cad (Rust) |        +7.0% |         -17.6% |            -60.5% | strict parity                               | 23 queries instead of 19 reads; 33.0% longer wall time |

## Manual adjudication

### TSLint

The final treatment states per-folder runner reuse, ancestor and home-directory search order, JSON/YAML/module loading, module-cache eviction, built-in and Node-relative `extends` resolution, depth-first base-before-derived order, severity selection, and rule-directory resolution/concatenation/deduplication. It therefore reaches control parity at 6/7.

The remaining strict miss is `derived-config-precedence`: the answer states later rule settings override earlier settings and rule option objects are shallow-merged, but it does not separately state the `linterOptions` merge. Earlier treatment traces contained that statement, and the final audit change successfully preserved the other previously omitted material fact, `delete require.cache[filepath]`. This is evidence that answer-side loss was real, but not that it has been eliminated.

The two preceding post-guidance treatments, before the final evidence-audit instruction, used 633,736 and 1,061,947 total tokens and each recovered approximately 5/7 strict facts. They demonstrate substantial Luna-max variance. The final 386,715-token run is not a stable point estimate by itself.

Artifacts:

- `/tmp/tslint-calibrated-luna-max-control-r1.json`
- `/tmp/tslint-calibrated-luna-max-treatment-r2.json`
- `/tmp/tslint-calibrated-luna-max-treatment-r3.json`
- `/tmp/tslint-calibrated-luna-max-treatment-r4.json`

### meta-harness

Across the repeated pair, the treatment strict scores are `[3, 1]` and the control scores are `[2, 2]`. Their two-run strict mean is therefore equal at 2/7. The first treatment strictly closes command normalization and scip routing, unbypassable hard blocks, and the background-process lifecycle; the first control strictly closes command normalization/routing and unbypassable hard blocks. The second treatment loses compound-fact credit through omissions even though its answer still recovers the core lifecycle.

Both conditions omit at least one conjunct from several compound facts: phase-local tool precedence and thrown/unknown-tool conversion; relative-path and home-path normalization; ignored foreground stdin; and the result callback plus terminal-tool stopping exception. The repeated evidence supports accuracy parity, not a stable gain. Treatment total tokens are unusually stable at about 411,500 in both runs; control total tokens vary from about 590,000 to 890,000. Treatment lowers total tokens, uncached input, and rendered evidence in both pairs, while interaction count and wall time vary.

Artifacts:

- `/tmp/meta-harness-calibrated-luna-max-control-r1.json`
- `/tmp/meta-harness-calibrated-luna-max-treatment-r1.json`
- `/tmp/meta-harness-calibrated-luna-max-control-r2.json`
- `/tmp/meta-harness-calibrated-luna-max-treatment-r2.json`

### OpenCode

Across the repeated pair, the treatment strict scores are `[3, 1]` and the control scores are `[1, 1]`. The first treatment strictly closes queued compaction work, the bounded retained tail, and success/failure/resume behavior. The first control and both second-run answers strictly close the bounded retained tail. Both conditions are substantially useful beyond these all-or-nothing scores.

The treatment additionally preserves more clauses in the other facts: no-context-limit exclusion, the 20,000-token pruning threshold, the newest-turn/40,000-token protection, and later history filtering. Neither answer completely states the configured/output-token reservation rule, every plugin transformation and summary-assistant marker, the exact later-context reorder, or every pruning stop/protection condition.

Treatment is equal or better under the strict rule in both pairs, but the +2 result does not repeat. It lowers total tokens, uncached input, and rendered evidence in both pairs while using more interactions and taking longer. The second treatment also encountered one model-stream disconnect that the runner retried, so its wall time is not a clean interaction-cost measurement. The traces show repeated text searches and narrow inspections where batched exact roots and typed projections could have reduced interaction count. That is a cockpit-use inefficiency, not evidence of a false exact sensor reading.

Artifacts:

- `/tmp/opencode-compaction-calibrated-luna-max-control-r1.json`
- `/tmp/opencode-compaction-calibrated-luna-max-treatment-r1.json`
- `/tmp/opencode-compaction-calibrated-luna-max-control-r2.json`
- `/tmp/opencode-compaction-calibrated-luna-max-treatment-r2.json`

### agentic_cad (Rust)

Both answers identify the correct end-to-end path: UI and agent command origins, Bevy event handling, edge/face/body selection precedence, per-edge operation mutation, mesh regeneration, and deferred undo/redo. Under the frozen all-conjunct rule, both score 0/7 because every paragraph omits at least one explicit guard or bound. Treatment omissions include the clear-edge UI origin, modulo normalization, the 200-entry history eviction, adjacent-edge maximum inset, and the entity/resource existence guards in the deferred command. Control omissions overlap substantially.

The treatment renders 60.5% less repository evidence and uses 17.6% fewer uncached input tokens, establishing that the Rust semantic/source surface also compresses selected evidence. It nevertheless uses 7.0% more total tokens because it takes more accumulated-context turns. This is strict accuracy parity, not a total-token win.

Artifacts:

- `/tmp/agentic-cad-chamfer-luna-max-control-r1.json`
- `/tmp/agentic-cad-chamfer-luna-max-treatment-r1.json`

### False-identity collision corpus

The persistent fixture contains `values.push(...)` and `values.slice(...)` inside `transform`, plus unrelated top-level functions named `push` and `slice` in separate files. The packaged CLI indexed the fixture and projected outgoing execution from `transform`; it emitted the local return relationship and no exact execution edge to either unrelated same-leaf function. The focused internal collision suite also passed 15/15 tests.

The packaged check is repeatable with `npm run verify:identity-collision-cli`. Its temporary repository and private cache are removed by the script.

## Sol-medium model-generalization follow-up

After Phase 8 completed, two additional treatment/control pairs ran against the final CLI binary with `gpt-5.6-sol` at `medium` reasoning. They reused the frozen TSLint and OpenCode definitions and commits above. Every arm used a detached worktree; treatment received a fresh private index plus the installed scip-query and scip-explore guidance, control received no index or scip-query executable, and all four sandboxes and caches were removed. The treatment CLI SHA-256 was `1c8c52bed4f90f2af62195b274d19d28d784c398c5871a508aad0923d69c521b`.

| Repository and task         |     Condition | Manual strict | Automatic | Total tokens | Uncached input | Rendered evidence | Exploration calls | Native reads | Duration |
| --------------------------- | ------------: | ------------: | --------: | -----------: | -------------: | ----------------: | ----------------: | -----------: | -------: |
| TSLint config inheritance   |   Sol control |           5/7 |       4/7 |      284,772 |         48,471 |     102,420 chars |                 7 |            7 |   89.0 s |
| TSLint config inheritance   | Sol treatment |           6/7 |       2/7 |      211,154 |         40,476 |      73,931 chars |                 9 |            0 |  151.4 s |
| OpenCode session compaction |   Sol control |           2/7 |       1/7 |      572,411 |         70,210 |     177,268 chars |                10 |           10 |  143.1 s |
| OpenCode session compaction | Sol treatment |           3/7 |       1/7 |      573,614 |         65,547 |     112,063 chars |                10 |            0 |  205.5 s |

Relative treatment changes:

| Task     | Total tokens | Uncached input | Rendered evidence | Accuracy relation       | Interaction relation                                   |
| -------- | -----------: | -------------: | ----------------: | ----------------------- | ------------------------------------------------------ |
| TSLint   |       -25.8% |         -16.5% |            -27.8% | +1 strict compound fact | 9 queries instead of 7 reads; 70.1% longer wall time   |
| OpenCode |        +0.2% |          -6.6% |            -36.8% | +1 strict compound fact | 10 queries instead of 10 reads; 43.6% longer wall time |

For TSLint, both answers establish per-folder reuse, search order, extends resolution, depth-first ordering, and severity/rule-directory behavior. Treatment additionally preserves `require.cache` eviction. Neither states the separately merged `linterOptions` behavior required by the derived-precedence fact.

For OpenCode, treatment strictly establishes the overflow threshold, queued compaction work, and bounded retained tail. Control strictly establishes queued work and the retained tail; its wording does not establish that the 20,000-token bound caps the fallback output-token allowance. Both answers omit at least one required clause from summary execution, success/resume, later-context reconstruction, and pruning. In particular, neither completely states prior compaction-pair hiding plus cloned-history plugin transformation and compaction-mode markers; the `compaction_continue` marker; that durable history is retained rather than deleted; and every pruning stop condition.

Artifacts:

- `/tmp/tslint-calibrated-sol-medium-control-r1.json`
- `/tmp/tslint-calibrated-sol-medium-treatment-r1.json`
- `/tmp/opencode-compaction-calibrated-sol-medium-control-r1.json`
- `/tmp/opencode-compaction-calibrated-sol-medium-treatment-r1.json`

## Capability-manual skill rewrite follow-up

The exploration skill was then rewritten as a command/question manual: it removed the private evidence ledger and final-answer audit, retained exact syntax plus relationship-family questions, and told the agent that scip-query is a set of explicit controls rather than a relevance oracle. The treatment prompt was reduced to isolation constraints so the installed skill, rather than duplicated harness instructions, owned exploration behavior.

All four runs below used `gpt-5.6-sol` at `medium` reasoning, the frozen OpenCode definition and commit `1a8e94dc8e7462d3d0d860e1337b448c71947f6b`, detached worktrees, and automatic sandbox/private-cache cleanup. The native control was run once because treatment-only skill edits cannot affect it. Each treatment row is a distinct skill revision, not a repeated sample of one revision.

| Condition            | Manual strict | Automatic | Total tokens | Uncached input | Rendered evidence | Exploration calls | Native reads | Duration |
| -------------------- | ------------: | --------: | -----------: | -------------: | ----------------: | ----------------: | -----------: | -------: |
| Fresh native control |           2/7 |       1/7 |      488,534 |         67,935 |     164,161 chars |                 9 |            9 |  119.2 s |
| Capability manual v1 |           0/7 |       0/7 |    1,038,896 |         92,075 |     268,448 chars |                49 |            0 |  277.8 s |
| Capability manual v2 |           2/7 |       1/7 |      892,662 |         68,180 |     160,553 chars |                26 |            0 |  243.5 s |
| Capability manual v3 |           0/7 |       1/7 |    1,125,614 |         95,235 |     165,441 chars |                37 |            0 |  277.9 s |

Manual strict adjudication follows the frozen compound-fact rule rather than the literal matcher. The control and v2 treatment completely state queued compaction work and bounded retained-tail selection. Their other sections are substantively useful but omit at least one frozen conjunct: the no-context-limit threshold branch; cloned-history plugin transformation; the successful `tail_start_id` update and `compaction_continue` marker; explicit durable-history retention; or the pruning scan's skill-result protection, 20,000-token eligibility threshold, and stop conditions.

The v1 and v3 treatments selected the real but different `packages/core` V2 implementation and relegated the rubric's `packages/opencode` implementation to a coverage note. They therefore receive no strict legacy-path fact credit even where the two implementations share constants or broad behavior. The automatic matcher credits v3's shared 20,000-token vocabulary, demonstrating again that phrase bundles cannot distinguish two semantically different implementations.

The v2 instruction that commands are controls rather than a checklist and that competing implementations must be distinguished reduced the first treatment by 46.9% in calls, 40.2% in rendered evidence, and 14.1% in total tokens while restoring strict parity. Against native control, however, v2 still used 82.7% more total tokens and 188.9% more exploration calls; uncached input was effectively equal (+0.4%) and rendered evidence was slightly lower (-2.2%). A further locator-reuse wording change did not reproduce the selection improvement and was reverted.

This follow-up does not establish that the capability-manual rewrite is an improvement. It establishes a narrower failure: when two genuine implementations share vocabulary, skill prose alone did not reliably cause Sol medium to identify the product-active path, and a failed candidate-only connecting projection did not close that gap. The next discriminating work belongs in the exploration surface's entry/caller/runtime evidence and recovery, not additional task-specific skill wording. The v2 skill remains an uncommitted experiment pending broader evidence.

Artifacts:

- `/tmp/opencode-session-compaction-capability-manual-control-sol-medium.json`
- `/tmp/opencode-session-compaction-capability-manual-treatment-sol-medium.json`
- `/tmp/opencode-session-compaction-capability-manual-v2-treatment-sol-medium.json`
- `/tmp/opencode-session-compaction-capability-manual-v3-treatment-sol-medium.json`

## Terra-xhigh three-surface skill follow-up

On 2026-08-23, a three-arm run isolated the contribution of the exploration surface from the contribution of a new end-to-end investigation skill. All arms used `gpt-5.6-terra` at `xhigh`, the frozen OpenCode question and commit `1a8e94dc8e7462d3d0d860e1337b448c71947f6b`, detached worktrees, and the same answer prompt. The native arm had neither scip-query nor repository skills; the surface-only arm had scip-query and its command skill; the full arm added the candidate scip-explore skill with a private evidence ledger, causal-spine synthesis, and final-answer audit.

| Condition                           | Manual strict | Automatic | Total tokens | Uncached input | Rendered evidence | Exploration calls | Native reads | Duration |
| ----------------------------------- | ------------: | --------: | -----------: | -------------: | ----------------: | ----------------: | -----------: | -------: |
| Native Codex                        |           0/7 |       0/7 |    1,135,107 |        210,819 |     469,234 chars |                15 |           15 |  168.3 s |
| scip-query surface only             |           0/7 |       0/7 |    2,545,459 |        104,013 |     213,516 chars |                53 |            0 |  368.6 s |
| scip-query + candidate scip-explore |           2/7 |       0/7 |    5,058,373 |        151,473 |     339,600 chars |                63 |            1 |  624.0 s |
| tightened scip-explore diagnostic   |           0/7 |       0/7 |    2,804,271 |        112,841 |     271,659 chars |                66 |            0 |  452.5 s |

The initial full-skill answer strictly establishes the legacy overflow threshold and bounded retained tail. It preserves `auto === false`, no-context-limit exclusion, the usable-capacity reservation capped at 20,000 tokens, the default two-turn tail, the 25% budget clamped to 2,000–8,000 tokens, boundary splitting, and `tail_start_id`. Neither control states every conjunct of any frozen fact. All four answers avoid forbidden claims. The literal matcher scores all four 0/7 and therefore remains diagnostic only.

That accuracy gain is not an efficiency win. Against the surface-only arm, the initial full skill uses 98.7% more total tokens, 45.6% more uncached input, 59.1% more rendered evidence, 18.9% more calls, and 69.3% more wall time. Against native exploration, scip-query alone renders 54.5% less repository text and uses 50.7% less uncached input, but uses 124.2% more total tokens and takes 119.0% longer because 27 semantic queries and 26 required continuations accumulate context across 53 calls.

The tightened diagnostic made ledger rows atomic, stopped roots that did not close a row, deferred the capability inventory, and required a bounded authority comparison before implementation reads. It reduced total tokens by 44.6%, uncached input by 25.5%, rendered evidence by 20.0%, and wall time by 27.5% relative to the initial full skill. It nevertheless selected the real but rubric-inapplicable V2 Core path and explicitly left the live legacy path unanalyzed, reducing manual strict recovery to 0/7. The revised skill now permits a single scope to be called authoritative only when exact ingress or consumer evidence connects it to the question; otherwise every plausibly live implementation remains a separate scope.

This follow-up establishes a mechanism-level tradeoff, not a release-quality win. The evidence-ledger version can preserve compound predicates that both controls omit, and scip-query materially compresses selected repository text and uncached input. In this run, however, both scip-query arms cost more total tokens, interactions, and time than native exploration, while the skill's accuracy gain did not survive an efficiency-oriented rewrite. More prose cannot compensate for missing or inconclusive product-active ingress evidence; the next useful validation should repeat the three fixed arms across several task shapes and seeds after that evidence surface is strengthened.

Artifacts:

- `/tmp/scip-explore-ab-terra-xhigh.4p0e7q/native.json`
- `/tmp/scip-explore-ab-terra-xhigh.4p0e7q/base.json`
- `/tmp/scip-explore-ab-terra-xhigh.4p0e7q/explore.json`
- `/tmp/scip-explore-ab-terra-xhigh.4p0e7q/explore-v2.json`

### External evidence checkpoint experiment

A follow-up tested whether complete scip-query packets could stay outside the active model context while a claim-complete Markdown ledger crossed into fresh synthesis. This is a two-context design: one Terra-xhigh `codex exec` process acquired evidence and wrote the ledger, then a second fresh Terra-xhigh process received only the frozen question and ledger. Merely writing the ledger inside one continuing context would not evict the receipts already seen there.

| Condition                                       | Manual strict | Automatic | Total tokens | Uncached input | Rendered evidence | Exploration calls | Native reads |  Duration |
| ----------------------------------------------- | ------------: | --------: | -----------: | -------------: | ----------------: | ----------------: | -----------: | --------: |
| Terra-xhigh external receipts + fresh synthesis |           5/7 |       4/7 |    3,430,894 |        194,674 |     606,435 chars |                23 |            0 |   630.4 s |
| Luna-max external receipts + fresh synthesis    |           2/7 |       4/7 |    7,393,616 |        353,955 |   1,167,865 chars |               108 |           16 | 1,295.8 s |
| Sol-medium external receipts + fresh synthesis  |           7/7 |       5/7 |    3,697,062 |        180,077 |     529,965 chars |                60 |            1 |   670.4 s |
| Sol-low external receipts + fresh synthesis     |           6/7 |       5/7 |    1,525,722 |        137,624 |     360,754 chars |                32 |            1 |   338.5 s |

The acquisition process accounted for 3,382,779 input tokens, 21,541 output tokens, and 568.6 seconds. It captured 55 complete packets totaling 4,961,963 bytes and stored 784,104 bytes of bounded receipts before writing a 26,459-character ledger. The fresh synthesis process made no tool calls and accounted for only 23,415 input tokens, 3,159 output tokens, and 61.7 seconds. The checkpoint therefore worked at its intended boundary: synthesis did not pay again for the full exploration transcript.

The Luna-max arm changed only the model and reasoning profile. Its acquisition used 7,318,836 input tokens and 1,138.4 seconds across 100 packets; synthesis again made no tool calls but used 27,759 input tokens and 157.4 seconds. Relative to Terra, Luna used 115.5% more total tokens, 81.8% more uncached input, 92.6% more rendered evidence, 369.6% more semantic queries, and 105.6% more wall time. The 16 native-read metric events were failed or successful skill-path and stored-receipt inspections rather than direct tracked-source reads, but they still violated the frozen zero-native gate and repeatedly injected evidence that the model had already received.

Strict Luna adjudication passes only the overflow threshold and bounded retained tail. The queued-work section never states that the task is a new user message containing a compaction part. The summary contract omits cloned-history transformation and the assistant's agent marker. The success path does not say that successful compaction updates `tail_start_id`. Later reconstruction omits the `tail_start_id` condition and calls the final segment later messages rather than continuation messages. Pruning omits its after-loop position and stop-at-summary condition and describes already-compacted parts as skipped rather than a stopping boundary. The automatic 4/7 therefore remains diagnostic only.

A later Sol-medium arm kept the frozen question, repository commit, detached sandbox, external-ledger boundary, and synthesis prompt fixed. Manual strict adjudication passes all seven facts. In particular, the answer states the complete cloned-history/plugin/compaction-assistant execution contract and the successful-pair, durable-history, `tail_start_id`, and reordered continuation-history contract that the literal matcher misses. It makes no forbidden claim. The one native-read event searched only the generated ledger's headings; it did not read tracked repository source, but it still fails the frozen zero-native gate.

Sol's acquisition used 3,643,602 input tokens and 608.3 seconds across 60 packets; synthesis made no tool calls and used 30,875 input tokens and 62.1 seconds. It stored 19,281,457 raw-evidence bytes, 977,671 receipt bytes, and a 29,232-character ledger. Relative to Terra, Sol recovered two additional strict facts while using 7.8% more total tokens, 7.5% fewer uncached input tokens, 12.6% less rendered evidence, 160.9% more semantic queries, and 6.4% more wall time. The 60-query trace contains repeated locators and exact-source reads, so its accuracy gain does not establish an efficient acquisition policy.

A Sol-low arm used a private Codex home containing the same Explore instructions seen by the Sol-medium arm, excluding the later paragraph that recorded Sol-medium's result. An initial setup attempt received no model response because the private home lacked credentials; it was discarded. The authenticated run is the only scored arm. Manual strict adjudication passes six facts. It preserves the summary execution contract that the literal matcher misses, but pruning is incomplete: the answer omits the later cleared-output placeholder and describes the protected boundary as the newest two turns instead of scanning beyond the newest user turn. It makes no forbidden claim. Its one native-read metric event loaded the external-evidence skill reference, not repository source, but still fails the frozen zero-native gate.

Sol-low acquisition used 1,487,561 input tokens and 290.1 seconds across 32 packets; synthesis made no tool calls and used 26,575 input tokens and 48.3 seconds. It stored 1,193,206 raw-evidence bytes, 472,221 receipt bytes, and a 20,055-character ledger. Relative to Sol-medium, low reasoning used 58.7% fewer total tokens, 23.6% fewer uncached input tokens, 31.9% less rendered evidence, 46.7% fewer semantic queries, and 49.5% less wall time while recovering one fewer strict fact.

Using the [Codex rate card current on 2026-08-23](https://help.openai.com/en/articles/20001106), the measured Terra-xhigh, Luna-max, Sol-medium, and Sol-low arms account for about 33.20, 6.68, 83.13, and 43.10 credits. At the corresponding regular API rates, that is approximately $1.33, $0.27, $3.33, and $1.72. Sol-low costs 48.2% less than Sol-medium but 29.8% more than Terra. These fixed runs establish a real cost/latency/accuracy tradeoff, not a general model ranking. Terra-xhigh remains the broader-tested live terminal-ledger default; Sol-low is an experimental balanced profile; Sol-medium is the accuracy escalation for unresolved, decision-critical compound claims; Luna-max remains an experimental economy pre-pass.

Against the initial single-context scip-explore run, the checkpoint reduced total tokens by 32.2% and exploration calls by 63.5% while improving manual strict recovery from 2/7 to 5/7. It did not reduce wall time, and acquisition remained expensive: large exact-source receipts raised rendered evidence by 78.6%. Against the surface-only arm, the checkpoint used 34.8% more total tokens and took 71.0% longer. The next optimization target is therefore receipt size and acquisition discipline, not further synthesis compression.

Strict adjudication withheld two facts from the Terra arm. The answer described queued compaction and the later processing loop but did not state that processing precedes ordinary response work. It also distinguished durable tool output from the model-facing view but did not explicitly say that original conversation history remains stored. The external-evidence instructions now require both distinctions. A later receipt-projection change reduced one representative model-facing receipt from about 8.45 KB to 5.19 KB. Terra was not rerun after those changes; the later Sol arm used them but also changed the model, so it cannot isolate their effect.

Artifacts:

- `/tmp/scip-explore-ab-terra-xhigh.4p0e7q/ledger.json`
- `/tmp/scip-explore-luna-max.4JinBL/ledger-luna-max.json`
- `/private/tmp/scip-explore-sol-medium.SVtQAa/ledger-sol-medium.json`
- `/private/tmp/scip-explore-sol-low-control.vt2nAu/ledger-sol-low.json`

A live-session forward test then used the delegated contract with a fresh Terra-xhigh explorer and no inherited conversation turns. The explorer captured seven packets totaling 56,634 bytes and stored 47,041 bytes of receipts, wrote an 8,746-byte terminal ledger, and returned only `LEDGER_READY` plus the assigned path. The main context received no acquisition transcript or receipt contents before reading the ledger. No tracked-source edit occurred during acquisition. This establishes the handoff mechanics for one realistic question; it is not an additional answer-accuracy benchmark.

### Lossless receipt optimization follow-up

A later Sol-low follow-up kept the pinned OpenCode commit, question, detached sandbox, model, reasoning level, and two-context ledger boundary fixed while changing only external-evidence projection and acquisition guidance. The wrapper now keeps exhaustive JSON outside model context, emits complete grouped search identities only when raw count equals the known total, replaces binary-path inventories with count/checksum receipts, carries exact inspect source slices once, externalizes duplicate behavior/frontier encodings, interns stable observation checkpoints, and reuses exact requests plus source ranges already delivered by either `inspect` or `code`. In human-output mode, printed `Continue exactly:` cursors remain mandatory and unchanged; external mode uses the exhaustive file export and refuses when a safe bounded receipt cannot be formed.

| Sol-low condition                         | Manual legacy facts | Both live scopes | Total tokens | Uncached input | Rendered evidence | Semantic queries | Receipt bytes | Duration |
| ----------------------------------------- | ------------------: | :--------------: | -----------: | -------------: | ----------------: | ---------------: | ------------: | -------: |
| Earlier external-ledger baseline          |                 6/7 |       yes        |    1,525,722 |        137,624 |     360,754 chars |               32 |       472,221 |  338.5 s |
| Lossless projection, scope-complete run   |                 7/7 |       yes        |    1,675,860 |        132,956 |     227,167 chars |               27 |       325,501 |  399.1 s |
| Lossless projection, efficient scoped run |                 7/7 |        no        |      932,647 |         98,659 |     164,708 chars |               16 |       231,448 |  287.3 s |

The scope-complete run improved strict clause recovery, uncached input by 3.4%, rendered evidence by 37.0%, semantic queries by 15.6%, and receipt bytes by 31.1%, but total tokens increased 9.8% and duration increased 17.9%. The efficient run improved all measured efficiency dimensions—total tokens by 38.9%, uncached input by 28.3%, rendered evidence by 54.3%, semantic queries by 50.0%, receipt bytes by 51.0%, and duration by 15.1%—but explained only the production-connected legacy path after acknowledging a distinct live core implementation. It therefore fails the no-scope-loss gate despite recovering all seven frozen legacy facts manually. The automatic matcher scored the two runs 6/7 and 5/7 respectively and remains diagnostic only.

This establishes that lossless receipt projection removes substantial representation waste, but does not establish an unsupervised Sol-low policy that simultaneously lowers total tokens and preserves every live scope. The delegated contract now requires a scope manifest and rejects a ledger that names but does not explain a plausibly live production scope. Such a ledger must return blocked and receive a targeted accuracy delta; it cannot be accepted merely because it is cheaper. Terra-xhigh remains the default terminal explorer, and Sol-low remains an experimental base acquisition profile.

Artifacts:

- `/private/tmp/scip-explore-sol-low-lossless-v3.7m42t1/artifact.json`
- `/private/tmp/scip-explore-sol-low-lossless-v5.gm9USC/artifact.json`

### LaunchPoint Canvas payout forward test

A later cross-repository forward test pinned `launchpoint-backend` at commit `f33f0f26fb475700438781baa560d63bff0646fc` and held `gpt-5.6-sol` with low reasoning, the detached sandbox, and one seven-fact question constant across three arms. The question followed `POST /api/buy/creators/payouts/mature` through request gates, all-or-nothing authorization, the independently durable early-maturity stamp, relink holds, per-offer settlement transactions, per-pair credit transactions, result precedence, cache/read-model effects, and scheduled payout repair. The strict manual score requires every clause of a compound fact; the automatic matcher remains diagnostic.

| LaunchPoint condition            | Automatic | Manual compound facts | Known false material claims | Total tokens | Uncached input | Rendered evidence | Tool calls | Semantic queries | Cursor continuations | Agent duration | Cold index |
| -------------------------------- | --------: | --------------------: | --------------------------: | -----------: | -------------: | ----------------: | ---------: | ---------------: | -------------------: | -------------: | ---------: |
| Native Codex                     |       2/7 |                   3/7 |                           0 |      652,507 |         86,425 |     141,212 chars |          9 |                0 |                    0 |        125.5 s |          — |
| scip-query without Explore       |       2/7 |                   2/7 |                           0 |    5,064,764 |        136,477 |     366,350 chars |         70 |               28 |                   42 |        458.9 s |    284.3 s |
| scip-query with external Explore |       2/7 |                   7/7 |                           1 |    1,760,384 |        193,790 |     440,346 chars |         50 |               50 |                    0 |        481.5 s |    266.3 s |

The Explore arm recovered all seven planned compound facts manually. It correctly preserved the non-global transaction boundary, queue-first/manual-group hold ordering, independently committed pair payouts, exact result precedence, post-commit failure behavior, and the payout cron's repair role. Relative to scip-query without Explore, it used 65.2% fewer total model tokens and 28.6% fewer tool calls. Its 5,857,827 raw evidence bytes became 619,655 receipt bytes, an 89.4% external representation reduction, and fresh synthesis consumed only the 30,139-character ledger. It did not lower every metric: uncached input rose 42.0%, rendered tool evidence rose 20.2%, and agent time rose 4.9%; cold-index-plus-agent wall time was effectively equal at +0.6%.

This is not a clean accuracy pass. The Explore ledger and final answer incorrectly said malformed JSON returns 400. Exact route syntax is `bodySchema.safeParse(await req.json())`, so JSON parsing throws before `safeParse` and reaches the generic 500 catch. The native answer identified this correctly. The benchmark definition now records that distinction and rejects the false 400 claim. The result therefore establishes substantially better clause completeness and much lower total-token accumulation than unstructured scip-query use on this frozen task, but it does not yet establish accuracy-preserving Sol-low as a terminal default.

Artifacts:

- `/private/tmp/launchpoint-canvas-control-sol-low.json`
- `/private/tmp/launchpoint-canvas-scip-sol-low.json`
- `/private/tmp/launchpoint-canvas-explore-sol-low.json`

## What was established

For these four fixed repositories, commits, questions, and Luna-max runs, aggregate manual strict accuracy is non-inferior. Individual-run variance is real: the second meta-harness treatment loses one strict fact against its paired control, but the two-run means are equal; OpenCode treatment is equal or better in both pairs. Every pair lowers uncached input and rendered repository evidence. Every TypeScript pair lowers total tokens; the Rust pair increases total tokens by 7.0% while lowering uncached input by 17.6% and rendered evidence by 60.5%. No treatment used native tracked-source exploration, and every sandbox/cache cleanup completed.

The most plausible causal contribution is that scoped source materialization and statement-complete behavior packets replace broad file reads while preserving selected implementation behavior. That mechanism predicts lower rendered evidence and is directly visible in all three traces. The evidence-audit instruction also changed the final TSLint answer in the predicted direction by preserving cache invalidation that was present but previously omitted.

The two post-completion Sol-medium pairs extend the observed model scope. Treatment recovers one additional strict compound fact in each task and lowers uncached input and rendered evidence in both. Total tokens fall materially for TSLint and are effectively equal for OpenCode. This establishes favorable results for these two fixed Sol-medium pairs, not a model-independent effect.

The external-ledger Sol-medium arm establishes that one fresh-synthesis run can recover all seven frozen OpenCode compound facts while keeping acquisition packets out of synthesis. Its higher query count and credit cost keep that result from establishing Sol as the default explorer profile.

The external-ledger Sol-low arm establishes one observed point between Terra-xhigh and Sol-medium: one more strict fact than Terra with roughly half Terra's wall time, and one fewer strict fact than Sol-medium with roughly half Sol-medium's credits. It does not establish that this ordering repeats.

## What was not established

- Four task shapes, including one Rust task, do not prove arbitrary-task or arbitrary-language performance.
- Two meta-harness and OpenCode pairs expose substantial Luna variance but still do not characterize the full score distribution.
- One Sol-medium pair per task does not characterize Sol variance or establish that the result transfers to the other held tasks.
- One Sol-medium external-ledger arm does not establish that its 7/7 recovery repeats across seeds, tasks, or later skill revisions.
- One Sol-low external-ledger arm does not establish its score distribution or justify changing the default profile.
- The runs do not isolate which calibrated component caused each difference; treatment changes the available surface and its instructions together.
- The automatic matcher is not a valid sole accuracy gate. Its OpenCode 0/7 scores contradict obvious semantic coverage in both answers.
- The OpenCode trace does not establish low interaction overhead; it establishes token/evidence compression despite high interaction count.
- No result justifies an agent-visible query cap or a relevance oracle.

## Final release gates

Phase 8 passed the following gates from the final implementation tree:

- TypeScript typecheck, formatting, ESLint, build, API compatibility, the public API consumer, and skill-link validation pass.
- Architecture maps 474/474 indexed files into 36 declared boundaries, declares all 36 dependency rows, and reports no forbidden dependency edge.
- The complete test suite passes with bounded host concurrency: 288 files and 2,362 tests. An initial unbounded run passed 2,360 tests but oversubscribed two process-spawning CLI tests past their 5- and 10-second limits and triggered a Vitest worker-RPC timeout. Those files then passed 33/33 alone, and both passed inside the bounded complete run.
- `npm run verify:identity-collision-cli` passes against the packaged false-identity corpus.
- A clean consumer installed the `scip-query@0.20.0` tarball produced by `npm pack`; the installed `scip-query --help` and `scip-query capabilities` commands both ran successfully.

The strict manual audit remains the accuracy gate. Literal phrase matching remains only a reproducible diagnostic.
