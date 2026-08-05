# Primary exploration surface

## Goal

Make scip-query the coding agent's first code-reading surface for indexed source.

The agent must see the smallest useful set of related source in one observation.
It must not repeat the same graph work with text search and full-file reads.

## Current faults

- `trace` finds compiler-resolved reference sites, but it prints no source at those sites.
- `context` reads the start of each definition. It does not center consumer source on the actual use.
- `context --full` expands analysis work, but it does not expand the source packet.
- The 12,000-character transport page causes avoidable continuation turns for normal evidence packets.
- The installed skill lists four commands. Agents open full help or use native search to find the missing routes.
- A short ambiguous symbol name silently selects one definition and reports alternatives after doing the work.
- No scip-query command searches literal source text across indexed documents.
- No one-call surface combines a definition with the source around its references.
- No automatic final check protects declared architecture rules.

## Product boundary

Source code is the behavior record. The SCIP index supplies compiler-resolved identity and relationships.

scip-query is the primary reading surface for indexed code. A native read is for an edit range or an explicit coverage gap.

The tool will provide declared evidence views. It will not expose arbitrary SQL or an unstable internal query language.

## Implementation slices

### 1. Source evidence

- Add source around each `trace` reference site.
- Keep the complete target definition when it fits the target budget.
- Center consumer excerpts on the reference line.
- Give target, consumer, and reuse source separate budgets in `context`.
- Increase the normal transport page to 32,000 characters.
- Report omitted lines and omitted sites as coverage facts.

### 2. Literal search

- Add `scip-query search <text>` for indexed source.
- Return file, line, nearby source, and the nearest owning symbol.
- Support a fixed-string default and an explicit safe regular expression mode.
- Support scope, context, and result limits.
- State when the limit omits matches.

### 3. Composed views

- Add `scip-query evidence <symbol>` as a one-call related-source view.
- Include the definition and reference-centered source by default.
- Add callers, callees, dependencies, and reverse dependencies on request.
- Deduplicate overlapping source windows.
- Reject ambiguous symbols with exact rerun targets.

This command is the supported custom query surface. Its options select evidence relationships.

### 4. Agent guidance

- Restore a small `scip-explore` skill as a question-to-command router.
- Restore a small `concrete-plan` skill for evidence-backed plans.
- Remove the old fixed exploration ritual and the old planning template ceremony.
- Require direct evidence for ownership, flow, consumers, reuse, retirement, and architecture claims.
- Install all three focused skills.

### 5. Architecture Stop hook

- Install only a Stop hook when the repository has architecture rules.
- Run the architecture check only after source changes.
- Refresh stale evidence before the check.
- Block a stop on architecture findings or a changed `.scipquery.json` policy.
- Do not run goals, health, tests, completion records, or a diff gate.
- Keep `.codex/hooks.json` and `.claude/settings.local.json` local and untracked.

## Required evidence

- One `trace` or `evidence` call shows a definition and its real use sites with source.
- One `search` call finds literal source text without native search.
- An ambiguous evidence target fails before it presents one candidate as the answer.
- A normal `context` packet needs no transport continuation for the benchmark target.
- The installed skills route common code questions without full CLI help.
- The Stop hook allows a clean architecture result and blocks a violation.
- The full repository test suite, type check, lint, configuration check, and architecture check pass.
- A fresh matched benchmark compares the new primary surface with the control.

## Implementation outcome

Implemented on 2026-08-02.

- `search` returns bounded literal or regular-expression matches with owning symbols and source context.
- `evidence` composes definition, reference, call-graph, dependency, and consumer source in one command.
- `trace` keeps its public API contract and now has a source-rich evidence form for agent output.
- `context` gives target, consumer, and reuse source separate budgets and centers consumer slices on real uses.
- Normal output pages allow 32,000 characters before transport continuation.
- `scip-explore` and `concrete-plan` are installed as small routing skills. Plans require direct repository evidence.
- Setup installs one local architecture-only Stop hook when declared architecture rules are ready.
- POSIX indexer lookup now converts package-runner-relative binary paths to absolute paths before indexing another worktree.

Verification:

