# Exploration surface baseline

## Purpose

This baseline freezes the results that precede the next-anchor-selection experiment. The product goal is an indexed exploration surface that lets an agent answer arbitrary repository questions with no less accuracy and fewer model tokens than native text search and file reads.

The next experiment changes how scip-query exposes the structurally important anchors after the first root is found. These results must not be retroactively rescored or replaced after that change.

## Method

- Repository under explanation: `arxiv-agent-cli`.
- Every run used the same checkout and one fresh scip-query index. No repository copy was created per run.
- A treatment used scip-query as its only tracked-source exploration surface.
- A control was instructed to use native repository search and source reads and not to invoke scip-query. Its trace was checked for zero scip-query calls.
- Luna ran as `gpt-5.6-luna` with `max` reasoning. Sol ran as `gpt-5.6-sol` with `medium` reasoning.
- `Total tokens` is model input plus model output. Cached input remains included because it still consumes context and is part of the observed exploration cost.
- `Strict facts` is a manual audit against every required fact in the fixture. A fact counts only when the answer establishes the whole described behavior. The automated phrase matcher is useful for repeatability but undercounts valid paraphrases, so it is not the accuracy authority for this baseline.
- None of the audited answers made a fixture-forbidden claim.

The control is behaviorally isolated, not yet capability isolated: scip-query remains installed on the host, although the prompt forbids it and the recorded trace verifies that it was not invoked. Future control runs should shadow or remove the executable from the control process so treatment leakage is technically impossible rather than merely observable afterward.

The fixtures are:

- `benchmarks/exploration/arxiv-download-v1.json`: guided end-to-end flow, seven facts.
- `benchmarks/exploration/arxiv-download-open-v1.json`: open-ended form of the download question, seven facts.
- `benchmarks/exploration/arxiv-durability-discovery-v1.json`: concept-led durability and recovery question, six facts.
- `benchmarks/exploration/arxiv-library-mutations-v1.json`: cross-cutting mutation and repair question, six facts.

## Matched treatment and control results

| Model      | Task                    | scip-query tokens | Native tokens | Token reduction | scip-query strict facts | Native strict facts |
| ---------- | ----------------------- | ----------------: | ------------: | --------------: | ----------------------: | ------------------: |
| Luna max   | Guided download         |           164,547 |       958,949 |           82.8% |                     6/7 |                 3/7 |
| Luna max   | Open download           |           260,174 |       712,462 |           63.5% |                     4/7 |                 2/7 |
| Luna max   | Concept-led durability  |           488,449 |       636,392 |           23.2% |                     4/6 |                 2/6 |
| Sol medium | Guided download         |           183,627 |       343,375 |           46.5% |                     7/7 |                 4/7 |
| Sol medium | Concept-led durability  |           245,219 |       408,270 |           39.9% |                     5/6 |                 2/6 |
| Sol medium | Cross-cutting mutations |           204,992 |       242,219 |           15.4% |                     5/6 |                 4/6 |

There is no matched native control yet for Luna on cross-cutting mutations or for either model on Sol's open-download treatment. Those rows must not be treated as controlled token comparisons.

## Treatment detail

| Model      | Task and prompt          | Total tokens | Uncached input | Output |                Semantic queries | Rendered characters | Duration | Strict facts |
| ---------- | ------------------------ | -----------: | -------------: | -----: | ------------------------------: | ------------------: | -------: | -----------: |
| Luna max   | Guided, full protocol    |      164,547 |         34,694 | 12,605 |                               3 |              58,396 |  236.7 s |          6/7 |
| Luna max   | Guided, minimal protocol |      257,012 |         41,241 | 10,971 |                               4 |              65,527 |  269.4 s |          4/7 |
| Luna max   | Open download            |      260,174 |         41,657 | 19,861 |                               5 |              66,219 |  373.4 s |          4/7 |
| Luna max   | Concept-led durability   |      488,449 |         57,986 | 20,863 |                               9 |              76,593 |  397.0 s |          4/6 |
| Luna max   | Cross-cutting mutations  |      405,100 |         49,627 | 22,417 |                               7 |              72,500 |  427.0 s |          4/6 |
| Sol medium | Guided, full protocol    |      183,627 |         27,355 |  4,464 |                               4 |              36,617 |  103.1 s |          7/7 |
| Sol medium | Guided, minimal protocol |      217,797 |         26,625 |  2,756 |                               5 |              57,617 |   75.1 s |          5/7 |
| Sol medium | Open download            |      261,153 |         49,733 |  6,620 |                               5 |             109,265 |  195.4 s |          6/7 |
| Sol medium | Concept-led durability   |      245,219 |         37,986 |  5,505 |                               5 |              61,535 |  168.0 s |          5/6 |
| Sol medium | Cross-cutting mutations  |      204,992 |         37,848 |  6,120 | 3 plus 1 transport continuation |              64,130 |  131.7 s |          5/6 |

