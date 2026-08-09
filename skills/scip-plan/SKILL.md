---
name: scip-plan
description: Write a concise implementation plan for a non-trivial feature, fix, refactor, migration, or retirement. Use scip-query evidence for ownership, flow, consumers, reuse, residue, architecture, and proof.
---

# SCIP Plan

Write a plan that another coding agent can execute without rediscovery.

A concrete plan is a short sequence of code changes tied to observed source and relationships. Its essential trait is that each material step names the fact that makes the step necessary. Direct evidence is source or compiler-graph output that names the exact code unit and relationship behind a claim; it differs from a folder guess, a likely story, or a general design preference.

Do not write a plan for one obvious local edit. Write one when correctness depends on several owners or files, downstream consumers, a migration or retirement, reuse of existing behavior, architecture rules, or several coherent implementation slices. Put it in `docs/plans/YYYY-MM-DD-<name>.md` only when it must survive a context reset.

## Gather decision evidence

Apply `$scip-query`. State the material repository facts that can change the plan, then locate exact owners with `search`, `outline`, or `entrypoints`. Project only the explicitly chosen relationships with `evidence --symbol <symbol> --edge <family> --direction <direction> --depth <n> --max-edges <n>`. Use `inspect --view behavior` for named behavioral gaps and `code` only when syntax can change a decision. Use `diff-impact` for downstream consumers and `architecture` for declared structural constraints. Stop when the plan's decisions have direct evidence; do not perform a second broad exploration pass.

## Plan shape

State the observable outcome in one or two sentences. Describe the current entry, behavior owner, effect, and material consumers with source identities. Then use this table:

| Change | Direct evidence | Preserve | Retire | Prove |
| --- | --- | --- | --- | --- |
| Exact coherent edit | Command and source identity | Existing behavior or contract | Obsolete symbol, route, branch, export, or file | Check that can expose failure |

Split a row only when the next row can start from a valid repository state. Include an open-uncertainty section only when an unknown can change the implementation, and name the exact next command that resolves it.

For each changed owner and material consumer, cite direct evidence, compare an existing reuse candidate before adding a helper or layer, name behavior that must remain true, name residue that must disappear, include architecture constraints, and choose a proof that can fail when the outcome is absent. Label design choices as choices. Do not add approval ceremony, evidence IDs, or progress bookkeeping. The plan is ready when implementation can start without another broad exploration pass.