- `search OWNED_COMMAND --context 1 --limit 3` returned the declaration and both uses with source.
- One exact `evidence` call returned the implementation, reference sites, callees, dependencies, and consumers without transport continuation.
- Ambiguous evidence targets refuse to select one candidate and provide exact rerun commands.
- The architecture policy mapped 414 of 414 indexed files and passed all 36 declared dependency rows.
- The architecture Stop hook returned `{}` for the clean current diff.
- Configuration validation passed.
- Lint, formatting, API compatibility, type declarations, and skill-link validation passed.
- The full suite passed: 264 files and 2,080 tests.

## First matched trial and correction

The first protected matched explanation trial found a real product failure,
not a broken sandbox or contaminated control. The control finished in about
13.5 minutes. The scip-query treatment reached the 15-minute cap without a
final answer.

The treatment used many small observations: 59 initial `search` calls, 29
`outline` calls, 8 `code` calls, and 7 `evidence` calls. Search returned broad
sets of short windows. A compiler range for an exported object also covered
only its declaration line, hiding a nested method. The agent then rebuilt the
missing context through repeated queries and native reads.

This evidence changed the composed-view design:

- `inspect` accepts repeated text, symbol, and file-line anchors in one call.
- It expands matching lines to readable syntax units and deduplicates units
  selected by several anchors.
- It bounds the whole packet by source units and total source lines.
- `code` and `context` recover a readable syntax unit when the compiler gives
  a one-line range.
- Standalone search returns fewer, deeper windows by default.
- Agent guidance tells the model to stop file-by-file inventory and batch its
  named gaps with `inspect`.
- Large-index notices no longer claim that every semantic-budgeted command
  scans 2,500 candidates; they distinguish a bounded analysis from the
  candidate cap that only some commands use.

A new matched trial is required after this correction. The detailed trial
artifacts remain in the private trial repository.

## Second matched trial

The corrected treatment completed the same hidden, read-only explanation task
in about 14.3 minutes. The control reached the hidden 15-minute limit without
a valid final answer. Both candidates started from identical source, ran in
parallel, and did not see the condition label, time limit, comparison, or score
facts. Treatment setup and indexing remained outside measured time.

The treatment used 70 shell-tool turns, compared with 291 for the unfinished
control. Its command output contained about 1.02 million characters, compared
with 1.64 million for the control. The completed treatment reported 340,096
uncached input tokens, 7,719,936 cached input tokens, and 26,960 output tokens.
The control did not emit final token usage before timeout, so this pair cannot
support a direct token-savings claim.

The treatment fully stated 11 of 15 hidden facts and partially stated the four
browser-tail facts. It also made one false extra claim by grouping invalid JSON
with missing or empty input. Under the strict trial rubric, partial facts earn
no point and that false material claim costs two points, producing 9/15. The
answer was strong through persistence and realtime publication, but it omitted
exact polling, retrieval, and rendering details.

The new surface changed exploration behavior in the intended direction, but
did not yet make it minimal. Fifty shell calls contained scip-query commands;
because many calls batched commands with `&&`, those calls launched 176 actual
queries: 86 `code`, 31 `search`, 29 `outline`, 15 `inspect`, 13 `evidence`,
and 2 `files` queries.
The agent also used native reads for final confirmation instead of relying on
already returned source. The result is favorable evidence that the primary
surface can reduce repository inventory and help an agent finish, not evidence
that its present command selection or token cost is optimal.

The next product question is narrower: make a composed packet the natural way
to close a named evidence gap, so the agent does not replace file-by-file native
inventory with symbol-by-symbol `code` and `outline` inventory. That should be
tested on a different fixture before another implementation change is credited
as a general improvement.

## Evidence-packet omission audit

The current commands still create avoidable follow-up work.

- `search` returns at most 12 matching lines with six context lines on each
  side. It identifies the owning symbol, but it does not return the whole
  readable source unit. The agent often follows it with `code`.
- Each `inspect --search` selector selects at most six matches. Search and
  location slices then share limits of 18 slices and 300 source lines. A source
  unit is limited to 80 lines. The command reports omitted matches, slices, and
  lines, but it does not give a result cursor for the omitted units.
- `evidence` includes only the definition and reference sites by default.
  Reference source has two context lines on each side. Callers, callees,
  dependencies, and consumers require explicit options. Dependencies and
  consumers contain file names, not source around the dependency edge.
