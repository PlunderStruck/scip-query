# Downstream evidence diversity

## Objective

Increase held-out exploration accuracy without increasing the default six-target drill packet or interpreting repository-specific vocabulary.

## Observed failure

The meta-harness bash-lifecycle treatment found the correct primary symbols and used no native source reads, but recovered only 3/7 strict facts. Exact downstream callees for three different questions were recoverable yet folded behind higher-ranked neighboring calls:

- a predicate used to choose a control path (`insideRepo()`),
- a value-producing state owner (`ProcessManager.start()`), and
- a helper that determines the returned output bound (`truncate()`).

The selector currently reserves upstream causes, callbacks, connectors, and one continuation per explicit anchor. After a step receives one downstream continuation, structurally different callees from that same step compete only by scalar priority. This lets several similar calls crowd out a lower-ranked call that answers a different causal question.

## Failed first ablation

Adding downstream evidence diversity only to `system-map` did not change the relevant packet: the first rerun produced a byte-identical map and remained 3/7 by strict manual adjudication. It used 144,082 total tokens, but the lower cost came from stopping after three semantic queries rather than recovering more evidence.

The trace established the actual discontinuity. `system-map` correctly selected `bashTool`, `classifyBashCommand`, and `runAgentTurn`. The following `inspect` materialized the first two, explicitly withheld `runAgentTurn` behind the behavior character budget, and had no representation of downstream targets from the newly materialized constructs. The navigation chain therefore ended one level too early.

## Selection and continuation contract

After a behavior inspect, derive a new causal frontier directly from the exact source ranges named by the request, including an exact requested construct withheld by the current character budget. A source range is a parser-delimited construct selected by an exact location, definition, or search match. SCIP occurrences inside that range provide compiler-resolved callee identities even when the construct itself is an object-literal method or registry handler with no callable compiler symbol. Including withheld requested ranges lets one final batch retrieve both the missing owner and its direct causal helpers instead of discovering those helpers one query generation later.

Expose at most six causal targets outside the inspected constructs. Within that existing budget, prefer candidates that add a downstream evidence dimension not yet represented:

Use the parser-derived signals already attached to each exact callsite. Within the existing packet budget, prefer candidates that add a downstream evidence dimension not yet represented:

- **control outcome**: the call participates in a branch, catch, finally, or throw;
- **state effect**: the call is awaited or participates in a mutation;
- **returned result**: the call contributes directly to a return or returned shape;
- **produced value**: the call initializes a local binding used by later behavior.

These dimensions describe how the caller uses a callee; they do not guess the user's intent or depend on repository names. One callsite may cover more than one dimension. Only uniquely resolved, non-ambiguous candidates receive a diversity reservation.

The target body contributes one additional repository-independent distinction: a callee owns reachable state effects when its mutation writes through an object identity, such as `this.value++`, `record.status = ...`, or `state[key] ??= ...`. Local scalar reassignment such as tokenizer cursor bookkeeping is not an externally reachable state effect and receives no reservation bonus. This keeps actual lifecycle owners visible without ranking mutation-heavy pure helpers as state owners.

The inspect output must distinguish the frontier from evidence already materialized. It prints exact source locations and one bounded recovery command that combines:

- any requested inspect construct withheld by the packet budget; and
- the selected downstream targets that may resolve named remaining facts.

The skill permits one final combined recovery inspect when, and only when, a requested construct remains withheld or the causal frontier contains a target for a specifically named unresolved fact. Query completion remains scoped to the current packet and is never treated as proof that the user's question is answered.

The ordering remains:

1. reserve an upstream cause and a result-producing callback when present;
2. reserve a connector continuation;
3. give each explicit anchor one continuation;
4. spend remaining slots on as-yet-unrepresented downstream evidence dimensions;
5. fill any remaining slots by the existing evidence and behavior priority.

## Proof

- Unit-test the bounded selector with several high-ranked ordinary callees and lower-ranked control, effect, result, and value callees.
- Keep the existing connector, per-anchor, upstream, callback, and callable-reference tests green.
- Run the focused query tests, typecheck, lint/API compatibility, and the full test suite.
- Verify mechanically that the first inspect exposes `insideRepo()`, `ProcessManager.start()`, and `truncate()` and combines them with the withheld `runAgentTurn()` construct.
- Verify that the resulting recovery inspect materializes every selected unit below the behavior evidence ceiling.
- Re-run the frozen meta-harness treatment. Compare strict fact recovery and token use against `183,115` total tokens, `30,558` uncached tokens, `45,327` rendered characters, and `3/7` strict facts. Treat the 144,082-token unchanged-accuracy ablation as diagnostic, not a new accuracy baseline.
- Re-run previously successful held-out tasks if the targeted benchmark improves, to detect a selection regression before publication.

## Result

The final isolated Sol-medium treatment recovered all 7/7 frozen facts by strict manual adjudication with four semantic queries and zero native repository reads. It used 198,169 total model tokens, 34,581 uncached input tokens, and 54,947 rendered exploration characters. Relative to the frozen native control, that is 44.4% fewer total tokens, 44.3% fewer uncached input tokens, and 65.4% fewer rendered characters while recovering seven facts instead of one.

The accuracy improvement adds cost relative to the original 3/7 treatment: 8.2% more total tokens, 13.2% more uncached input, and 21.2% more rendered evidence. The causal result is nevertheless favorable because the same four-query allowance now retrieves every required fact; subsequent work can optimize the skill and evidence encoding without reopening the proven selection gaps.

The deterministic phrase matcher reported 2/7 on this answer even though the answer explicitly states all seven compound facts. It missed semantically equivalent phrasing for dispatcher precedence, hard blocks, containment, foreground termination, and result reinsertion. Manual strict adjudication remains the accuracy authority; the matcher result is retained as evidence that the benchmark needs a semantic adjudication layer rather than silently changing its patterns after observing an answer.

Artifact: `/tmp/meta-harness-bash-lifecycle-treatment-causal-complete-sol-medium.json`.