## Prompt ablation

Instruction discipline contributes real savings, but it does not explain the whole treatment effect:

| Luna guided mode            | Total tokens | Strict facts |
| --------------------------- | -----------: | -----------: |
| Native control              |      958,949 |          3/7 |
| Disciplined native control  |      384,853 |          3/7 |
| Minimal scip-query protocol |      257,012 |          4/7 |
| Full scip-query protocol    |      164,547 |          6/7 |

Sol's minimal scip-query protocol used 217,797 tokens and recovered 5/7 strict facts, compared with 183,627 tokens and 7/7 under the full protocol. The omitted facts were sequential batch processing and the complete compaction/finally commit sequence. Reducing instructions alone therefore does not produce reliable completeness.

## Established result

Across every matched pair, scip-query used fewer total model tokens and recovered at least as many strict facts as native exploration. Savings were greatest when the question defined a narrow relevance boundary and smallest when the answer required an exhaustive cross-cutting mutation surface.

Model capability changes the cost of choosing and synthesizing evidence. Sol needed fewer drilldowns than Luna on the concept-led and cross-cutting tasks. It does not remove the need for the exploration surface: Sol's scip-query treatments still used 15.4% to 46.5% fewer tokens than their matched controls while recovering more facts.

## Causal diagnosis for the next experiment

Finding the first root is not the primary remaining cost. In the concept-led treatment, one exact search normally found the entry anchor. Accuracy and token loss arose afterward:

1. An entry anchor represented the start of the flow but not every independent concern in the question.
2. The first map showed connected behavior, yet important persistence, coordination, duplicate, and recovery owners remained lower-level or folded evidence.
3. The model had to infer the next anchor set and decide whether its evidence was complete.
4. Weaker selection and stopping caused repeated inspections or an answer that omitted a material fact.

The next implementation must therefore expose structurally important next-anchor candidates from the observed graph and behavior. It must not attempt to infer repository-specific concepts such as “durability” from English. The model retains responsibility for deciding which candidates matter to the question; scip-query retains responsibility for exact identity, relationship evidence, and explicit coverage.

## Acceptance gates for next-anchor selection

Run the new treatment against this frozen treatment baseline before comparing it with native controls again.

1. Guided Sol remains 7/7.
2. Concept-led durability reaches 6/6 for Sol and does not regress for Luna.
3. Cross-cutting mutations reaches 6/6 for Sol.
4. No treatment uses native tracked-source exploration reads.
5. No fixture-forbidden claim appears.
6. Once accuracy holds, compare total tokens, uncached input, semantic-query count, rendered characters, and duration with the treatment-detail table above.
7. Before publishing a final treatment/control claim, capability-isolate the control process from the scip-query executable and index rather than relying only on prompt discipline and trace verification.

An accuracy improvement purchased with a small initial token increase is acceptable for diagnosis. Persistent token efficiency becomes the optimization target after the anchor packet reliably covers every material concern.

## Post-baseline anchor and evidence experiments

These results were produced after the frozen baseline. They do not replace any row above. They test three changes together: compound anchor discovery, connected behavior with exact interior focus, and coverage-diverse optional drill targets that reserve one semantic continuation from a causal connector.

| Model      | Task                                       | Total tokens | Semantic queries | Rendered characters | Native reads | Manual strict facts |
| ---------- | ------------------------------------------ | -----------: | ---------------: | ------------------: | -----------: | ------------------: |
| Sol medium | scip-query runtime-boundary self-host task |      149,923 |                3 |              41,069 |            0 |                 5/5 |
| Sol medium | Cross-cutting mutations, efficient run     |      148,067 |                4 |              43,002 |            0 |                 5/6 |
| Sol medium | Cross-cutting mutations, accuracy run      |      176,427 |                4 |              42,986 |            0 |                 6/6 |
| Sol medium | Concept-led durability, accuracy run       |      184,638 |                4 |              37,849 |            0 |                 6/6 |

The efficient mutation run was the diagnostic that exposed the final missing fact: the answer described every event operation but left the event's `id` and `version` fields implicit. The next run added a general answer audit for event, log, and outbox writes and recovered all six facts. The 176,427-token accuracy run is 13.9% below the frozen 204,992-token treatment and 27.2% below the 242,219-token native control. The 148,067-token run is 27.8% below the frozen treatment, showing the lower-cost frontier but not yet stable full accuracy.

