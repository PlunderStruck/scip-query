# Agent guide

scip-query supplies repository evidence. The agent owns the goal, plan, code,
tests, and final decision.

## Before a nonlocal edit

For a cross-layer or end-to-end question, run one system map from the smallest
set of independent indexed anchors. Usually that is one distinctive protocol,
route, event, table, or message literal plus one callable or contract symbol.
Do not repeat the same identifier through both selector families merely to
widen output:

```bash
scip-query system-map --search <literal> --symbol <symbol>
```

Read the traversal-seed, retained match-only, and withheld traversal-relevant
region ledgers plus the coverage report. Run `Expand together:` for the ranked system.
Add several withheld regions when their
relationships can change the decision. A whole-token match in ordinary source seeds
traversal; embedded substrings and test, fixture, mock, preview, demo,
or example hits remain visible without pulling their dependencies into the
default map. Add a match-only region explicitly only when it can change the decision. Expansion
reports every child file with complete mapped counts and a small set of ranked
definition locations, then emits one bounded `code` command that reads ranked
definitions plus context around ownerless literal sites, and one bounded behavior command. Cite the absolute
line numbers in the `code` result. Use the behavior command when the expanded
regions remain material, or remove only irrelevant anchors. A behavior
view is the cheapest faithful syntax-derived representation of a complete
source unit: compact units stay raw, while larger units use a normalized
hierarchical outline only when it is materially smaller. Every statement is
represented; unsupported or compression-sensitive statements remain
verbatim. Exact built-in runtime-boundary links participate in traversal.
Candidate and unresolved runtime frontiers are reasons to add focused anchors,
not reasons to assume the missing relationship does not exist.

When one known target is already the center of the change, run the aggregate
context query:

```bash
scip-query context <target>
```

Treat its source packet as already read. Write a normal concise plan. Add a
focused query only when a named uncertainty can change that plan.

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
scip-query health --full
scip-query react-hook-candidates --full
scip-query vue-composable-candidates --full
```

There is no scip-query acceptance ceremony. Native tests establish behavior;
scip-query adds relationship and cleanup evidence.

## Efficient use

- Use `search` for an unknown literal anchor in indexed source.
- Use `system-map` before source drilldown when several layers or subsystems may
  participate. Follow compiler and exact built-in runtime-boundary links,
  inspect unresolved frontiers, expand several regions together, then inspect
  only locations tied to a named behavioral uncertainty.
- Use a behavior-view `inspect` packet for several related locations. Escalate
  to `code` only for known exact definitions or ranges whose complete source
  can change the decision. An exact
  file path returns exported definitions (or top-level definitions when no
  explicit export surface exists) plus same-file definitions they reference
  and a complete ledger of omitted local definitions. Use
  `--members all` only when the whole file matters. If the command refuses an
  oversized packet, it emitted no partial source; narrow to the exact units
  still needed before deciding whether every split remains necessary.
- Put known text, symbol, and file-line anchors into one behavior-view `inspect`
  packet. Read its exact selector cardinality, omission ledger, and
  packet coverage. Read its stopping check: stop on `stop-ready` unless a named
  semantic blind spot matters. Otherwise drill into several relevant omission groups together; omit
  the behavior view only for exact units whose full implementation can change
  the decision, and use `--full` only when all omitted evidence can change it.
  `--full` and `--limit` are mutually exclusive; never combine them.
- Treat returned, line-numbered source as citation-ready and already read. Use
  a native read only for exact edit
  lines, a non-indexed file, or a named evidence gap.
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
- With an explicit `SCIP_QUERY_SESSION`, a complete source unit or graph
  unit/edge may be replaced only by a visible receipt for content-identical
  evidence from the same index generation. Partial source coverage never
  suppresses an exact unit; changed bytes, changed graph content, a new
  generation, or `--reemit` force full evidence.
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
