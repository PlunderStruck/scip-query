---
name: scip-query
description: Use FIRST for codebase work when compiler-resolved identity, runtime boundaries, callers, dependencies, consumers, architecture, change impact, or cleanup relationships can affect the answer. It gives the agent a repository map; it does not own the task, plan, implementation, or acceptance decision.
---

# scip-query

scip-query is an indexed repository map: a code-reading view that connects compiler-resolved definitions, references, calls, imports, and exports with source-grounded runtime-boundary observations while preserving exact source identities and provenance. Use the map to see all observed parts of a relevant system, compare several components through the cheapest faithful behavioral view, then read exact implementations only where a decision depends on them. Missing output is not proof that a relationship does not exist; coverage says what was observed, bounded, filtered, unresolved, or unsupported.

## Choose the smallest sufficient surface

- Unknown literal, route, event, key, or first anchor: `scip-query search <text>`. Start with the most distinctive literal you have. A broad selector returns exact total cardinality, a bounded representative identity manifest, and ranked scope commands; narrow by one relevant scope instead of enumerating every match.
- Several known text, symbol, or `file:line` anchors: one `scip-query inspect ... --view behavior` with repeated selectors. This is the default multi-unit triage surface: compact units use raw source, larger units use a complete normalized outline only when it is cheaper, and unsupported statements remain verbatim.
- One exact symbol and its uses: `scip-query evidence <symbol> --include definition,references,callers,callees`.
- One exact unit already named whose complete implementation can change the decision: `scip-query code <selector>`. Batch only independently necessary exact units; symbol selectors return complete definition source, while line ranges return the requested lines plus statically attributed same-file callable definitions and explicit coverage. `code` is the most expensive exploration surface per selector.
- Cross-layer behavior without one trustworthy root: `scip-query system-map --search <literal> --symbol <symbol>`.
- Behavior with one real external root: `scip-query entrypoints [text]`, then `scip-query entry-map <entry>`.
- Nonlocal change impact and reuse: `scip-query context <target>` before editing; `scip-query diff-impact` afterward.
- Declared boundaries or repository-wide React, Vue, duplication, complexity, or drift cleanup: `scip-query architecture` or `scip-query health --full` only when that concern is in scope.

Run `scip-query <command> --help` only when a named uncertainty requires an option not shown here.

## Explore by abstraction level

For an end-to-end question, give `system-map` the smallest independent anchors—normally one distinctive protocol literal and one callable or contract symbol. Do not submit the same identifier as both merely to widen output. The collapsed map is the high-level view: it shows observed regions, compiler and exact built-in runtime-boundary relationships, anchor status, unresolved boundary frontiers, and traversal coverage. Run its exact `Expand together:` command to see child files and ranked drill locations for several regions at once; add withheld or match-only regions only when they can change the answer. Then run its emitted batched behavior command for the remaining named uncertainty. Escalate afterward with `code` only for an exact unit whose complete implementation can change the decision. Do not search every symbol printed by the map.

Use `entry-map` only when one detected callable genuinely defines the boundary. A `candidate` entry is a structural hypothesis, not established runtime dispatch. Unsupported adapters and candidate protocol, persistence, queue, or realtime observations may require several explicit anchors instead of one call root.

## Preserve evidence and coverage

- Compiler-graph and exact runtime-boundary relationships are facts only within their reported coverage. Candidate links and heuristic findings require source confirmation and do not drive default traversal.
- Read selector cardinality, omissions, packet coverage, and the stopping check. `stop-ready` means stop unless a named semantic blind spot can change the decision.
- `search` always counts every exact match. A small result lists every identity; a broad result withholds lower-ranked identities before output transport and reports exact coverage plus ranked scope commands. There is no transport cursor to drain. Select a distinctive literal or one relevant scope; use `--full` only after deliberately narrowing when source around every remaining match can change the decision.
- `inspect` omits whole lower-ranked units. Drill into several relevant omission groups together. Use `--full` only when every omitted unit can change the decision; never combine `--full` with `--limit`.
- `code` accepts up to 24 exact selectors. File selectors return the exported or top-level surface plus a complete omitted-local ledger. Use `--members all` only when the whole file matters. A refusal means the requested source packet is too broad for one page and emitted no partial source; narrow to the exact units still needed before deciding whether every split remains necessary.
- Ambiguity requires the exact candidate commands; never silently choose the first match.
- An absence claim such as “no caller” or “only tests” requires complete coverage for that relationship. Otherwise state the limit or add one focused query.
- A claim about every callsite's arguments requires eligible callsite-argument support from `trace` or `evidence`; a nearby bounded window is not enough.
- Dynamic dispatch, reflection, dependency injection, generated names, and data-mediated producer/consumer links may remain outside the static graph. Use an explicit anchor or a named native-source fallback when one matters.

## Spend tokens once

Treat returned source as already read. Its line numbers are absolute and citation-ready. Do not reopen the same range with `sed`, `nl`, `rg`, or another scip-query command. Do not repeat successful repository-instruction or standards reads. Batch independent gaps into one command and reuse unchanged evidence after context compaction. If output says `Continue exactly:`, run that command unchanged; it transports already selected bytes and does not expand semantic coverage. Do not choose a page size pre-emptively.

Do not rerun a successful human command as JSON. Human search output already carries exact cardinality, owner identities, coverage, and recovery commands; JSON is only for code that will parse the result. Before each drilldown, name the still-unanswered fact and stop when no such fact remains. Tool-call count matters because every additional reasoning step pays again for the context already accumulated.

Use native search or source reads only for exact edit lines, unindexed files, unsupported file types, or an explicit gap scip-query reports. Name the gap first. The map replaces redundant exploration; it must not become a second workflow.

For a change, write the normal concise plan, edit, run native checks, then use `diff-impact` when downstream consumers matter and `architecture` when declared boundaries are in scope. A nonzero architecture result is unfinished policy failure. The agent—not scip-query—owns the goal, implementation, tests, and completion judgment.
