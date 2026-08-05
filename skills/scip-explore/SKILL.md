---
name: scip-explore
description: Explore an indexed codebase before explaining or changing it. Use for end-to-end behavior, callers, data flow, dependencies, consumers, impact, reuse, architecture, or related source across files. Use scip-query as the primary code-reading surface and native reads only for an edit range or an explicit evidence gap.
---

# SCIP Explore

An exploration is a code-reading investigation that connects the externally meaningful input, the code that owns it, the state and effects it produces, and the consumers that observe those effects. Its essential value is a complete-enough structural map with exact source evidence, not an inventory of files.

Apply the command and coverage rules in `$scip-query`; do not duplicate that manual here or re-read it if already loaded.

## End-to-end workflow

1. Start with the question and the behaviors that must be accounted for: entry, validation, authorization, transformation, persistence, publication, retrieval or recovery, and presentation when relevant.
2. Start with one `system-map` using the smallest independent literal and symbol anchors. If one verified external callable is the true boundary, use `entrypoints` once and then `entry-map` instead.
3. Read all observed regions, cross-region relations, frontier counts, and blind spots before drilling down. Run `Expand together:` once for the ranked regions; add several withheld regions only when they can change the explanation.
4. Name the remaining behavioral questions and resolve them with one batched behavior `scip-query inspect` over the ranked locations. Use `scip-query evidence` for a single exact symbol whose callers, callees, or consumers remain decisive. Escalate to `scip-query code` only for an exact unit whose complete implementation can change the decision.
5. Stop when every material behavior has source support or an explicit coverage limitation. Do not search each displayed name, reread returned ranges, inventory folders, or repeat successful repository standards reads.

Follow compiler-resolved relationships before folder names or text similarity. Treat compiler edges and exact built-in runtime-boundary links as facts within their stated coverage; candidate links are leads and never drive default traversal. Whole-token production matches can seed traversal; embedded, test, fixture, mock, preview, demo, and example matches may remain visible without expanding their graphs. Unsupported adapters, unresolved expressions, dynamic dispatch, reflection, generated names, and dependency injection remain explicit frontiers and can require a second anchor.

Use native reads only for exact edit lines, unindexed source, or a named gap the map cannot answer. Never infer absence from a bounded packet. If transport says `Continue exactly:`, complete it unchanged; if a semantic omission matters, expand only the relevant groups together.

Finish with the entry-to-effect path, material state transitions and consumers, security or trust boundaries, recovery behavior, and the main unresolved limitation. Cite exact files, symbols, and line numbers already returned by scip-query.