The mutation map previously spent all six visible optional targets on helpers attributed to one large `remove()` outline. The revised selector first exposes the strongest exact callee of a causal connector, then spreads one target across explicit anchor steps before returning to ordinary evidence/effect ranking. On the real repository this moved `SqliteMutex.acquire()` to the first visible target. Its focused body proved that the shared wrapper opens the configured SQLite database and acquires a write transaction with `BEGIN IMMEDIATE`, closing the prior process-local-versus-cross-process coverage gap without a native source read.

The automated phrase evaluator is not an accuracy authority for these runs. It reported 3/6 for the 148,067-token answer and 2/6 for the more complete 176,427-token answer, despite the latter explicitly stating every required fact. Future benchmark work should add a semantic or adjudicated scoring layer while retaining the deterministic matcher as a diagnostic signal.

## Vega cross-repository validation

The next experiment used `Vega_2.0` and the seven-fact `vega-work-session-stream-v1` fixture. The question begins in a companion command, crosses the `work_session_stream_events` HTTP-dispatch discriminator, then requires controller validation, bounded event normalization, transactional sequence assignment, and realtime notification. This is a stronger cross-repository test because the relevant behavior occupies separate companion and API call graphs joined by a runtime protocol rather than one ordinary call chain.

| Sol medium treatment                         | Total tokens | Semantic queries | Rendered characters | Native reads | Manual strict facts |
| -------------------------------------------- | -----------: | ---------------: | ------------------: | -----------: | ------------------: |
| Connected-set locator before composition     |      494,821 |               10 |              74,303 |            0 |                 6/7 |
| Cross-boundary composition                   |      333,225 |                7 |              75,571 |            0 |                 6/7 |
| Composition plus optional upstream entry     |      534,983 |                5 |              58,292 |            0 |                 7/7 |
| Upstream entry repeat during concurrent edit |      659,733 |                5 |              66,878 |            0 |                 7/7 |
| Isolated cross-boundary and upstream entry   |      224,775 |                4 |              58,335 |            0 |                 7/7 |

Cross-boundary composition reduced total tokens by 32.7% and semantic queries by 30% in the comparable 6/7 runs. It recovered the previously missed API handler fact—placing `sessionId` in request params and `events` in the body—but that run omitted the companion command's initial parsing, context, and authorization facts. Adding the optional upstream entry recovered all seven required facts in one map plus one batched inspect.

The 534,983-token total is not a clean exploration-cost comparison. Before the successful three-query exploration, that agent made two failed `anchors` attempts and ran `ps -axo pid=,etime=,command=`, injecting 166,753 rendered characters from the host process table into its context. The benchmark metrics count only 58,292 characters from the tracked exploration surface, so this accidental native diagnostic output is absent from `renderedCharacters` but present in model tokens.

The repeat recovered 7/7 again, but it also does not provide a clean token estimate. A Vega source file changed after the manual refresh and during the run. The first locator succeeded against the initial generation; a repeated locator then encountered staleness, waited for a 99-second demand refresh, and ran again. The eventual evidence path was still one successful locator, one three-anchor map, and one batched inspect. Together the two runs establish the accuracy effect of the upstream entry, while neither establishes a token regression or saving for that addition. A stable snapshot or dedicated reusable benchmark worktree is required for its efficiency estimate.

The isolated run supplies that estimate. The runner resolved Vega commit `350a06cd172ccd034a920d5f124fe2ac63340403`, created a disposable detached worktree and private cache, built the index before starting the measured model turn, and deleted the worktree plus cache afterward. The 106,975 ms index setup is recorded separately from the 182,636 ms agent duration. A post-run audit confirmed that the repository directory, its parent cache directory, and the Git worktree registration were all gone.

At 224,775 tokens and 7/7 manually audited facts, the isolated treatment is 54.6% below the original 494,821-token connected-set treatment and 32.5% below the 333,225-token cross-boundary run that still recovered only 6/7. It used one map and one batched inspect, although the agent unnecessarily repeated the successful locator once. Removing that duplicate is a remaining general efficiency opportunity rather than an accuracy gap.

The deterministic phrase evaluator reported 4/7 for the first three successful composition runs and 6/7 for the isolated run, even though manual inspection found 6/7, 7/7, 7/7, and 7/7 respectively. For example, the final answers explicitly say "limited to 12,000 characters," "at most 200," and describe the row lock, maximum sequence, consecutive insertion, and heartbeat update. These false negatives reinforce that strict manual or semantic adjudication remains the accuracy authority.

Artifacts:

