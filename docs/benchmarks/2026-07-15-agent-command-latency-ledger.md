# Agent command latency optimization ledger

Date: 2026-07-15
Status: Complete

## Output contract

The commands, inputs, hashes, and keep threshold are fixed in the
[baseline](./2026-07-15-agent-command-latency-baseline.md). Performance changes
must preserve byte-identical stdout and exit status.

## Target selection

`plan-context` is first because it is both the slowest measured command and a
composition of the other target families. Its 1,722 ms median is 25 times the
raw Node process median. `affected` and `diff-impact` follow because they exceed
900 ms. The graph-analysis commands follow at 396-464 ms. `imports`, at 327 ms,
is evaluated last because it is closest to the current CLI process floor.

## Current pipeline

`plan-context` independently executes trace, call graph, complexity, dataflow,
two slices, affected closure, change surface, dependencies, reverse
dependencies, system, surface, and Git-backed history, then assembles the
result. Source: `scip-query code planContext`.

## Profile findings

1. `affected` paid semantic-reference setup once per frontier symbol; batching
   the frontier was the largest repeatable opportunity.
2. `plan-context` repeated dependency rows already present in `system` and
   resolved the same Git HEAD four additional times.
3. `diff-impact` launched four redundant Git diff-state subprocesses.
4. TypeScript reference-fragment validation remains a 165-197 ms
   `change-surface` cost, but precomputing dependency closures saved only 9 ms.
5. The graph commands and `imports` are dominated by required semantic and
   database initialization; isolated descriptor loading saved only 4-19 ms.

## Current-pipeline optimizations

### Batched caller evidence per affected frontier — accepted

The warmed component profile attributed 389 ms of `plan-context` to
`affected`. Its breadth-first traversal requested targeted semantic caller rows
one frontier symbol at a time even though the semantic provider already exposes
bulk definition requests.

The accepted change adds one exact bulk caller-row boundary and asks for all
frontier symbols together at each depth. Result construction, per-symbol row
order, limits, resolved SCIP references, semantic references, ignored-file
filtering, and breadth-first ordering are unchanged.

| Command | Batched median | Scalar median | Saved | Output |
| --- | ---: | ---: | ---: | --- |
| `affected` | 315 ms | 774 ms | 459 ms (59%) | identical SHA-256 |
| `plan-context` | 930 ms | 1,272 ms | 342 ms (27%) | identical SHA-256 |

The comparison alternated seven runs per variant in the same build, worktree,
watcher state, and index generation. The temporary scalar selector was removed
after the decision.

### Reuse single-file system edges — accepted

`system` already computes the same dependency and reverse-dependency relations
that the standalone `deps` and `rdeps` calls compute. When `system` resolves
exactly one file, `plan-context` now maps those existing rows into its two
sections. Multi-file and unmatched targets keep the independent query path.

Seven alternating same-build runs reduced the composite median from 921 ms to
873 ms, saving 48 ms. Symbol, exact-file, and module target probes all produced
identical output and exit status between paths.

### Reuse the invocation's Git HEAD — accepted

The CLI already resolves the exact HEAD commit while establishing its project
context. `plan-context` now supplies that immutable commit identity to the Git
evidence product and its co-change query. History caches remain HEAD-keyed, but
they no longer launch `git rev-parse HEAD` again for every product read.

The normal composite path fell from eight child processes to four and from five
`rev-parse` occurrences to one. Seven alternating same-build runs reduced the
median from 1,459 ms to 1,317 ms, saving 142 ms with identical output and exit
status. This comparison ran after an index generation change, so its absolute
times are colder than the system-edge comparison; the within-pair process and
timing deltas are the decision evidence.

### Consolidate `diff-impact` Git snapshots — accepted

`diff-impact` requested separate Git views for changed names, changed ranges,
renames, and deletions even though the name-status views already contain the
rename and deletion facts. It now reads two name-status views, two zero-context
patches, and the untracked-file list once, then derives the four result sets
from that invocation-scoped snapshot.

Seven alternating same-build runs reduced the median from 652 ms to 549 ms,
saving 103 ms (15.8%). Exit status, 32,688-byte JSON, and SHA-256
`c91bd280709b472417f20aab33868e5f432789f2ada68044fa5660327cb61924`
were identical. Diff-state Git subprocesses fell from nine to five; total Git
subprocesses, including the two common CLI context probes, fell from eleven to
seven.

