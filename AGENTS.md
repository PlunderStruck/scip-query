<!-- scip-query:agent-setup:begin -->
## scip-query

This repository uses scip-query as its primary code exploration surface.

- Start codebase exploration with scip-query. Use native search or direct source reads only for an exact edit or a named evidence gap that scip-query cannot answer.
- Use `scip-query search <text>` for indexed literal source matches with owning symbols and bounded source windows.
- Use `scip-query evidence <symbol>` to compose a definition, references, callers, callees, dependencies, consumers, and related source in one response.
- Use `scip-query context <target>` to map flow, consumers, reuse options, constraints, and relevant source before a nonlocal change.
- Use focused graph commands when a compiler-resolved relationship can change the plan. Do not rerun an unchanged read-only query.
- Use `scip-query diff-impact` to map changed symbols and downstream consumers after a nontrivial edit.
- Use `scip-query architecture` to inspect explicit structural rules.
- Use `scip-query health` to find React, Vue, duplication, complexity, drift, and cleanup candidates.
- Treat compiler-graph findings as facts within stated coverage. Treat heuristic findings as candidates that need source confirmation.
- Before claiming a complete relationship set, inspect coverage and use `--full` only when complete coverage can change the decision.
- Prefer human output for agent reading. Use `--json --result-only` only for a programmatic consumer.
- If output emits `Continue exactly:`, run that command unchanged until transport is complete.
- When architecture rules are configured and clean, setup installs one checkout-local Stop hook. It checks architecture only after indexed source changes.
- Commit relevant `.scipquery/suppressions/*.json` records with the change. Do not commit local agent-tool settings.
<!-- scip-query:agent-setup:end -->

## Git workflow

- Work directly on `main` unless the user explicitly asks for a separate branch.
