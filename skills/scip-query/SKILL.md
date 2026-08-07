---
name: scip-query
description: Use FIRST for codebase work when compiler-resolved identity, runtime boundaries, callers, dependencies, consumers, architecture, change impact, or cleanup relationships can affect the answer. It gives the agent a repository map; it does not own the task, plan, implementation, or acceptance decision.
---

# scip-query

scip-query is a repository exploration surface: an indexed code reader distinguished by joining exact current text to compiler-owned constructs, typed relationships, source-grounded runtime handoffs, compressed behavior, and recoverable omissions. It supplies the map and evidence; the agent still owns relevance, reasoning, edits, tests, and completion. Missing output never proves absence—coverage states what was emitted, folded, excluded, unresolved, or unsupported.

## Default end-to-end workflow

Privately name the few material facts the request requires. A material fact is a relevant predicate, authorization check, data transformation, hard bound, runtime crossing, durable state change, emitted notification, or returned value that can change the answer. For multi-step mutations preserve external-effect order plus compaction, rollback, or cleanup. For every event, log, or outbox write, preserve its operation kind and record-identity fields. For coordination state lock scope and which read/check/write steps it encloses; for interrupted updates state whether failure is prevented atomically, rolled back, or repaired later.

Use exactly one locator. Run `scip-query search <text>` only when the request quotes an exact source/runtime literal or supplies an exact compiler symbol; an unquoted domain term, feature name, or command name is not an exact selector. Otherwise run `scip-query anchors '<complete question>'`; it mechanically matches normalized repository words to compiler owners and bounded call neighborhoods without inferring English intent. For a cross-process or cross-protocol causal sequence, choose the first `cross-boundary-flow` whose displayed producer, runtime key, and downstream owner match the requested operation; it exists only when indexed runtime and call evidence bridge otherwise separate sets. Otherwise choose the smallest `connected-flow` set that covers the sequence. For an exhaustive "which operations/callers can" question, choose the smallest `shared-callee-owners` set that covers the candidate sibling owners. That set proves convergence on common callees, not that every callee is a state-changing effect. Run the chosen set's printed `scip-query system-map` command unchanged. The map's causal targets label upstream callers, downstream callees, result-producing callbacks, and runtime producers or consumers without claiming they are all relevant. If one corresponds to a named missing material fact, include its printed location in the one batched gap inspect after the map. Do not run `inspect`, `evidence`, `code`, or help before the map, do not graph every candidate set, and never pass the same loose term as both `--search` and `--symbol`.

The map's connected behavior is already source evidence. Before another query, make a private evidence ledger for every explicit anchor and every relevant sibling branch outcome; sibling branches are jointly required behavior, not alternative search results. If the map establishes the material facts, answer immediately. Optional causal recovery is folded by default. Only after naming one fact the map does not establish may you inspect the specific upstream caller, downstream callee, result callback, or runtime participant printed for that gap. Resolve category-changing gaps first—process versus cross-process, atomic versus later repair, durable versus merely written—before adding detail to behavior already established. Use its printed exact inspect target directly; use `--gap-callee` / `--gap-recovery-only` only when the target is additional or ambiguous and no exact target was printed. Run one batched `inspect --view behavior`. If inspect requires behavior focus, use interior file:line locations already visible in the map; do not use `--full`, and do not treat the refusal itself as missing task evidence. Do not override an exact-source materialization refusal unless omitted syntax itself can change the decision. The CLI resolves identity and causal direction; it does not infer relevance. Before sending, audit the draft itself: evidence seen but left implicit is not recovered, and citations must copy returned file/line identities exactly.

## Smallest sufficient command

- Exact unknown text or first named anchor: `scip-query search <text>`.
- Open-ended task without a trustworthy repository name: `scip-query anchors '<complete question>'`.
- Several already-known units: `scip-query inspect --symbol <symbol> --at <file:line> --view behavior`; repeat named flags and batch independent gaps.
- One symbol plus uses: `scip-query evidence <symbol> --include definition,references,callers,callees`.
- Complete source whose details can change the decision: `scip-query code <selector>`; this is the most expensive surface.
- One genuine external callable root: `scip-query entrypoints [text]`, then `scip-query entry-map <entry>`.
- Nonlocal change: `scip-query context <target>` before editing and `scip-query diff-impact` afterward.
- Declared architecture or requested React, Vue, duplication, complexity, or drift cleanup: `scip-query architecture` or `scip-query health --full`.

Run command help only when a named uncertainty requires an option not listed here.

## Evidence and coverage contract

- Exact compiler and runtime-boundary edges are facts only within reported coverage. Derived edges need their displayed source; candidates are leads.
- Read cardinality, omissions, frontiers, and completion. `selection-complete` covers the requested selection; `connector-complete` proves paths between requested anchors; `frontier-accounted` makes withheld directions recoverable. None means the user's task is finished.
- Broad search counts every exact match but withholds lower-ranked identities before traversal. Narrow by a relevant scope. Use `--full-literal-traversal` only when every exact match can change the decision.
- An absence claim requires complete coverage for that relationship. A claim about every callsite's arguments requires eligible `trace` or `evidence` callsite support.
- Reflection, generated names, unsupported adapters, and factory or data-mediated dispatch may remain unresolved. Add a distinctive literal, exact participant, or source range only when that disclosed gap matters.

## Spend tokens once

Treat returned behavior and source as already read. Do not reopen the same range, repeat instruction reads, rerun a successful human command as JSON, or enumerate helpers merely because they were surfaced. Batch independent named gaps. Use JSON only for a programmatic consumer. If output says `Continue exactly:`, run it unchanged until transport completes; do not choose a page size in advance.

For tracked text, keep scip-query as the exploration workflow, not a second workflow layered on top of grep. Native tools are for edits, checks, binary content, or one explicitly reported unsupported gap. After edits, run the checks appropriate to the change, then use `diff-impact` when consumers matter and `architecture` when declared boundaries are in scope.