- `/tmp/vega-work-session-stream-current-sol-medium.json`
- `/tmp/vega-work-session-stream-cross-boundary-sol-medium-v2.json`
- `/tmp/vega-work-session-stream-cross-boundary-upstream-sol-medium.json`
- `/tmp/vega-work-session-stream-cross-boundary-upstream-clean-sol-medium.json`
- `/tmp/vega-work-session-stream-isolated-sol-medium.json`

One earlier post-composition attempt stopped at a stale index before running the locator. It is excluded because it did not test the exploration surface.

## Benchmark isolation contract

`scripts/codex-exploration-trial.mjs` now defaults to `--isolation detached`. For every run it:

1. resolves the requested `--ref` (default `HEAD`) to one commit;
2. creates a clean detached Git worktree under one temporary parent;
3. points `SCIP_QUERY_PROJECT_ROOT` at that worktree and `SCIP_QUERY_CACHE_DIR` at a private cache under the same parent;
4. prepares a treatment index before model timing begins;
5. disables the watch service inside the run; and
6. removes both the Git worktree registration and the entire temporary parent in a `finally` block.

This makes concurrent edits in the source worktree causally incapable of changing a benchmark observation. `--isolation live` remains available for deliberate debugging, but a live result is not an acceptance-quality benchmark. Control runs receive the same detached repository and private empty cache but do not prepare a scip-query index.

## Held-out TSLint generalization check

The first deliberately held-out check used archived TSLint commit
`285fc1db18d1fd24680d6a2282c6445abf1566ee`. This repository and task did not
influence the anchor, system-map, behavior, or runtime-boundary implementation.
The seven-fact question asked how implicit configuration discovery, recursive
`extends`, file loading, severity selection, and configuration merging work.
Unlike the earlier runtime-flow tasks, this is a recursive discovery and data-
normalization problem.

| Sol medium mode | Total tokens | Uncached input | Rendered characters | Exploration calls | Agent duration | Manual strict facts |
| --------------- | -----------: | -------------: | ------------------: | ----------------: | -------------: | ------------------: |
| scip-query      |      148,993 |         23,576 |              33,497 |                 3 |        137.0 s |                 3/7 |
| Native control  |      231,594 |         55,361 |              62,973 |                 8 |        109.5 s |                 5/7 |

The treatment reduced total model tokens by 35.7%, uncached input by 57.4%,
and rendered exploration characters by 46.8%. Its detached index took 1.9
seconds outside model timing, and both temporary worktrees and private caches
were confirmed deleted after the runs. The treatment was nevertheless 25.2%
slower in agent time and failed the accuracy-parity requirement.

The treatment selected the configuration discovery, loading, recursive parsing,
and rule-directory owners. It did not select the upstream `doLinting` owner, so
it omitted the runner's consecutive-folder configuration reuse. Its map exposed
the call to `extendConfigurationFile` without materializing that helper, and the
single inspect instead expanded discovery plus recursive parsing. Consequently,
the answer omitted the complete linter-option/rule-option merge behavior and
rule-directory deduplication. The native control read those owners directly and
recovered more facts, although it still omitted JavaScript configuration cache
eviction and the full field-wise merge fact.

This result is evidence that the compression mechanism transfers to an untouched
repository, not evidence of arbitrary-task accuracy. The next general problem is
coverage-directed selection: the packet must expose which requested stages or
effects remain represented only by an unexpanded caller/callee, and it must make
the smallest missing upstream owner and merge/effect owner selectable together.
That must be solved structurally; adding TSLint vocabulary or a configuration-
specific heuristic would invalidate the point of the holdout.

The deterministic evaluator reported 2/7 for treatment and 4/7 for control. The
manual scores above require the complete fact rather than phrase overlap. A trace
classification defect also labeled the treatment's `scip-query anchors` call as
a native search because the quoted English question contained the word `find`.
The agent did not execute a native search. Future measurements must classify the
shell command rather than matching command names inside quoted arguments.

Artifacts:

- `/tmp/tslint-config-heldout-treatment-sol-medium.json`
- `/tmp/tslint-config-heldout-control-sol-medium.json`

## Bidirectional causal-slice follow-up

The next implementation made the drill packet bidirectional. It now reserves
one exact incoming caller, recognizes compiler-resolved callable references
such as reducer callbacks, and preserves the enclosing control/effect signals
when a multiline statement is reduced to one focused line. Direct call
occurrences are deduplicated from callable-reference occurrences, and source
AST evidence prevents ordinary constants from being mislabeled as callable
continuations.

