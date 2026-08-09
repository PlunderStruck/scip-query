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

| Repository and task | Condition | Manual strict | Automatic | Total tokens | Uncached input | Rendered evidence | Exploration calls | Native reads | Duration |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TSLint config inheritance | control | 6/7 | 3/7 | 739,022 | 102,611 | 277,363 chars | 22 | 22 | 224.1 s |
| TSLint config inheritance | treatment r4 | 6/7 | 1/7 | 386,715 | 67,470 | 67,944 chars | 13 | 0 | 330.7 s |
| meta-harness bash lifecycle | control | 2/7 | 0/7 | 890,159 | 118,222 | 333,771 chars | 13 | 13 | 244.2 s |
| meta-harness bash lifecycle | treatment | 3/7 | 3/7 | 411,792 | 57,883 | 96,694 chars | 27 | 0 | 244.7 s |
| OpenCode session compaction | control | 1/7 | 0/7 | 2,317,547 | 144,272 | 387,388 chars | 26 | 26 | 370.6 s |
| OpenCode session compaction | treatment | 3/7 | 0/7 | 1,787,958 | 112,664 | 313,594 chars | 50 | 0 | 476.8 s |

Relative treatment changes:

| Task | Total tokens | Uncached input | Rendered evidence | Accuracy relation | Interaction relation |
|---|---:|---:|---:|---|---|
| TSLint | -47.7% | -34.2% | -75.5% | strict parity | 13 queries instead of 22 reads; 47.6% longer wall time |
| meta-harness | -53.7% | -51.0% | -71.0% | +1 strict compound fact | 27 queries instead of 13 reads; equal wall time |
| OpenCode | -22.9% | -21.9% | -19.1% | +2 strict compound facts | 50 queries instead of 26 reads; 28.7% longer wall time |

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

Both answers recover the core lifecycle. The treatment strictly closes command normalization and scip routing, unbypassable hard blocks, and the background-process lifecycle. The control strictly closes command normalization/routing and unbypassable hard blocks.

Both omit at least one conjunct from the remaining facts: phase-local tool precedence and thrown/unknown-tool conversion; relative-path and home-path normalization; ignored foreground stdin; and the result callback plus terminal-tool stopping exception. The treatment is therefore non-inferior and slightly better under the frozen strict rule, while using roughly half the model tokens and less than one third of the rendered evidence. It pays for that compression with more, smaller interactions.

Artifacts:

- `/tmp/meta-harness-calibrated-luna-max-control-r1.json`
- `/tmp/meta-harness-calibrated-luna-max-treatment-r1.json`

### OpenCode

The treatment strictly closes queued compaction work, the bounded retained tail, and success/failure/resume behavior. The control strictly closes the bounded retained tail. Both answers are substantially useful beyond these all-or-nothing scores.

The treatment additionally preserves more clauses in the other facts: no-context-limit exclusion, the 20,000-token pruning threshold, the newest-turn/40,000-token protection, and later history filtering. Neither answer completely states the configured/output-token reservation rule, every plugin transformation and summary-assistant marker, the exact later-context reorder, or every pruning stop/protection condition.

The treatment is more accurate and less token-expensive for this run, but it uses 50 sequential scip-query calls and takes longer. Its trace shows repeated text searches and narrow inspections where batched exact roots and typed projections could have reduced interaction count. That is a cockpit-use inefficiency, not evidence of a false exact sensor reading.

Artifacts:

- `/tmp/opencode-compaction-calibrated-luna-max-control-r1.json`
- `/tmp/opencode-compaction-calibrated-luna-max-treatment-r1.json`

## What was established

For these three fixed repositories, commits, questions, and Luna-max runs, the calibrated treatment was never less accurate under manual strict adjudication and reduced total tokens by 22.9–53.7%, uncached input by 21.9–51.0%, and rendered repository evidence by 19.1–75.5%. No treatment used native tracked-source exploration, and every sandbox/cache cleanup completed.

The most plausible causal contribution is that scoped source materialization and statement-complete behavior packets replace broad file reads while preserving selected implementation behavior. That mechanism predicts lower rendered evidence and is directly visible in all three traces. The evidence-audit instruction also changed the final TSLint answer in the predicted direction by preserving cache invalidation that was present but previously omitted.

## What was not established

- Three task shapes do not prove arbitrary-task or arbitrary-language performance.
- One control per task and one final treatment per meta-harness/OpenCode task do not characterize Luna variance.
- The runs do not isolate which calibrated component caused each difference; treatment changes the available surface and its instructions together.
- The automatic matcher is not a valid sole accuracy gate. Its OpenCode 0/7 scores contradict obvious semantic coverage in both answers.
- The OpenCode trace does not establish low interaction overhead; it establishes token/evidence compression despite high interaction count.
- No result justifies an agent-visible query cap or a relevance oracle.

## Remaining release evidence

Before Phase 8 is complete:

1. Run the false-identity collision benchmark/corpus through the packaged CLI and record that no colliding lexical name becomes an exact compiler identity or executable edge.
2. Add and run one held task whose primary implementation language is not TypeScript/JavaScript.
3. Repeat at least the meta-harness and OpenCode treatment/control pairs, or run equivalent independent tasks, to expose variance rather than treating one pair as a stable estimate.
4. Run formatting, typecheck, lint, API compatibility, architecture, full tests, and packaged-install smoke tests from the final tree.
5. Preserve the strict manual audit and do not replace it with literal phrase matching.