- `inspect --symbol` uses four context lines for references and 60 source lines
  for each related symbol. Symbol evidence does not share the 300-line packet
  budget with search and location slices. It is also not deduplicated across
  selected symbols. Thus one packet can omit needed search units and still
  print a very large repeated symbol section.
- `context` limits its source packet to 24 slices and 600 lines. It limits the
  target to 200 lines, each consumer to 12 context lines, and each reuse
  candidate to 80 lines. It reports omissions but has no continuation for the
  remaining semantic units.
- `outline` returns structure without implementation source. `code` returns one
  definition without its relationships. `inspect --symbol` can batch several
  definitions, but the benchmark agent did not discover this as its normal
  replacement for repeated `outline` and `code` calls.

The fix is not to remove every limit. The tool must keep one bounded model
packet. The packet must select complete, decision-relevant source units. It
must deduplicate all sections under one budget. Every omitted semantic unit
must have a stable continuation or an exact follow-up selector. The normal
end-to-end packet must also include source around dependency and consumer edges,
not only their file names.

## Unified evidence packet implementation

Implemented on 2026-08-02 for the next matched trial.

- `inspect` now converts search matches, locations, definitions, reference
  windows, callers, callees, dependencies, and consumers into one ordered set
  of source units.
- One allocator enforces unit, source-line, and source-character limits across
  the entire packet. Overlapping source ranges merge their roles and selection
  reasons instead of printing the same source again.
- Symbol anchors include all six evidence relationships by default. The
  existing `--include` option remains as a narrowing control.
- Dependency and consumer relationships include source around the importing
  edge when the language parser can identify it. A path-only fallback carries
  an exact follow-up command.
- Omitted packet units return a self-contained `--packet-cursor`. The cursor is
  valid only for the index generation and source digest that produced it.
- Existing `SourceInspectionResult` fields remain available. The new packet
  fields and options are additive.

## Unified-packet matched trial

The fresh same-fixture regression run
`run-2026-08-02T18-53-34-957Z-3c052a` did not validate the change. Both Luna
5.6 Max candidates reached the hidden 900-second limit without a valid final
answer. The control made 185 tool calls. The treatment made 264 tool calls,
including 229 scip-query commands. Neither condition produced final token
usage, so this pair cannot support a token comparison or an accuracy score.

The treatment emitted less command output than the control (about 1.61 MB
versus 2.45 MB), but its exploration was not
smaller. Its 229 scip-query commands were 114 `search`, 92 `evidence`, 21
`inspect`, and 2 `outline` calls. The 21 inspect calls batched 101 selectors,
mostly 83 file-line locations. Fifty distinct evidence targets accounted for
92 evidence calls, so 42 calls repeated a previously queried target.

Three inspect responses emitted a semantic `--packet-cursor`; the candidate
followed none. Only one inspect batch supplied symbol anchors. The new packet
therefore bounded and deduplicated output correctly, but it did not become the
agent's stopping surface. Inventory moved from repeated `code` and `outline`
calls to repeated `search`, `evidence`, and `inspect --at` calls.

This run is a regression signal on the existing fixture, not the different-
fixture generalization test requested by the prior audit. The mechanism is
useful infrastructure, but the product hypothesis remains unproven. A next
change should target command selection itself—for example, promote the unique
owner symbols found by `inspect --search` into the same relationship packet—
instead of adding more output or another optional route.

## Unbounded semantic-packet experiment

The next matched trial deliberately removes inspect-owned truncation to test a
narrower causal hypothesis: whether the semantic packet cursor itself caused
the candidate to keep inventorying instead of treating `inspect` as a stopping
surface.

- `inspect` now returns every deduplicated candidate unit selected by its text,
  symbol, and location anchors. It applies no packet unit, line, or character
  budget and does not clip readable syntax units.
- Literal search anchors select every matching line by default. An explicit
  `--limit` remains available when the caller intentionally asks for less.
- Symbol-related source uses complete definition ranges. Evidence roles still
  merge when their source ranges overlap.
- Semantic packet cursors are not emitted or accepted. The deprecated public
  cursor shape remains only as an additive compatibility reservation while
  this uncommitted experiment is evaluated.