| Frozen Sol medium run                              | Total tokens | Uncached input | Rendered characters | Semantic queries | Native reads | Manual strict facts |
| -------------------------------------------------- | -----------: | -------------: | ------------------: | ---------------: | -----------: | ------------------: |
| TSLint native control                              |      231,594 |         55,361 |              62,973 |                0 |            8 |                 5/7 |
| TSLint treatment before causal selection           |      148,993 |         23,576 |              33,497 |                2 |            0 |                 3/7 |
| TSLint incoming-call-only treatment                |      156,772 |         26,009 |              34,193 |                3 |            0 |                 4/7 |
| TSLint caller plus callable-reference treatment    |      148,002 |         24,522 |              37,126 |                3 |            0 |                 6/7 |
| Vega isolated treatment before callable references |      224,775 |         40,189 |              58,335 |                4 |            0 |                 7/7 |
| Vega causal-reference regression                   |      176,197 |         26,081 |              44,262 |                3 |            0 |                 7/7 |

On TSLint, the final packet selected both `doLinting()` as the upstream caller
and `extendConfigurationFile()` as the result-producing callback. The agent
inspected both in one batch and recovered runner reuse, depth-first inheritance,
field-wise merge precedence, rule-directory deduplication, and severity flow.
Its only strict miss was naming the exact `tslint.json`, `tslint.yaml`, then
`tslint.yml` filename preference; it described the ordered `CONFIG_FILENAMES`
search without expanding the constant. Compared with native control, the run
used 36.1% fewer total tokens, 55.7% fewer uncached input tokens, and 41.0% fewer
rendered exploration characters while recovering one more strict fact.

The frozen Vega regression retained 7/7 strict facts. It used one fewer semantic
query than the prior isolated run and reduced total tokens by 21.6%, uncached
input by 35.1%, and rendered exploration characters by 24.1%. This is evidence
that compiler-resolved callable-reference edges generalize beyond the TSLint
holdout and do not regress the established HTTP/runtime-boundary flow.

The deterministic phrase evaluator again undercounted both answers (2/7 for
TSLint and 3/7 for Vega) even though the answers explicitly stated the facts
above. Manual strict adjudication remains the accuracy authority for these
runs.

Artifacts:

- `/tmp/tslint-config-causal-treatment-sol-medium.json`
- `/tmp/tslint-config-causal-reference-treatment-sol-medium.json`
- `/tmp/vega-work-session-causal-reference-sol-medium.json`

## OpenCode third-repository compaction diagnostic

The next held-out task used OpenCode commit
`1a8e94dc8e7462d3d0d860e1337b448c71947f6b`. The seven facts were frozen
before either model turn. They asked how automatic session compaction is
triggered and queued, how its retained tail is selected, how the summary is
generated, how work resumes, how future model history is reconstructed, and
how old tool output is pruned.

Both Sol-medium arms used independent disposable worktrees. Treatment received
a fresh private index; control received no index and was forbidden from using
scip-query. The worktrees and caches were removed after completion.

| Sol medium mode | Total tokens | Uncached input | Rendered characters | Exploration calls | Agent duration | Manual strict facts |
| --------------- | -----------: | -------------: | ------------------: | ----------------: | -------------: | ------------------: |
| Native control  |      508,976 |         59,345 |             568,453 |                10 |        125.6 s |                 2/7 |
| scip-query      |      530,272 |         70,176 |             160,005 |                 9 |        324.5 s |                 0/7 |

Treatment rendered 71.9% fewer repository characters, but used 4.2% more total
tokens and 18.3% more uncached input tokens. Its private index took 60.2 seconds
outside the measured model turn. It made no native repository reads, but used
seven semantic queries plus two transport continuations, exceeding the intended
one-locator, one-map, one-inspect path. Five of those queries repeated the same
`anchors` question with different limits; the first two were exact duplicates.

The native control's first broad `rg` returned 438,860 characters. That is the
noise scip-query is supposed to avoid. Despite that cost, the control noticed
that the monorepo contains two materially different compaction implementations:
the `packages/opencode` prompt-loop compactor and a newer `packages/core`
compactor. It centered the requested lifecycle on the former and explicitly
separated the latter. It completely established retained-tail selection and
future-context reconstruction. Its other five facts were substantial but
strictly incomplete: it omitted at least one required predicate or branch from
each compound fact.

Treatment selected the `packages/core` compactor as its main system, then mixed
isolated `packages/opencode` details into that explanation. It did not establish
the `packages/opencode` queued compaction task, complete tail policy, plugin and
summary contract, failure/resume branches, `filterCompacted` reconstruction, or
tool-output pruning. Its own answer correctly disclosed the outer loop and
pruning as unexamined. Therefore none of the seven frozen facts was complete.

The deterministic matcher reported 1/7 for control and 0/7 for treatment. The
manual strict score above gives credit only when the whole frozen behavior is
stated, consistent with earlier benchmark adjudication.

