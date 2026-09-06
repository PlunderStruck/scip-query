---
name: scip-architecture-review
description: Evaluate architecture and maintainability for coding agents. Find ambiguous owners, duplicated rules, leaked coordination, misleading boundaries, and dependency problems; justify changes from behavior and consumers.
---

# SCIP Architecture and Maintainability Review

Load `$scip-query` for mechanics. This workflow covers first-use assessment, later design reassessment, and the structural consequences of changes. Use `$scip-integrity-audit` when the issue is whether a feature fulfills its promise.

Choose from the shared guide's [architecture and dependency commands](../scip-query/references/command-guide.md#architecture-and-dependencies), [simplification and cleanup commands](../scip-query/references/command-guide.md#simplification-and-cleanup), or [framework investigations](../scip-query/references/command-guide.md#framework-investigations) when a concrete concern calls for that analysis. Each row explains its question, index requirement and limits.

A module assigns responsibility to a group of code, such as storing documents or calculating eligibility. Its interface is the operations and rules consumers must understand: inputs, results, errors, effects, and ordering. A dependency exists when one implementation relies on another's behavior or representation.

Maintainability is the ability to change required behavior correctly without unnecessary discovery, duplicated decisions, or coordinated edits. Evaluate mistakes the structure would invite an agent to make and the facts it must discover to avoid them. File size, folder names, interface counts, and clean dependency rules do not establish design quality.

## Orient without inventing owners

Run `scip-query system --source` for current TS/JS module groups and imports, including groups without findings. It needs no index or architecture configuration. Group IDs distinguish declared boundaries from provisional directories. Read coverage and missing configuration before claiming whole-repository visibility.

Use a printed group selector to investigate its files, dependencies, consumers, source interface evidence, findings, and limits. Use `health` for ranked cleanup candidates when useful and `architecture` for declared policy. Neither substitutes for behavior.

For a large review, record groups inventoried, relationships investigated, concerns confirmed/rejected, and unresolved scopes. Follow important cross-group relations as well as directory children. A structural inventory of all files is not a behavioral review of all modules.

## Evaluate maintenance consequences

| Concern | Evidence to seek | Counterevidence |
| --- | --- | --- |
| Unclear owner or competing implementations | One rule is independently decided in live paths; fixes or thresholds disagree | Different contracts, versions, platforms, or compatibility obligations |
| Caller coordination | Consumers repeat preparation, transaction, ordering, or cleanup for one responsibility | The consumer owns the broader operation or transaction |
| Weak interface | Consumers require internal formats or undocumented ordering | Required control, performance, or interoperability |
| Mixed responsibilities | Operations have separate state, consumers, dependencies, and reasons to change | A shared lifecycle, invariant, or public capability |
| Dependency direction | Independent policy imports delivery mechanisms; a cycle obstructs a required separation | Deliberate orchestration or a grouping-only cycle without a file cycle |
| Unnecessary mechanisms | Copies, wrappers, registries, or pipelines require several updates for one decision | An adapter isolates a real change boundary or distinct contract |

A deep module provides useful behavior while exposing relatively little implementation knowledge to callers. Examine required knowledge and coordination. One argument with dozens of interacting settings does not establish depth; adding implementation lines does not improve it.

Read relevant implementations AND consumers. State: “When an agent changes X, it must also discover/change Y because Z; this proposal removes that obligation by …”. Name the strongest example that could invalidate the proposal. Similar syntax or names do not establish interchangeable behavior.

For recurring bugs, trace mechanisms to a specific violated rule, test competing explanations, and investigate predicted instances elsewhere. A missed predicted instance does not by itself disprove the diagnosis or establish absence.

## Preserve justified decisions

A configured boundary maps files to a named policy group. An allowed-dependency row states which groups it may depend on; missing rows remain unknown. Record reasons for important directions in design documentation, not only current imports.

Use existing `.scipquery.json` controls for membership, allowed directions, and relevant cycle/coverage constraints. Do not automatically bless all current edges, raise size limits, or widen allowances to clear a report. Counts locate candidates; they are not universal design laws.

Later reassess responsibilities and allowances from present behavior and realistic changes. Report policy compliance separately from whether the policy still serves the project.

## Recommend or implement

Record exact code/consumers, the maintenance mistake invited, supporting evidence and limits, counterevidence, proposed owner/interface, preserved behavior, what disappears, and checks exposing a mistaken change.

Combine symptoms of the same scattered rule. Compare alternative shapes when they materially change consumers or state ownership; do not require several designs for a trivial edit.

For larger simplifications read [design checks](references/design-checks.md) and use `$scip-plan`. Carry authorized fixes through migration, retirement, behavioral checks, current-source review, and fresh impact analysis. Review-only work stops at an evidence-backed assessment.

The result is supported decisions and specific unknowns, not a grade. Retaining the design is valid when a concern does not survive investigation.
