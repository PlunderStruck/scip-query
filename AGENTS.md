<!-- scip-query:agent-setup:begin -->
## scip-query

Use ordinary file tools for source search and reading. Use scip-query for code relationships, module structure, quality findings and change impact.

- `scip-query system --source [module]` — Module files and dependencies; --source adds a first-use inventory, exports, policy and findings without an index
- `scip-query context <target>` — Compiler-backed context for a symbol, file, or module
- `scip-query evidence` — Traverse selected typed relationships around exact referents; recover source separately when needed
- `scip-query health` — Find concrete TS/JS complexity, duplication, and dependency issues without an index
- `scip-query review` — Review current TS/JS changes against a Git commit, including new and untracked functions
- `scip-query diff-impact` — Map changed symbols and downstream consumers from the current git diff
- `scip-query architecture` — Evaluate project-owned architectural boundaries and dependency rules
- Use `capabilities --matrix` only when a named claim depends on uncertain provider support.
- Before a substantial change, identify the existing implementation path, comparable features, shared owners and affected consumers. Document reuse and extension choices in the plan. Confirm behavior with ordinary source reads and tests.
- Use `context` for reuse/impact candidates and `evidence` for a specific relationship question. Existing file:line locations are valid roots; symbol lookup and `outline` are optional when parsed identity or nesting helps. Avoid repeating source through `code` or `inspect` when ordinary file tools already establish it.
- Example: `scip-query evidence --at src/service.ts:42 --edge execution --direction incoming --depth 1 --max-edges 30` finds caller evidence. Use outgoing execution for callees, dataflow for values, runtime for handoffs, or dependencies for imports. Batch related roots; choose other families only for a named question.
- Exact observations are facts within their supported scope; derived observations are computed; candidates need confirmation. Containment does not establish business ownership. Material missing, stale or unsupported evidence prevents stronger claims and claims of absence.
- After a nontrivial edit use `scip-query review --base HEAD` and `scip-query diff-impact`. Check `architecture` when module dependencies changed; use `health --indexed` only for a relevant specialist question. Confirm findings before fixing them and preserve behavior in tests.
- Read saved results selectively with normal file tools. Use `--json --json-output <path>` for programmatic filtering. A displayed excerpt is enough only for facts it establishes; recover omitted details when they could change the decision. Do not drain pages or read whole files merely because they exist.
- Load `$scip-query` with the workflow needed: `$scip-explore`, `$scip-plan`, `$scip-architecture-review`, `$scip-integrity-audit`, or `$scip-setup`. Skip workflow ceremony for a simple lookup. Respect disabled watchers and configured rebuild policy.
- Commit relevant `.scipquery/suppressions/*.json` records with justified changes. Do not lower thresholds or widen architecture rules to clear a report. Do not commit local agent-tool settings.
<!-- scip-query:agent-setup:end -->

## Git workflow

- Work directly on `main` unless the user explicitly asks for a separate branch.