This pair is a valid diagnostic but not an acceptance-quality treatment/control
claim. The question said “OpenCode” without choosing between two implementations,
while the frozen facts targeted `packages/opencode`. A correct open-ended answer
should surface that ambiguity rather than silently choose one, so treatment's
failure remains meaningful. However, the prompt's underspecified scope is a live
alternative explanation for which implementation was selected. The next clean
benchmark must either name the runtime/package boundary in advance or define
facts that require recognizing and distinguishing both implementations.

Artifacts:

- `benchmarks/exploration/opencode-session-compaction-heldout-v1.json`
- `/tmp/opencode-session-compaction-control-sol-medium.json`
- `/tmp/opencode-session-compaction-treatment-sol-medium.json`

## Meta-harness bash-lifecycle heldout comparison

Because the OpenCode prompt left two same-named systems in scope, the next
acceptance-quality pair used a fourth repository and named one unique runtime
surface. The repository was meta-harness at commit
`7106e38fb5cc8ef4bfb0fff6b57cd3cd6f4caf41`. The question asked how an agent's
`bash` request moves through phase gating, command normalization, safety policy,
confirmation, foreground or background execution, termination, and reinsertion
into the next model turn. Seven facts and three forbidden claims were frozen
before either arm ran.

| Sol medium mode | Total tokens | Uncached input | Rendered characters | Exploration calls | Agent duration | Manual strict facts |
| --------------- | -----------: | -------------: | ------------------: | ----------------: | -------------: | ------------------: |
| Native control  |      356,261 |         62,103 |             158,809 |                 7 |        106.6 s |                 1/7 |
| scip-query      |      183,115 |         30,558 |              45,327 |                 4 |        154.3 s |                 3/7 |

Treatment used 48.6% fewer total model tokens, 50.8% fewer uncached input
tokens, and 71.5% fewer rendered exploration characters. It made four semantic
queries and no native repository reads. The native arm made seven repository
reads. Treatment's fresh private index took 2.0 seconds outside model timing.
Treatment agent time was 44.8% longer despite the lower token and query counts.

Strict adjudication requires the whole frozen fact, including any stated hard
bound or safety branch. Treatment completely recovered:

- command trimming, background-suffix removal, empty-command rejection, and
  dedicated routing of direct scip-query invocations;
- the unbypassable fork-bomb, privilege-escalation, and system-root deletion
  blocks; and
- foreground spawn context, timeout bounds, stream-size bound, and the distinct
  behavior of user cancellation versus timeout or buffer overflow.

The native control completely recovered the hard-block fact. It substantially
described the other paths but omitted at least one frozen requirement from each:
phase-local dispatch gating, empty-input handling, path-resolution details,
the exact background log location, foreground defaults/stdin behavior, and the
16,000-byte final transcript bound.

Treatment's four incomplete facts identify the next selection gaps rather than
a wrong-system failure. It omitted phase-local precedence plus unknown/thrown
tool error conversion; the `insideRepo`/home-expansion details of containment;
the `ProcessManager.start()` log, buffer, and state transitions; and the exact
16,000-byte `truncate()` bound. Its answer explicitly disclosed the process
manager and truncation internals as unmaterialized. These are downstream helper
or effect-owner details reachable from already-correct anchors, so the result
supports expanding causal-target diversity rather than changing initial anchor
discovery for this task.

The deterministic matcher reported 0/7 for control and 1/7 for treatment. It
again undercounted valid paraphrases and is not the accuracy authority. Neither
answer made a frozen forbidden claim. Both detached worktrees and private cache
parents were removed, and no Git worktree registration remained.

For this pinned repository, question, fixture, model, and runner, scip-query
therefore improved strict fact recovery while approximately halving model-token
cost. This is a second independent task shape after configuration inheritance;
it does not establish arbitrary-task reliability.

Artifacts:

- `benchmarks/exploration/meta-harness-bash-lifecycle-heldout-v1.json`
- `/tmp/meta-harness-bash-lifecycle-control-sol-medium.json`
- `/tmp/meta-harness-bash-lifecycle-treatment-sol-medium.json`

## Meta-harness causal-frontier accuracy follow-up

The next implementation continued the evidence chain across `inspect`. It uses
SCIP call occurrences inside every exact requested source range—including a
requested construct withheld by the current character ceiling—to expose a
bounded downstream frontier. Selection preserves different caller roles and
reserves callees whose bodies write through reachable object identities. Local
scalar reassignment is not treated as a state-owning effect. One printed final
batch combines withheld requested constructs with the selected exact callees.

