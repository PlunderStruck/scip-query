<!-- scip-query:agent-setup:begin -->
## scip-query

This repository uses scip-query for compiler-backed code intelligence.

- Use native search and file reads for literal text and source.
- Use `scip-query context <target>` to map flow, consumers, reuse options, constraints, and relevant source before a nonlocal change.
- Use focused graph commands when a compiler-resolved relationship can change the plan. Do not rerun an unchanged read-only query.
- Use `scip-query diff-impact` to map changed symbols and downstream consumers after a nontrivial edit.
- Use `scip-query architecture` to inspect explicit structural rules.
- Use `scip-query health` to find React, Vue, duplication, complexity, drift, and cleanup candidates.
- Treat compiler-graph findings as facts within stated coverage. Treat heuristic findings as candidates that need source confirmation.
- Before claiming a complete relationship set, inspect coverage and use `--full` only when complete coverage can change the decision.
- Prefer human output for agent reading. Use `--json --result-only` only for a programmatic consumer.
- If output emits `Continue exactly:`, run that command unchanged until transport is complete.
- Commit relevant `.scipquery/suppressions/*.json` records with the change. Do not commit local agent-tool settings.
<!-- scip-query:agent-setup:end -->

## Git workflow

- Work directly on `main` unless the user explicitly asks for a separate branch.