- The universal output transport remains unchanged. It can page rendered bytes
  without changing which semantic units belong to the command result.
- Legacy packet-budget options remain accepted as deprecated no-ops so callers
  can test this behavior without an avoidable command-line break.

## Unbounded-packet matched trial

The same-fixture matched run
`run-2026-08-02T19-26-35-908Z-6c83a7` rejected the unbounded packet as a
complete solution. The control produced a valid final answer in 867.7 seconds.
The treatment reached the 900-second limit without a valid final answer.

The unbounded treatment did substantially reduce inventory behavior relative
to both the matched control and the preceding bounded-packet treatment:

- 70 total tool calls versus 169 for the matched control;
- 21 harness-counted scip-query commands versus 229 in the preceding treatment;
- 11 logical `inspect` roots in the transcript, with 37 additional universal
  transport-page commands;
- no semantic packet cursor, as intended.

That reduction did not reduce the evidence volume enough to create synthesis
time. The treatment transcript was about 1.75 MB, larger than the control's
1.63 MB and the preceding bounded treatment's 1.61 MB. Five tool calls failed;
four were universal transport continuations that were copied with a changed or
malformed command identity. The treatment was still issuing a source search at
the deadline instead of composing its answer.

A strict manual rubric pass gives the valid control answer 13/15 factual points
with no material false-claim penalty. It fully covered the write, validation,
normalization, empty/repeat, persistence, realtime, recovery, and retrieval
paths. It only partially covered the missing-session-id branch in live refresh
and the renderer's exact stream/tool/command, fenced-code, and shell-text
classification rules.

The causal result is narrower than “large packets are bad.” Removing semantic
pagination made command selection dramatically less inventory-like, but moved
the cost into very large rendered packets and their byte continuations. A
viable stopping surface must compress or prioritize complete source units
enough that the agent can synthesize before the deadline; simply removing the
packet budget is not the right production behavior.

## Entry-rooted abstraction experiment

The next prototype tested a structural alternative to packet tuning. It added
two commands:

- `entrypoints [text]` distinguishes evidence-backed external roots from
  tentative uncalled callables on structural entry files; and
- `entry-map <entry>` computes the complete indexed static callee closure,
  collapses it into file regions, and accepts repeated `--expand` selectors so
  several regions can be drilled into in one view.

A direct repository smoke test validated the mechanism. Starting from
`decodeCliJsonEnvelope` produced 33 reachable symbols and 60 call edges
collapsed into five file regions, with zero unresolved calls. Expanding the
entry region and `claim-qualification` region together returned both symbol
graphs in the same response. The coverage contract explicitly excludes dynamic
dispatch.

The fresh matched Vega run
`run-2026-08-02T21-18-15-461Z-ef05d4` rejected the prototype as the solution to
the exploration benchmark. Both Luna 5.6 Max candidates reached the hidden
900-second limit without a valid final answer. The control made 204 tool calls;
the treatment made 137, including 111 harness-counted scip-query commands. The
treatment transcript was about 1.55 MB and its completed command output about
1.43 MB, both smaller than the control's 2.58 MB transcript and 2.38 MB command
output.

The treatment never invoked `entrypoints` or `entry-map`. Its logical command
mix was 69 `evidence`, 48 `search`, and 24 `inspect` invocations. Seven universal
transport continuations were issued; one failed after the continuation
identity was copied incorrectly. The agent found exact stream-event symbols,
then inventoried authentication, dispatch policy, persistence, realtime,
retrieval, and rendering one symbol group at a time.

The result separates mechanism from activation. An entry-rooted static call
map is a useful high-level view when one callable root already defines the
system. It is not a general system boundary for a feature joined by HTTP
dispatch, event names, shared contracts, database tables, realtime publication,
and UI consumption. The next design must compose several relationship kinds
around explicit anchors and expose their coverage gaps; adding more routing
language around a single call-graph root is not supported by this trial.

## Explicit-anchor system-map experiment

The next prototype replaces an inferred system boundary with a query-defined
one. `system-map` accepts repeated exact literals and symbols, follows indexed
call, reference, and import evidence to a bounded depth, and groups the result
into structural regions derived from indexed file paths. Its collapsed view
shows all observed regions, cross-region relationship kinds, representative
identities, and explicit coverage limits. Several regions can be expanded in
one command.