| Sol medium mode                     | Total tokens | Uncached input | Rendered characters | Semantic queries | Native reads | Manual strict facts |
| ----------------------------------- | -----------: | -------------: | ------------------: | ---------------: | -----------: | ------------------: |
| Frozen native control               |      356,261 |         62,103 |             158,809 |                0 |            7 |                 1/7 |
| Original scip-query treatment       |      183,115 |         30,558 |              45,327 |                4 |            0 |                 3/7 |
| Causal frontier plus final recovery |      198,169 |         34,581 |              54,947 |                4 |            0 |                 7/7 |

The final treatment used 44.4% fewer total tokens, 44.3% fewer uncached input
tokens, and 65.4% fewer rendered exploration characters than native control.
It recovered all seven strict facts while control recovered one. Relative to
the original treatment, full accuracy cost 8.2% more total tokens, 13.2% more
uncached input, and 21.2% more rendered evidence. No native tracked-source read
occurred, the private index took 2.1 seconds outside agent timing, and the
detached repository and cache were deleted after the run.

The decisive final recovery batch included the withheld classifier and global
dispatcher plus `ProcessManager.start()`, `insideRepo()`, `truncate()`, the
compaction owner, and auto-approval state. The answer then explicitly preserved
phase-local precedence and unknown/thrown conversion, home expansion and
relative-path containment, hard-block non-bypass, foreground bounds and abort
behavior, background log/buffer/state transitions, and reinsertion into model
history.

The deterministic matcher reported 2/7 despite those explicit statements. Its
false negatives are retained rather than repaired after seeing the answer;
they demonstrate the need for a semantic or independently adjudicated accuracy
layer. Strict manual adjudication remains the authority for this experiment.

Artifact:

- `/tmp/meta-harness-bash-lifecycle-treatment-causal-complete-sol-medium.json`

## OpenCode dual-compactor selection follow-up

The follow-up fixture names both compaction implementations and requires a
comparison, removing the scope ambiguity from the earlier OpenCode diagnostic.
Every arm used Sol medium, OpenCode commit
`1a8e94dc8e7462d3d0d860e1337b448c71947f6b`, and an independently prepared
detached worktree. The control used native reads without an index. Each
treatment used scip-query exclusively, and every disposable worktree and cache
was deleted by the runner.

| Frozen run                               | Total tokens | Uncached input | Rendered characters | Tracked calls | Strict facts |
| ---------------------------------------- | -----------: | -------------: | ------------------: | ------------: | -----------: |
| Native control                           |    1,112,372 |         99,879 |             490,269 |            16 |          1/7 |
| v15 exact-call frontier                  |      537,031 |         48,052 |              82,127 |             5 |          2/7 |
| v16 inspect-safe frontier                |      548,772 |         65,087 |              82,037 |             5 |          2/7 |
| v17 broad constraint reservation         |      575,041 |         68,717 |              95,710 |             5 |          1/7 |
| v18 repeated-unit filter attempt         |      546,195 |         52,466 |              94,884 |             5 |          1/7 |
| v19 direct-anchor constraint reservation |      545,943 |         64,563 |              82,057 |             5 |          1/7 |
| v20 anchor-first adaptive frontier       |      615,229 |         44,949 |              89,904 |             9 |          0/7 |
| v21 universal task-evidence contract     |      590,979 |         67,733 |              88,433 |             9 |          0/7 |

v15 remains the efficiency and accuracy high-water mark for this task. Against
control it used 51.7% fewer total tokens, 51.9% fewer uncached input tokens,
83.2% fewer rendered exploration characters, and 68.8% fewer tracked calls.
It completely established the HTTP ownership and summary-execution facts. Its
answer also contained substantial correct partial evidence for the other five
compound facts, but omitted one or more required owner names, predicates,
numeric limits, or terminal branches from each.

The v15 map printed a drill batch containing an oversized `createUserMessage`
construct that `inspect` correctly refused. The model recovered by issuing a
replacement batch, but paid for the failed query. v16 added an inspect-safety
contract: a target larger than the legal one-shot behavior limit remains in the
withheld manifest but cannot enter the printed batch. The printed command then
succeeded unchanged. This is a retained correctness improvement, although
model variance and the final audit query left v16 slightly more expensive than
v15 without improving strict accuracy.

v17 through v19 tested whether source-owned numeric limits and named constants
should reserve frontier slots. The underlying source-range check proved that
`settings()` and `preserveRecentBudget()` were compiler-resolved candidates.
In the full map, however, unrelated connector arithmetic and duplicate source-
construct/compiler-symbol identities competed for the same slots. Narrowing
the heuristic to direct anchor callees still did not improve the frozen score.
The constraint-ranking experiment and its attempted repeated-unit filter were
therefore removed rather than retained as benchmark-specific complexity.

