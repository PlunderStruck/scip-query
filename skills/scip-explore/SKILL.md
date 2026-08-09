---
name: scip-explore
description: Explore an indexed codebase before explaining or changing it. Use for end-to-end behavior, callers, data flow, dependencies, consumers, impact, reuse, architecture, or related source across files. Use scip-query as the repository exploration surface and native tools only for edits, checks, binary content, or an explicit unsupported gap.
---

# SCIP Explore

An exploration is a code-reading investigation that builds a source-supported causal account of the behavior the user asked about. It connects the initiating input, the code that owns it, the decisions that alter it, the state and effects it produces, and the consumers that observe those effects. The goal is an accurate answer at the resolution the request requires; a short or inexpensive exploration that leaves a known material gap is incomplete.

`$scip-query` supplies exact text, compiler-owned constructs, typed relationships, compressed behavior, and recoverable coverage. It does not decide what matters or when the user's question is answered. This skill owns that judgment.

## Establish what the answer must prove

Before querying, reduce the request to a small private evidence ledger. Each row is a material claim: a concrete fact whose condition, outcome, or qualifier could change the answer. Mark every row `unresolved`, then change it only to:

- `established`, with exact source or graph evidence;
- `unsupported`, with the specific index or adapter limitation; or
- `excluded`, with the reason it cannot change the requested answer.

For an end-to-end explanation, ask which of these are material to the requested system: what initiates it; who owns and receives it; which predicates, authorization checks, bounds, or sibling branches change its behavior; how data is reshaped; which runtime boundaries it crosses; which durable state or external effects change and in what order; what result or notification is observed; and what retry, rollback, cleanup, or later repair follows failure. These are completeness questions, not assumptions that every code path contains every stage. For a comparison, keep separate rows for both paths and for every behavior that distinguishes them.

Accuracy determines when to stop. Query count, elapsed time, and token cost determine how to gather evidence efficiently; they never make a known recoverable material claim optional.

## Explore from exact evidence

1. Choose the cheapest locator that can produce a concrete referent. Use exact `search` for trustworthy text or a runtime key, `outline` for a known file, and `entrypoints` for an external callable. A locator presents exact candidates; it does not rank their relevance to the task. Do not locate every ledger row independently: one returned symbol or file/line is already usable as a graph root.
2. Turn returned symbols, source identities, file/line locations, entry points, or runtime keys into graph roots. For an end-to-end question, make sure the selected roots or requested incoming direction can expose the initiating owner as well as the core transform; do not assume a core type is the ingress. When the question already supplies several exact literals or independent participants, pass repeated `--search`, `--symbol`, or `--at` selectors directly to one `scip-query evidence` command instead of alternating overlapping locators and reads. State repeated edge families, direction, depth, and edge bound explicitly according to the unresolved ledger rows. Never request all families merely to discover what exists. Normal evidence already reports cardinality; use inventory-only only when counts determine whether a predictably large projection should be materialized, and connecting paths only between roots you deliberately selected. The skill command table is the ordinary operating manual; do not run `capabilities` or command help merely to orient yourself.
3. After every packet, update the ledger. Preserve conditions, outcomes, exact bounds and defaults, invocation arguments, ownership and lifetime, state-transition order, loop-stopping conditions, and relevant sibling branches. A plausible narrative is not completion, and packet completion is not task completion.
4. Follow a printed exact identity or recovery frontier when it can close a named row. Batch independent gaps. Use `scip-query inspect --view behavior` when graph relationships do not establish implementation behavior and `scip-query code` only when exact syntax can change the answer. Treat already returned behavior as read evidence and never pay for it twice.
5. Before answering, audit the draft against the ledger itself. Evidence omitted from the answer is not recovered. Do not report a coverage limitation while an exact, relevant, in-scope recovery query remains available. Do not inspect tests, documentation, or examples after current implementation source has established the fact unless a named ambiguity specifically requires corroboration.

Follow compiler-resolved relationships before folder names or text similarity. Calls and exact runtime handoffs establish executable reachability; data, state, temporal, contract, identity, ownership, and dependency edges establish only the relationship they name. Treat candidate links as leads requiring their displayed source. A fold is a recoverable representation of eligible facts that did not fit the output budget, not a judgment that they are irrelevant. Missing or bounded output is unknown, not evidence of absence.

Use scip-query for tracked nonbinary repository text and source. Native tools are for edits, checks, binary content, or one explicitly reported unsupported gap. If transport says `Continue exactly:`, complete it unchanged. Stop as soon as every material claim is established, explicitly unsupported, or justified as excluded; do not continue merely to collect context.
