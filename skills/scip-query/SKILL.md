---
name: scip-query
description: Use scip-query to locate code, inspect relationships, plan around existing owners, and review actual changes. Load this shared tool guide with the workflow needed by the task.
---

# SCIP Query

scip-query is a code analysis tool connecting current source locations with measured structure and observed relationships. It helps coding agents select the live implementation, reuse existing rules, preserve behavior, and detect incomplete work.

A finding identifies concrete code and evidence of a possible problem. A candidate needs investigation; it does not authorize a refactor. An owner is the implementation responsible for a rule or resource, established from behavior and consumers. A folder or lexical container alone does not establish responsibility.

## Choose the work

| Task | Skill |
| --- | --- |
| Understand behavior, live implementations, consumers, and effects | `$scip-explore` |
| Plan a substantial change, migration, or retirement | `$scip-plan` |
| Evaluate architecture and maintainability, scattered rules, and unnecessary coordination | `$scip-architecture-review` |
| Investigate whether a feature fulfills its promise, including partial migrations and misleading checks | `$scip-integrity-audit` |
| Install, diagnose, index, or repair the tool | `$scip-setup` |

Load only the workflow needed. For authorized implementation, investigate, write a concise plan when needed, implement, and review. A workflow does not create another approval gate. Review-only requests remain review-only.

## Choose evidence

- `scip-query system --source` inventories current TS/JS module groups, including groups without findings. Add an exact path or printed group ID to investigate a group. It does not infer business responsibilities.
- `scip-query health` finds current-source complexity, duplication, and dependency issues without an index. Use `health --indexed` only for a needed specialist framework, drift, or cleanup analysis.
- `scip-query search <exact-text>`, `outline <file>`, and `entrypoints [text]` locate referents. Ordering does not identify the implementation relevant to the task.
- `scip-query context <target>` gathers indexed reuse and impact candidates. Confirm behavior before choosing an owner.
- `scip-query evidence --at <file:line> --edge <family> --direction <direction> --depth <n> --max-edges <n>` projects chosen relationships. Repeat selectors to batch known participants.
- `scip-query inspect --at <file:line> --view behavior` reads a remaining behavioral gap; `scip-query code <symbol-or-file:range>` reads exact syntax.
- `scip-query architecture` checks declared dependency rules. Compliance does not establish well-chosen boundaries.

Use `execution incoming|outgoing` for callers/callees; `dataflow incoming|outgoing` for value origins/destinations; `runtime both` for handoffs; `state both` for resources; `temporal both` for order; `contract both` for interface constraints; `identity both` for entity identity; `ownership both` for containment; `dependencies outgoing` for static dependencies. Only execution and supported runtime handoffs establish executable reachability.

These are controls, not a mandatory sequence. State the facts needed, reuse returned identities, batch independent questions, and read named remaining gaps. Use the tool for repository exploration; native tools serve edits, checks, binary content, or a specific unsupported gap the tool disclosed.

## Evidence and transport

Exact evidence is directly observed; derived evidence is deterministically calculated; candidates require confirmation; mixed evidence retains its constituents; unknown cannot support a stronger claim. Read coverage, exclusions, and recovery before claiming completeness or absence. A syntax tree establishes parsed structure, resolved symbols establish declaration identity, and an executed test establishes only exercised behavior.

Source scans read current bytes. Indexed relationships require a fresh index. Respect disabled watching and printed recovery/rebuild policy. Run `capabilities --matrix` only when a named claim depends on uncertain support.

Prefer human output. For machine processing use `--json --json-output <path>` and inspect the saved result programmatically. For model-facing JSON use `--json --agent-output`. Never emit raw JSON into model context or rerun a successful human command just to get JSON. Drain every `Continue exactly:` cursor unchanged; recover omitted evidence when it can change the answer. Same-generation receipts avoid rereading identical evidence; `--reemit` recovers it.

## Review actual changes

After a nontrivial edit run `scip-query review --base <commit>` and fresh `scip-query diff-impact`. Normally the base is HEAD before committing. Review includes new/untracked functions and existing repository peers; it is not staged-only. Inspect changed functions even below warning thresholds. Check architecture when module dependencies or policy changed.

Resolve justified findings and run behavioral checks. Preserve authorization, errors, state identity, ordering, concurrency, cleanup, and consumers. Do not lower thresholds, widen policy, or suppress findings merely to make a report pass.

CRAP combines complexity with actual test coverage. Wrap the real test command with `scripts/record-review-coverage.mjs` for a source-matched receipt; missing/stale measurements are unavailable, never zero. [Review rules](../../docs/REVIEW.md) define the metrics and limits.

Report changes, executed checks, retained findings, and unsupported claims. Compilation, fewer lines, lower complexity, an empty report, or tests that only echo their mocks do not establish correct behavior.