### Precompute TypeScript dependency closures — rejected

The `change-surface` profile attributed 165-197 ms to validating 338 cached
TypeScript reference-fragment products. An SCC-condensed dependency-closure
resolver was tested to share transitive graph work across those validations.
Seven alternating same-build runs moved `change-surface` from 387 ms to 378 ms
(9 ms, 2.3%) and moved `call-graph` from 409 ms to 416 ms. Both commands kept
identical output, but neither result cleared the keep threshold. The experiment
and its selector were removed.

### Isolate symbol-analysis command descriptors — rejected

The direct-loader pattern that materially improved `code`, `outline`, and
`refs` was tested for `call-graph`, `dataflow`, `complexity`, and `slice`.
These commands necessarily load the shared semantic-analysis core, so avoiding
the rest of the command catalog removed little additional work. Same-build
median savings were 7 ms, 4 ms, 4 ms, and 19 ms respectively, with identical
output and status. The extracted descriptor module and selector were removed
because every result missed both keep thresholds.

### Isolate the `imports` command descriptor — rejected

A single-command `imports` descriptor was tested independently of the graph
group. Seven alternating same-build runs reduced the median from 314 ms to
305 ms, while preserving the 3,703-byte JSON and SHA-256
`1759b6ecda2fc58c01e78a2a47c1d3e2ca76b7df728986d379cc5992c3a6b251`.
The 9 ms gain missed both thresholds, showing that database and semantic-import
initialization dominate this command too. The experiment was removed.

## Final warmed scoreboard

This is the final-worktree seven-run snapshot. The baseline-to-final columns
are directional because the self-hosting source corpus and semantic generation
changed during the campaign; the same-build A/B sections above are the causal
accept/reject evidence.

| Command | Baseline median | Final median | Directional change |
| --- | ---: | ---: | ---: |
| `plan-context` | 1,722 ms | 802 ms | -920 ms (-53.4%) |
| `affected` | 941 ms | 304 ms | -637 ms (-67.7%) |
| `diff-impact` | 1,342 ms | 575 ms | -767 ms (-57.2%) |
| `change-surface` | 549 ms | 374 ms | -175 ms (-31.9%) |
| `call-graph` | 453 ms | 421 ms | -32 ms (-7.1%) |
| `dataflow` | 464 ms | 431 ms | -33 ms (-7.1%) |
| `complexity` | 415 ms | 406 ms | -9 ms (-2.2%) |
| `slice` | 396 ms | 392 ms | -4 ms (-1.0%) |
| `imports` | 327 ms | 319 ms | -8 ms (-2.4%) |

Every final command completed with exit status 0 and one stable stdout hash
across all seven runs.

## Alternative designs

- Prepared query context: resolve a symbol/file once and pass immutable prepared
  evidence to compatible public queries.
- Batched database primitive: fetch definitions/references/calls once and let
  pure result builders derive multiple views.
- Persistent query service: defer unless in-process work is already small;
  protocol and invalidation cost make it the highest-risk alternative.

## Decisions

- Accepted campaign order: composite planning, impact, graph analysis, imports.
- Accepted keep threshold: 10% or 30 ms median plus output identity.
- Accepted: batch targeted caller evidence by breadth-first frontier; both
  affected and composite planning cleared the threshold with identical output.
- Accepted: reuse `system` dependency edges only for its single-file case;
  multi-file behavior remains independent and three target shapes matched.
- Accepted: pass the invocation's pre-resolved HEAD through Git evidence; this
  removes four subprocesses and keeps all history reads on one snapshot.
- Accepted: derive `diff-impact` names, ranges, renames, and deletions from five
  shared Git reads instead of nine overlapping reads.
- Rejected: precomputing all TypeScript dependency closures; cache identity and
  product validation still dominated, so the added graph machinery saved only
  9 ms on `change-surface` and did not help `call-graph`.
- Rejected: isolated descriptor loading for the four symbol-analysis commands;
  their semantic core, rather than the complete descriptor catalog, dominates
  startup.
- Rejected: a leaf `imports` descriptor; it saved 9 ms and therefore did not
  justify a second descriptor definition.
- Rejected in advance: deleting result sections, reducing semantic evidence,
  lowering traversal depth, or weakening diagnostics to improve timing.