The matched Vega run `run-2026-08-02T22-49-46-227Z-88fda1` rejected the first
expanded representation. The control completed a valid answer in 820.6
seconds after 138 tool calls. The treatment reached the 900-second limit after
192 tool calls and did not produce a valid final answer. It issued 152
harness-counted scip-query commands. The control transcript was about 2.12 MB;
the treatment transcript was about 2.58 MB. Because the treatment timed out,
there is no valid final token-usage comparison.

Activation did succeed. The treatment read the exploration skills and selected
`system-map` first. Its collapsed map found the relevant API route and services,
database schema, shared contracts, realtime service, companion process, and web
consumers. It then expanded nine material regions simultaneously. The failure
occurred at the next abstraction level: expansion printed every mapped symbol
and every individual relation. The response required many universal transport
pages, and the candidate followed them until the full inventory was visible.
It then resumed broad source search and was still inspecting companion tests at
the deadline.

This isolates the product requirement more sharply. A high-level map is useful
only if each descent preserves completeness about what exists while compressing
the evidence needed to choose the next descent. Expansion now reports every
child file and complete mapped symbol, literal, and relation counts, but shows
only a small ranked set of source locations per file. The full machine-readable
arrays remain available in JSON. Guidance now asks for the smallest independent
anchors, warns against submitting one identifier through both selector
families, and directs the agent to inspect only exact child locations that
resolve a named behavioral uncertainty.

The frozen-fixture smoke test used the treatment's exact redundant seven-anchor,
nine-region expansion. After the correction, the complete human response is
31,801 characters and 304 lines at the default transport size, includes all 130
child-file rows (120 source, eight test, and two barrel files), reaches the
expanded section, and emits no continuation. The pre-correction form was 84,289 characters after an initial
compression pass; the benchmarked per-symbol/per-relation form had required
roughly eight 100,000-character transport pages. This validates the output-shape
correction, but not yet the end-to-end agent outcome; a fresh matched trial is
still required before claiming a benchmark improvement.

## Selection-bounded inspect experiment

The next matched Vega run, `run-2026-08-02T23-31-56-236Z-440850`, showed that
the compressed system map was no longer the dominant output problem. Both Luna
5.6 Max candidates reached the 900-second limit. The treatment used 151 tool
calls and about 1.64 MB of tool output, compared with 194 calls and about
1.91 MB for the control. One broad treatment `inspect` invocation accounted
for 22 calls and 526,695 source characters because its three text selectors
materialized the complete match set before transport pagination.

`inspect` now bounds evidence selection before source units are materialized.
The default packet ranks exact locations and definitions first, then production
search matches before barrels and tests; retains at most 12 matches per text
selector, 48 deduplicated units, and 60,000 source characters; and never clips
an individual source unit. Each selector reports exact matching-line and file
cardinality, selected and omitted unit counts, ranked scope hints, and an exact
`--full` expansion command. Packet coverage separately reports anything omitted
by unit or character ceilings. These are optional drilldowns when omitted
evidence can change the decision, not mandatory transport continuations.

Replaying the treatment's exact pathological selector batch against the frozen
Vega fixture returned 24 units covering 398 source lines and 14,885 source
characters in one semantic response. Exact location selectors remained
complete, no built candidate unit was omitted by the packet ceiling, and the
response exposed the withheld text-match coverage. This is about a 97.2%
reduction from the prior source volume. It validates selection behavior, not
the end-to-end agent outcome; the next matched trial must test whether the agent
uses the coverage manifest to stop or narrow instead of inventorying.

The fresh matched run `run-2026-08-03T00-24-35-415Z-f33fd8` validated the local
mechanism but not an end-to-end benchmark win. The control completed a valid
answer in 881.6 seconds after 155 tool calls. The treatment reached the
900-second limit without a final answer after 101 tool calls, including 38
harness-counted scip-query commands. Its transcript was about 1.24 MB and its
completed command output about 1.11 million characters, compared with about
3.16 MB and 2.96 million characters for the control: reductions of roughly 61%
and 62%, respectively.

