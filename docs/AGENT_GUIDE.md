# Agent guide

Use ordinary search and file tools to read implementation details. Use scip-query to connect code locations through calls, value flow, runtime handoffs and dependencies, and to identify evidence of maintenance problems. The agent owns the plan, changes, tests and final judgment.

Load only the relevant [bundled skill](SKILLS.md). A local lookup needs no analysis ceremony.

## Explore and plan

For an unfamiliar repository, `scip-query system --source` shows current TS/JS module groups and their dependencies, including groups without findings. Select a printed group or exact path for its files, export declarations and import sites. Directory membership does not establish business responsibility.

Before a substantial change, trace the existing operation from its initiating surface through the shared owner to the observable outcome. Find comparable features and conventions. Document reuse, extension points, affected consumers, preserved behavior and verification in the plan. Reading implementation details with ordinary tools remains part of this investigation.

Use `scip-query context <target>` for reuse and impact candidates. For a concrete relationship question, use exact locations already found in source:

```bash
scip-query evidence --at src/service.ts:42 --edge execution --direction incoming --depth 1 --max-edges 30
```

Incoming execution finds callers; outgoing execution finds callees. Dataflow follows values, runtime follows handoffs, and dependencies show static reliance. Select other families only when they answer the question. Candidate relationships require source confirmation. Static relationships do not prove that an invocation occurred.

`search`, `outline`, `entrypoints`, `code` and `inspect` remain optional when symbol identity, nesting, external roots or grouped source reads help. `code --bindings` and `inspect --bindings` explicitly add referenced literal values. Do not repeatedly read source that is already available.

## Review changes and maintenance findings

Run appropriate behavioral checks, then use `scip-query review --base HEAD` for changed-function quality and `scip-query diff-impact` for downstream consumers. Check `scip-query architecture` when dependencies or configured policy changed. Use `scip-query health` for current-source complexity, duplication and dependency findings; use `health --indexed` only for a relevant specialist question.

Findings identify possible work; they do not authorize automatic refactors. Confirm the defect and preserve authorization, decisions, errors, state identity, ordering, concurrency and cleanup. Missing test coverage is unavailable, never measured zero. Keep justified suppression records with the change; do not lower thresholds or widen rules to clear a report.

## Read only useful output

Ordinary oversized results are saved once to a temporary file with a short preview and exact path. Search/read the file selectively. Small results stay inline. Redirect output to a chosen file when it needs to persist; temporary saved previews expire or can be reclaimed under storage pressure.

Use `--json --json-output <path>` for programmatic filtering. Explicit pagination remains a compatibility option; reconstruct explicit JSON pages before parsing them. There is no ordinary requirement to drain pages or read every saved byte. A saved result preserves the query's output, not proof of exhaustive analysis.

Respect actual omitted, stale, unsupported or unresolved evidence. An empty bounded result cannot establish absence. Use `evidence --detail` for full provider explanations when their limitations matter. Stop when the relevant facts are established or the remaining limitations are explicit.

## Tool problems

Start with `scip-query status` or `scip-query doctor` for a reported installation/index issue. Respect disabled watchers and configured rebuild policy. Use the setup skill only for tool operations.
