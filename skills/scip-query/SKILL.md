---
name: scip-query
description: Use FIRST for codebase work when compiler-resolved identity, runtime boundaries, callers, dependencies, consumers, architecture, change impact, or cleanup relationships can affect the answer. It gives the agent a repository map; it does not own the task, plan, implementation, or acceptance decision.
---

# scip-query

scip-query is the repository exploration sensor: an indexed code-reading surface that joins exact current text, compiler-resolved identities and relationships, source-grounded runtime handoffs, compressed behavior, and lossless source retrieval. Its essential advantage over text search alone is that it makes the direction and evidential strength of exploration explicit while accounting for what it did not return. Missing output is not proof that a relationship does not exist; coverage says what was observed, bounded, filtered, unresolved, or unsupported.

## Choose the smallest sufficient surface

- Unknown literal, route, event, key, or first anchor: `scip-query search <text>`. Start with the most distinctive literal you have. A broad selector returns exact total cardinality, a bounded representative identity manifest, and ranked scope commands; narrow by one relevant scope instead of enumerating every match.
- Several known text, symbol, or `file:line` units after orientation: one `scip-query inspect --symbol <symbol> --symbol <symbol> --at <file:line> --view behavior`. Repeat the named flags; positional selectors are not accepted. This is the default multi-unit detail surface, but it does not replace `system-map` for an end-to-end question.
- One exact symbol and its uses: `scip-query evidence <symbol> --include definition,references,callers,callees`.
- One exact unit already named whose complete implementation can change the decision: `scip-query code <selector>`. Batch only independently necessary exact units; symbol selectors return complete definition source, while line ranges return the requested lines plus statically attributed same-file callable definitions and explicit coverage. `code` is the most expensive exploration surface per selector.
- Cross-layer behavior without one trustworthy root: `scip-query system-map --search <literal> --symbol <symbol>`.
- Behavior with one real external root: `scip-query entrypoints [text]`, then `scip-query entry-map <entry>`.
- Nonlocal change impact and reuse: `scip-query context <target>` before editing; `scip-query diff-impact` afterward.
- Declared boundaries or repository-wide React, Vue, duplication, complexity, or drift cleanup: `scip-query architecture` or `scip-query health --full` only when that concern is in scope.

Run `scip-query <command> --help` only when a named uncertainty requires an option not shown here.

## Explore by abstraction level

Use one ladder rather than a collection of unrelated commands:

1. **Locate** a distinctive literal or name in exact indexed text.
2. **Orient** the result by exact compiler identity, construct kind, owner, and ambiguity.
3. **Navigate** typed relationships between the smallest independent anchors.
4. **Account** for every omitted direction as emitted, recoverably folded, excluded by a stated rule, or unsupported.
5. **Explain** the selected path through connected behavior whose transitions retain their evidence.
6. **Prove** only the remaining decisive details with exact current source.

For an end-to-end question, privately reduce the question to the few material claims the answer must establish. Run at most one locating search unless it fails to identify independent owners, then make `system-map` the first graph/detail operation with the smallest independent exact anchors that already refer to the questioned flow. Copy a printed compiler identity exactly when using `--symbol`; a source-owned search identity remains a `--search` selector. Never pass the same loose term to both `--search` and `--symbol`. Trailing callable punctuation on a compiler identity is optional. Do not run `inspect`, `evidence`, or `code` before that map. Do not force both selector families. A distinctive runtime address, event, or key plus an exact callable is useful when each identifies a different referent; a generic architectural term is not a useful literal anchor. A broad literal is counted exactly but withheld before graph traversal, with representative identities and ranked scoped searches. Use `--full-literal-traversal` only when every exact match can change the decision.

Treat the map's connected behavior as source evidence, not as a list of suggestions to reopen. Compare its lines and transitions with the material claims. In an end-to-end explanation, a material fact is any behavior-changing predicate, authorization check, data reshaping, hard bound, runtime crossing, durable state change, emitted notification, or returned value on the selected causal path; preserve each relevant one in the final answer instead of summarizing it away. If each claim is directly established, answer immediately—even if the map reports unrelated folded nodes, frontiers, or recovery commands. If one claim is not established, name that exact missing claim and issue one batched `inspect` or exact-source query capable of resolving it. Do not investigate implementation families, enumerate helpers, inspect examples, or verify facts the user did not ask for. The normal end-to-end allowance is one locating query, one map, and at most one batched gap query; exceed it only when the latest evidence explicitly leaves another material claim unresolved.