The original broad-selector failure did not recur. The first treatment
`inspect` reported all eight matches for `work_session_stream_events` and
selected 12 of 118 matches for `agent-dispatch`, with the omitted 106 lines and
24 files represented by scope hints and an explicit full expansion. The full
transported response was 34,094 characters rather than the earlier 526,695
source characters. The candidate then used the compressed `system-map` and
batched exact-location inspection as intended, but continued inventorying every
behavioral layer, manually raised exact-packet character ceilings as high as
150,000, and spent the remaining time in tests, UI, and realtime details.

This result changes the named bottleneck. Selection bounding prevents an
accidentally broad text selector from consuming the run, and the abstraction
map supplies useful drilldown choices. Neither tells the agent when the facts
already establish a sufficient answer. The next experiment should therefore
test an explicit, answer-shaped evidence checklist derived from the question's
named behavioral facets, together with a rule against increasing packet
ceilings during ordinary exploration. That is a stopping contract, not another
attempt to infer a hidden system boundary.

An unbounded treatment-only follow-up,
`run-2026-08-03T00-55-45-012Z-977203`, showed what the 900-second cutoff had
hidden. The Luna 5.6 Max candidate completed a valid answer in 960.7 seconds,
only 60.7 seconds beyond the old limit. Compared with the immediately preceding
control on the same pinned source, prompt, model, and reasoning level, it took
9.0% longer but used 7,426,562 rather than 10,699,951 total model tokens
(-30.6%), 416,258 rather than 548,527 uncached model tokens (-24.1%), and 110
rather than 155 tool calls (-29.0%). Its transcript was 1.28 MB rather than
3.16 MB (-59.3%).

A manual audit against the fixed 15-fact rubric finds that both answers clearly
establish the same 13 core facts. Both omit the branch where a realtime event
without a session ID refreshes the selected timeline, and neither fully states
the renderer's fenced-code and shell-like classification behavior. The control
is closer on renderer detail and uniquely verifies that the outer CLI parser
does not currently register the batch helper; the treatment is more explicit
about repeated-batch persistence evidence. No clear false material claim was
found in either answer.

The scoped conclusion is that, for this fixture and these two stochastic runs,
selection-bounded scip-query preserved broadly comparable factual coverage
while reducing model-token consumption, at the cost of about 79 seconds of
additional exploration. The run also issued ten transport continuations and
failed three of them, including one visibly corrupted opaque cursor. Transport
cursors currently carry validation data that can instead live in stored
snapshot metadata; shortening the agent-visible value to a snapshot key plus a
page number is therefore an independent reliability improvement.

A transcript-level omission audit separated delivery from synthesis. The
treatment transcript literally contained the missing-session-ID refresh branch
and the fenced-code and shell-transcript renderer classifiers, so those answer
omissions were synthesis misses rather than unavailable CLI evidence. The
collapsed renderer line cap was not delivered: the run inspected the classifier
and its caller but did not drill into `CodeBlock`. That is a remaining evidence
selection gap.

The transport cursor now contains only a 12-character, 72-bit snapshot key for
the first continuation; later pages append a base-36 page suffix. The emitted
command is `scip-query continue <cursor>`, which restores the original command,
arguments, page size, and validation hashes from immutable snapshot metadata
without rerunning the producer. Readers still accept the previous version-3
cursor until its one-hour snapshot lifetime has elapsed.

The cursor was exercised successfully in the next live Luna 5.6 Max treatment:
the candidate resumed `scip-query continue 2VSt-toYr-V3` and later compact
continuations without repeating the original invocation. While preparing that
trial, a real `inspect --full` incompatibility was also corrected: the command
had been injecting its default search limit even in full-coverage mode, causing
the query layer to reject `--full` as though the user had combined it with an
explicit bound. Full coverage now suppresses only the implicit limit while an
explicit `--full --limit ...` combination remains an error.

## Outgoing-webhook cross-system benchmark

The no-time-limit matched Vega run
`run-2026-08-03T01-52-52-308Z-b81d61` tested a different topology: the
`issue.created` outgoing-webhook path spanning post-transaction publication,
database queueing, distributed scheduler coordination, leased claims, SSRF
defenses, signed HTTP delivery, retry persistence, API management, and web
history. Both candidates used Luna 5.6 Max against commit
`2bbb90b685fa529090659baaa15af11a5fcfa7be` and produced valid final answers.

