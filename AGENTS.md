<!-- scip-query:agent-setup:begin -->

## scip-query

This repository uses scip-query as its primary code exploration surface.

scip-query turns compiler-resolved and automatically extracted runtime-boundary facts into a coverage-accounted repository map. Start from a distinctive literal, symbol, or genuine entry point; use system-map to identify participating components and proven boundaries; expand several relevant regions together; compare their behavioral views in one batched inspection; and open exact source only for details capable of changing the decision. Treat exact edges as facts within coverage, candidates as leads, and never treat missing output as proof of absence.

- Start codebase exploration with scip-query. Use native search or direct source reads only for an exact edit or a named evidence gap that scip-query cannot answer.
- For a cross-layer or end-to-end question, start with `scip-query system-map` using the smallest independent `--search` and `--symbol` anchors; do not repeat one identifier through both selector families merely to widen output. Read its traversal-seed, retained match-only, and withheld traversal-relevant region ledgers plus the coverage report. Run the emitted `Expand together:` command for one child-file summary of the ranked system. Add several withheld or match-only regions explicitly only when they can change the decision. Run the expanded map's behavioral drill-down for the named behavioral gap; escalate afterward with `code` only for an exact unit whose complete implementation can change the decision.
- Use `scip-query search <text>` to find an unknown first anchor. Every search lists all exact match identities and owners while previewing bounded representative source. Its identity coverage is complete without `--full`; use the emitted batched drilldowns for selected owners, and use `search --full` only when source around every match matters.
- Use `scip-query inspect --view behavior` with repeated `--search`, `--symbol`, or `--at` selectors to compare several components in one coverage-diverse packet. Compact units remain raw source; larger units use a complete normalized outline only when it is cheaper; unsupported statements remain verbatim. Use `code` for the few exact implementations whose details can change the decision.
- Use `scip-query code` only for complete exact reads whose full implementation can change the decision. Symbols and ranges return source; file selectors return exported source (or top-level definitions when no explicit export surface exists) plus same-file referenced definitions and a complete omitted-local ledger. Batch only independently necessary exact units, cite the absolute line numbers already returned, and do not re-read those ranges with `nl`, `sed`, `rg`, or another scip-query command. A refusal means the request was too broad and no partial source was emitted; narrow to the exact units still needed before deciding whether every split remains necessary.
- Read inspect's selector cardinality, omission ledger, packet coverage, and stopping check. Stop on `stop-ready` unless a named blind spot matters. Otherwise drill into several relevant omission groups together; use `--full` only when omitted evidence can change the decision. `--full` and `--limit` are mutually exclusive. Coverage expansion is optional drilldown, not a transport continuation.
- Use `scip-query evidence <symbol> --include definition,references,callers,callees` to compose one exact symbol and its material relationships in one response.
- Use `scip-query context <target>` to map flow, consumers, reuse options, constraints, and relevant source before a nonlocal change.
- Do not inventory one file or symbol at a time. Batch known gaps with `inspect`, then add a focused query only when a named uncertainty remains.
- Use focused graph commands when a compiler-resolved relationship can change the plan. Do not rerun an unchanged read-only query.
- Use `scip-query diff-impact` to map changed symbols and downstream consumers after a nontrivial edit.
- Use `scip-query architecture` to inspect explicit structural rules.
- Use `scip-query health` to find React, Vue, duplication, complexity, drift, and cleanup candidates.
- Treat compiler-graph and exact runtime-boundary findings as facts within stated coverage. Candidate boundary links and heuristic findings need source confirmation and do not drive default traversal.
- Before claiming a complete relationship set or an absence, inspect coverage and use `--full` only when complete coverage can change the decision. A bounded result cannot establish that no caller, route, branch, poller, or consumer exists.
- Before claiming what every callsite passes, read the `trace` or `evidence` claim-support section. Only an eligible callsite-argument claim is backed by complete syntactic invocations; bounded context is not proof.
- Prefer human output for agent reading. Use `--json --result-only` only for a programmatic consumer.
- With an explicit SCIP_QUERY_SESSION, a complete source unit or graph unit/edge may be replaced only by a visible receipt for content-identical evidence from the same index generation. Partial source coverage never suppresses an exact unit; changed bytes, changed graph content, a new generation, or --reemit force full evidence.
- If output emits `Continue exactly:`, run that command unchanged until transport is complete.
- When architecture rules are configured and clean, setup installs one checkout-local Stop hook. It checks architecture only after indexed source changes.
- Commit relevant `.scipquery/suppressions/*.json` records with the change. Do not commit local agent-tool settings.
<!-- scip-query:agent-setup:end -->

## Git workflow

- Work directly on `main` unless the user explicitly asks for a separate branch.
