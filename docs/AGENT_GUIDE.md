# Agent guide

scip-query supplies repository evidence. The agent owns the goal, plan, code,
tests, and final decision.

The [six bundled skills](SKILLS.md) separate exploration, planning, architecture/maintainability review, integrity investigation, and tool operations around one shared tool guide. Load only the workflow needed by the task.

For a first-use module inventory, run `scip-query system --source`. It includes current TS/JS groups with no health findings and reports source export declarations, imports, consumers, policy context, and coverage. Select a printed group ID or an exact path with the same command to investigate it. Directory membership does not establish business responsibility, and source exports do not establish a complete resolved public API.

## Before a nonlocal edit

Use one evidence ladder: locate exact text; orient it by compiler identity and
construct ownership; navigate typed compiler and runtime relationships; account
for every omitted direction; read connected behavior for the selected path;
then retrieve exact current source only where full implementation detail can
change the decision.

For a cross-layer or end-to-end question, first reduce the question to the few
material claims the answer must establish. Locate exact referents with `search`,
`outline`, or `entrypoints`, then choose the relationship families and directions
capable of establishing each claim. Use `--symbol` only for a printed compiler
identity and `--at` for an exact construct location. Batch independent roots:

```bash
scip-query evidence \
  --symbol <symbol> \
  --edge execution \
  --edge runtime \
  --direction both \
  --depth 2 \
  --max-edges 32
```

Read the returned facts, evidence strength, provider support, coverage, folds,
and recovery paths together. Query completion accounts for the requested bounded
projection; it does not mean the user's task is complete. If a material claim
still requires implementation behavior, resolve its exact constructs with one
batched `inspect --view behavior` call. Use `code` only when exact syntax can
change the decision. Do not enumerate unrelated helpers, examples, tests, or
frontiers. Query count measures efficiency but never makes a recoverable material
claim optional.

Before sending the answer, audit the draft itself against the material claims.
Evidence seen but left implicit in the draft is not recovered. Copy returned
file and line identities exactly instead of reconstructing citation paths.

A broad literal is counted exactly and returned with recoverable structural
scopes. Narrow only when a named material claim requires one of those scopes.
Exact edges are facts within their reported coverage. Derived or candidate edges
and unsupported dynamic frontiers require the displayed source, another exact
referent, or an explicit limitation—not an absence claim.

When one known target is already the center of the change, run the aggregate
context query:

```bash
scip-query context <target>
```

Treat its source packet as already read. Write a normal concise plan. Add a
focused query only when a named uncertainty can change that plan.

For tracked nonbinary repository content, use `search`, `inspect`, and `code`
instead of native search or source reads. Native tools are for applying edits,
running checks, binary content, or a specific unsupported gap that scip-query
has explicitly reported.

## After a coherent edit

Run the repository's native checks. Then map downstream consumers when the
change can propagate:

```bash
scip-query diff-impact
```

For declared structural rules, run:

```bash
scip-query architecture
```

For cleanup, drift, React, or Vue work, run the relevant health or focused
detector command. Confirm heuristic candidates in source before editing them.

```bash
scip-query health --indexed
scip-query react-hook-candidates --full
scip-query vue-composable-candidates --full
```

There is no scip-query acceptance ceremony. Native tests establish behavior;
scip-query adds relationship and cleanup evidence.

## Efficient use

- Use `search` for an unknown literal anchor in indexed source.
- Use `system-map` before source drilldown when several layers or subsystems may
  participate. Treat its connected behavior as source already read. Follow an
  unresolved frontier only when it can answer a named material uncertainty.
- Use a behavior-view `inspect` packet for several related locations. Escalate
  to `code` only for known exact definitions or ranges whose complete source
  can change the decision. An exact
  file path returns exported definitions (or top-level definitions when no
  explicit export surface exists) plus same-file definitions they reference
  and a complete ledger of omitted local definitions. Use
  `--members all` only when the whole file matters. If the command refuses an
  oversized packet, it emitted no partial source; narrow to the exact units
  still needed before deciding whether every split remains necessary.
- After the map, put known text, symbol, and file-line gaps into one
  `scip-query inspect --symbol <symbol> --at <file:line> --view behavior`
  packet. Read its exact selector cardinality, per-channel evidence coverage,
  omission ledger, and query completion. Stop when no named fact remains
  unanswered. Otherwise drill into several relevant omission groups together;
  omit the behavior view only for exact units whose full implementation can
  change the decision, and use `--full` only when all omitted evidence can change it.
  `--full` and `--limit` are mutually exclusive; never combine them.
- Treat returned, line-numbered source as citation-ready and already read.
  Native tools are for applying edits, running checks, binary content, or a
  specific unsupported gap that scip-query has explicitly reported.
- Do not repeat an unchanged query after context compaction.
- Do not claim that a caller, route, branch, poller, or consumer is absent from
  a bounded result. Use `--full` only when complete coverage can change a
  decision.
- Do not claim what every callsite passes unless the `trace` or `evidence`
  claim-support section marks callsite-argument claims eligible. A complete
  call expression contains the callee and every argument through the closing
  delimiter; a bounded context window does not.
- Search always reports exact match cardinality. Small results list every
  matching path-line identity and owner; broad results stop lower-ranked
  identities before output transport and return a representative manifest plus
  ranked scope commands. There is no transport cursor to drain. Narrow to a
  distinctive literal or one relevant scope; use `search --full` only after
  deliberately narrowing when every remaining source window matters.
- With an explicit `SCIP_QUERY_SESSION`, a complete source unit, a
  byte-identical exact subset of a prior exact source read, or a graph unit/edge
  may be replaced by a visible receipt from the same index generation. Preview
  coverage never suppresses an exact unit; changed bytes, changed graph
  content, a new generation, or `--reemit` force full evidence.
- Follow an emitted `Continue exactly:` command until transport is complete.
  Coverage expansion commands are optional drilldowns, not transport pages.
- Use human output for model reading and `--json --result-only` for programs.
- Never rerun a successful human command as JSON. Before each drilldown, name
  the still-unanswered fact and stop when none remains; every additional
  reasoning step pays again for the accumulated context.
- Commit relevant suppression files, but do not create work-state records.

## Setup failures

Use `scip-query doctor` when a query reports that the tool or index is not
usable. Use `scip-query status --capabilities` to see which evidence providers
are available.