This series establishes a boundary between the working and missing mechanisms.
The graph reliably finds both runtime paths and cuts repository text sharply;
the remaining failures come from information lost or weakly prioritized after
the path is found:

1. Multiline branch compression can show the effect call while omitting a
   qualifying predicate such as “completed, non-summary assistant.”
2. A selected function can reference an exact named constant without exposing
   that constant's compiler-resolved value, forcing another drill merely to
   recover `8_000` or the `2_000`–`8_000` clamp.
3. A wrapper that returns `filterCompacted(stream(...))` can send the final
   drill toward the input producer (`stream`) instead of the result-defining
   transformation (`filterCompacted`).
4. Compact connector labels can preserve the call path while dropping owning
   service names required to distinguish `SessionV2`, `SessionExecutionLocal`,
   and `SessionRunnerLLM`.

The next principled accuracy work should address those evidence contracts
directly: preserve complete branch predicates, project compiler-resolved
constant/value dependencies beside the selected behavior, rank calls whose
results define a returned transformation, and retain owner-qualified connector
identity. Another frontier vocabulary heuristic should not be benchmarked
until those slices have repository-independent tests.

v20 tested a structural alternative rather than another constant-name rule. It
reserved one continuation for every explicit anchor, expanded the automatic
frontier from six to eight targets for a six-anchor comparison, and spent a
second round across anchors before lexical reservations. The same build also
fixed the first evidence-contract gap above: behavior ownership now resolves to
the smallest nested callable, and a connector slice preserves the complete
parser-derived governing predicate. The live map consequently rendered the
OpenCode trigger as `lastFinished && lastFinished.summary !== true &&
isOverflow(...)` instead of showing only the last physical line of that
multiline condition.

The allocation experiment regressed the benchmark. It displaced the history,
runner, and context-filter targets used by v15 with broader input, tool, and
session helpers. The agent also tried `inspect` before completing the required
map twice while a private-index refresh was settling; the navigation session
correctly refused both calls, but their refusal packets and later replacement
queries increased the trace to nine tracked calls. The final answer was broadly
correct but omitted at least one decisive predicate, owner, numeric limit, or
terminal branch from every frozen compound fact, so both deterministic and
manual strict adjudication are 0/7. It still used 44.7% fewer total model tokens,
55.0% fewer uncached input tokens, and 81.7% fewer rendered exploration
characters than native control, but efficiency without fact parity does not
pass the product criterion.

The adaptive eight-target and anchor-first/second-round allocation were removed
after this result. The nested-callable and complete-governing-predicate fixes
remain because they repair a source-evidence invariant directly and pass a
repository-independent multiline-condition regression test. v15 remains the
comparison high-water mark for the next accuracy change.

v21 tested whether transporting the original question into the system map with
a universal agent-owned evidence ledger would prevent fact omissions. The ten
categories—scope, entry, guards, transformations, effects, boundaries, outputs,
failures, recovery, and variants—began unassessed, and the agent was told that
graph presence did not establish task relevance. The task text affected neither
anchor ranking nor graph traversal.

This did not solve evidence selection. The ledger named broad kinds of facts but
did not connect each requested comparison to the unexpanded graph region that
could establish it. The agent attempted one inspect before the required map,
retried the map while the prepared index was settling, and spent its final
drill-down on `filterCompacted` while still omitting exact trigger, retention,
summary, and resumption details. It recovered 0/7 strict facts and used 10.0%
more total tokens, 41.0% more uncached input, 7.7% more rendered characters, and
four more calls than v15. Against native control it still saved 46.9% of total
tokens and 82.0% of rendered characters, but accuracy was worse. The universal
ledger implementation was therefore reverted. The next structural experiment
must connect explicit question obligations to candidate graph regions and report
which obligations remain unresolved; merely repeating generic categories is not
actionable navigation evidence.

Artifacts:

- `benchmarks/exploration/opencode-compaction-implementations-v1.json`
- `/tmp/opencode-compaction-implementations-control-sol-medium.json`
- `/tmp/opencode-compaction-implementations-treatment-causal-sol-medium-v15.json`
- `/tmp/opencode-compaction-implementations-treatment-causal-sol-medium-v16.json`
- `/tmp/opencode-compaction-implementations-treatment-causal-sol-medium-v17.json`
- `/tmp/opencode-compaction-implementations-treatment-causal-sol-medium-v18.json`
- `/tmp/opencode-compaction-implementations-treatment-causal-sol-medium-v19.json`
- `/tmp/opencode-compaction-implementations-treatment-causal-sol-medium-v20.json`
- `/tmp/opencode-compaction-implementations-treatment-evidence-contract-sol-medium-v21.json`
