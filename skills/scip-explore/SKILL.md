---
name: scip-explore
description: Explore an indexed codebase before explaining or changing it. Use for end-to-end behavior, callers, data flow, dependencies, consumers, impact, reuse, architecture, or related source across files. Use scip-query as the primary code-reading surface and use native reads only for an edit range or an explicit evidence gap.
---

# SCIP Explore

Build a verified map of the code that answers the current question.

An exploration is a code-reading investigation that connects an entry, its owners, and its effects. Its essential value is compiler-resolved relationships with focused source in one view.

## Start with the question

Do not run a fixed sequence. Select the smallest command that can answer the question.

| Question                                            | First command                         | Focused follow-up                                                     |
| --------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| Where does text, a route, an event, or a key occur? | `scip-query search <text>`            | Add `--scope` or `--regexp`; use `inspect` once anchors are known.    |
| How do several related snippets fit together?       | `scip-query inspect --search <text>`  | Repeat `--search`, `--symbol`, or `--at` in the same command.         |
| Where is a symbol defined and used?                 | `scip-query evidence <symbol>`        | Add callers, callees, dependencies, or consumers with `--include`.    |
| How does one function work?                         | `scip-query code <symbol>`            | Use `call-graph`, `dataflow`, or `slice` for one named uncertainty.   |
| How does a feature work end to end?                 | `scip-query inspect` with its anchors | Use `context` if impact, reuse, or transitive flow remains uncertain. |
| What is in a file?                                  | `scip-query outline <file>`           | Use `code` for one symbol.                                            |
| What is in a module?                                | `scip-query system <module>`          | Use `surface`, `deps`, or `rdeps`.                                    |
| What can a change break?                            | `scip-query affected <symbol>`        | Use `change-surface <file>` for file risk.                            |
| Can existing code own this behavior?                | `scip-query similar <symbol>`         | Use `evidence` on the best candidate.                                 |
| Does the design obey repository boundaries?         | `scip-query architecture`             | Read the exact forbidden edges.                                       |
| Where is cleanup pressure?                          | `scip-query health --full`            | Use the named React, Vue, drift, duplication, or complexity command.  |

Use `inspect` when the question needs source units from several files. It
expands a matching line to the smallest readable function, method, object, or
declaration. It also recovers behavior hidden by a one-line compiler range.
For example:

```bash
scip-query inspect \
  --search sessionStreamEvents \
  --search work_session_stream_events \
  --symbol publishEvent \
  --at src/api.ts:42
```

Prefer `evidence` when one exact symbol and its relationships answer the
question. For example:

```bash
scip-query evidence appendEvent --include definition,references,callers,callees
```

Batch independent observations in one tool turn when the host supports it. Do not repeat an unchanged observation after context compaction.

Search once when the first anchor is unknown. Do not then search every symbol
name and outline every matching file. Put the known gaps into one `inspect`
packet. If that packet answers the question, stop exploring and use the
evidence.

## Evidence rules

- Treat scip-query source excerpts as source already read.
- Follow compiler relationships before folder names or text similarity.
- Use the exact target commands from an ambiguity error. Do not accept the first candidate.
- Read the coverage footer before a claim about every caller, reference, or consumer.
- Use `--full` only when omitted relationships can change the answer.
- Treat architecture edges as repository policy facts.
- Treat detector findings as cleanup candidates until source supports the change.

Use a native source read only for one of these reasons:

- You must edit the exact lines.
- The command states that source is missing or omitted.
- The required file is not indexed code.
- A literal search needs a file type that `scip-query search` did not scan.

Name the gap before the fallback. Do not silently repeat the same exploration with `rg` and full-file reads.

## Finish

State the entry-to-effect path, the material consumers, and the main uncertainty. Cite the scip-query command and source identity for each material claim.