Before sending the answer, audit the draft itself against the privately named material claims. Evidence that was seen but left implicit in the draft is not recovered. Copy returned file and line identities exactly instead of reconstructing citation paths.

Use `entry-map` only when one detected callable genuinely defines the boundary. A `candidate` entry is a structural hypothesis, not established runtime dispatch. Unsupported adapters and candidate protocol, persistence, queue, or realtime observations may require several explicit anchors instead of one call root.

## Preserve evidence and coverage

- Compiler-graph and exact runtime-boundary relationships are facts only within their reported coverage. Candidate links remain visibly weaker leads; when a connected packet uses one to preserve a possible causal path, confirm the displayed source before making a factual claim.
- Read selector cardinality, omissions, per-channel packet coverage, and query completion. `selection-complete` means the current selection was fully materialized; `connector-complete` means the requested anchors have proved paths; `frontier-accounted` means known withheld directions have exact recovery; `coverage-incomplete` names unresolved evidence. None says the user's task is finished.
- `search` always counts every exact match. A small result lists every identity; a broad result withholds lower-ranked identities before output transport and reports exact coverage plus ranked scope commands. There is no transport cursor to drain. Select a distinctive literal or one relevant scope; use `--full` only after deliberately narrowing when source around every remaining match can change the decision.
- `inspect` omits whole lower-ranked units. Drill into several relevant omission groups together. Use `--full` only when every omitted unit can change the decision; never combine `--full` with `--limit`.
- `code` accepts up to 24 exact selectors. File selectors return the exported or top-level surface plus a complete omitted-local ledger. Use `--members all` only when the whole file matters. A refusal means the requested source packet is too broad for one page and emitted no partial source; narrow to the exact units still needed before deciding whether every split remains necessary.
- Ambiguity requires the exact candidate commands; never silently choose the first match.
- An absence claim such as “no caller” or “only tests” requires complete coverage for that relationship. Otherwise state the limit or add one focused query.
- A claim about every callsite's arguments requires eligible callsite-argument support from `trace` or `evidence`; a nearby bounded window is not enough.
- Constructor-assigned member receivers and supported runtime adapters can cross some dispatch and dependency boundaries. Reflection, generated names, factory-produced or nested dependency injection, and unsupported data-mediated producer/consumer links may remain outside the graph. Add a distinctive literal, exact source range, or known participant as another anchor when one matters; keep unsupported coverage explicit.

## Spend tokens once

Treat returned source as already read. Its line numbers are absolute and citation-ready. Do not reopen the same range with `sed`, `nl`, `rg`, or another scip-query command. Do not repeat successful repository-instruction or standards reads. Batch independent gaps into one command and reuse unchanged evidence after context compaction. If an explicit `SCIP_QUERY_SESSION` replaces content with a receipt, trust it only while the cited evidence remains in context; use `--reemit` to recover lost evidence. If output says `Continue exactly:`, run that command unchanged; it transports already selected bytes and does not expand semantic coverage. Do not choose a page size pre-emptively.

Do not rerun a successful human command as JSON. Human search output already carries exact cardinality, owner identities, coverage, and recovery commands; JSON is only for code that will parse the result. Before each drilldown, name the still-unanswered fact and stop when no such fact remains. Tool-call count matters because every additional reasoning step pays again for the context already accumulated.

For tracked nonbinary repository content, use `search`, `inspect`, and `code` instead of native search or source reads. Use native tools to apply edits, run checks, inspect binary content, or handle a specific unsupported gap that scip-query explicitly reports. Name that gap first. The map is the exploration workflow, not a second workflow layered on top of grep.

For a change, write the normal concise plan, edit, run native checks, then use `diff-impact` when downstream consumers matter and `architecture` when declared boundaries are in scope. A nonzero architecture result is unfinished policy failure. The agent—not scip-query—owns the goal, implementation, tests, and completion judgment.
