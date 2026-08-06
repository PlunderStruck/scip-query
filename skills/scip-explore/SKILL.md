---
name: scip-explore
description: Explore an indexed codebase before explaining or changing it. Use for end-to-end behavior, callers, data flow, dependencies, consumers, impact, reuse, architecture, or related source across files. Use scip-query as the repository exploration surface and native tools only for edits, checks, binary content, or an explicit unsupported gap.
---

# SCIP Explore

An exploration is a code-reading investigation that connects the externally meaningful input, the code that owns it, the state and effects it produces, and the consumers that observe those effects. Its essential value is a complete-enough structural map with exact source evidence, not an inventory of files.

Apply the command and coverage rules in `$scip-query`; do not duplicate that manual here or re-read it if already loaded.

## End-to-end workflow

1. Start with the question: reduce it to the few material claims it actually asks you to establish. Do not automatically add every possible stage such as authorization, persistence, recovery, or presentation when the question does not require it.
2. Use at most one locating search to identify the smallest independent exact anchors, then make `system-map` the first graph/detail operation. A source-owned search identity remains `--search`; use `--symbol` only for a printed compiler identity, and never pass the same loose term to both selectors. Do not run `inspect`, `evidence`, or `code` before the map. Do not force both literal and symbol selectors; omit generic text, and narrow any broad literal through its representative identities or scoped recovery commands. If one verified external callable is the true boundary, use `entrypoints` once and then `entry-map` instead.
3. Read the anchor status, connector graph, connected behavior, accounted frontiers, and query completion together. The connected behavior is already source evidence. For an end-to-end explanation, preserve every relevant behavior-changing predicate, authorization check, data reshaping, hard bound, runtime crossing, durable state change, emitted notification, and returned value on the selected causal path. If those lines and transitions establish every material claim, stop immediately rather than reopening its constructs or following unrelated recovery commands.
4. Name the one remaining behavioral claim, if any. Resolve all evidence for that named gap in one behavioral `scip-query inspect` with repeated `--symbol` or `--at` flags. Use `scip-query evidence` instead when one exact symbol's callers, callees, or consumers are the gap. Escalate to `code` only when the complete implementation of an exact unit can change the answer.
5. Audit the draft itself against the material claims, then stop when every material behavior has source support or an explicit coverage limitation. Evidence seen but left implicit in the draft is not recovered. Copy returned file and line identities exactly. Do not search each displayed name, reread returned ranges, inventory folders, or repeat successful repository standards reads.

Follow compiler-resolved relationships before folder names or text similarity. Treat compiler edges and exact built-in runtime-boundary links as facts within their stated coverage. Candidate links remain visibly weaker leads; when a connected packet uses one to preserve a possible path, confirm its displayed source before claiming the relationship. Whole-token production matches can seed traversal; embedded, test, fixture, mock, preview, demo, and example matches may remain visible without expanding their graphs. Unsupported adapters, unresolved expressions, dynamic dispatch, reflection, generated names, and dependency wiring not recoverable from compiler occurrences or constructor assignments remain explicit frontiers and can require a second anchor.

Use scip-query for tracked nonbinary repository text and source. Native tools are for applying edits, running checks, binary content, or a named unsupported gap the map cannot answer. Never infer absence from a bounded packet. If transport says `Continue exactly:`, complete it unchanged; if a semantic omission matters, expand only the relevant groups together.

Finish with the entry-to-effect path, material state transitions and consumers, security or trust boundaries, recovery behavior, and the main unresolved limitation. Cite exact files, symbols, and line numbers already returned by scip-query.