This pair reverses the previous token result. The control completed in 724.7
seconds using 6,914,479 total model tokens, 302,511 uncached model tokens, and
121 tool calls, nine of which failed. The treatment completed in 837.8 seconds
using 8,877,386 total model tokens, 308,042 uncached model tokens, and 62 tool
calls, two of which failed. Relative to control, treatment took 15.6% longer,
used 28.4% more total tokens and 1.8% more uncached tokens, but made 48.8% fewer
tool calls. It issued 48 scip-query commands and consumed ten compact transport
continuations.

A strict manual audit against the frozen 15-fact rubric gives control 10 fully
covered facts and treatment nine before penalties. Each answer makes one false
material claim, yielding rubric scores of 8 and 7 after the specified two-point
penalty. Control incorrectly says a response-body read error becomes a delivery
failure; the implementation catches that read error and degrades the body to an
empty preview without changing the HTTP result. Treatment incorrectly says it
found no current caller passing `IssueCreateService.create` an outer
transaction; the proposal backlog importer passes its transaction for story and
task creation. Treatment also omits the fact that allowed custom headers are
spread after generated delivery headers and can override them. Both answers
incompletely cover scheduler fallback and TTL calculation, mutation audit
behavior, exact response truncation behavior, and the one-shot newest-first
delivery-history view.

The result rules out a general token-efficiency claim from the earlier win. On
this task the map-first treatment reduced command count and failures but read
enough paginated material to increase cached-token churn without improving
answer accuracy. The next optimization target remains selection before
transport: compose an answer-shaped evidence packet that includes high-risk
edge clauses while withholding low-value inventory, and make omitted coverage
visible enough to expand selectively rather than encouraging universal paging.

## Behavior-view and omission-ledger treatment

The treatment-only no-time-limit run
`run-2026-08-03T03-29-10-173Z-835f58` tested syntax-derived behavior
skeletons, marginal structural-coverage selection, grouped recoverable
omissions, compact transport cursors, and an explicit negative-claim coverage
rule against the same frozen Vega commit, prompt, rubric, Luna 5.6 Max model,
and max reasoning level as the preceding control.

The candidate completed a valid answer in 945.5 seconds. Relative to the fixed
control, it used 277,006 uncached model tokens instead of 302,511, an 8.4%
reduction, and consumed 616,016 command-output characters instead of
1,103,041, a 44.2% reduction. It made 116 tool calls instead of 121 and one
failed call instead of nine. It used only two transport continuations, both
with compact 12-character cursors.

Those local savings did not become total-token savings. The treatment used
9,852,686 total model tokens, 42.5% more than control, and took 30.5% longer.
It issued 95 scip-query commands, including five behavior-view inspect calls
and 28 source-view inspect calls. The agent repeatedly reprocessed its growing
cached context across nearly as many turns as control; selection reduced new
tool material but did not yet provide a stopping surface.

A strict audit gives the answer eight fully covered rubric facts before
penalties. It newly captured the custom-header override clause, but still
omitted complete scheduler fallback/error behavior, exception recovery,
registry audit/secret details, exact response truncation behavior, complete
terminal aggregate behavior, and the UI's one-shot/no-refresh observation
contract. It also repeated the false claim that no current caller passes
`IssueCreateService.create` an outer transaction. The candidate's own bounded
evidence listed the proposal backlog importer callsites but showed too little
of each call to expose the fourth `tx` argument; the agent did not expand that
negative claim to complete call units. Under the fixed two-point false-claim
penalty, the strict score is 6, versus 8 for control and 7 for the preceding
treatment.

The mechanism therefore establishes a narrower result: behavior-first
selection and omission grouping can substantially reduce fresh evidence and
transport noise without globally truncating source, but persistent total-token
savings also require fewer model turns and a stronger completeness gate for
negative claims. The next discriminating changes are to batch exact drilldown
directly from map anchors, expose full call expressions for caller arguments,
and mechanically prevent a bounded caller set from being rendered as an
absence claim.
