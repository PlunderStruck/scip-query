---
name: scip-plan
description: Turn verified repository behavior into an executable change plan with exact owners, consumers, preserved behavior, retirement steps, and meaningful checks.
---

# SCIP Plan

Load `$scip-query` for mechanics and `$scip-explore` when live behavior is not established. A plan is an ordered set of concrete changes and checks another agent can execute without rediscovering the system.

The [planning and change-review commands](../scip-query/references/command-guide.md#orientation-and-change-review) distinguish a pre-change briefing, proposed symbol impact, actual diff metrics and downstream consumers. Choose the one that settles the current planning question; do not run them all for the same fact.

Plan changes spanning owners, consumers, dependencies, migrations, or several implementation steps. Skip a document for one obvious edit. Persist substantial plans in the project's normal location, usually `docs/plans/YYYY-MM-DD-<change>.md`, when they must survive a context reset.

## Establish the implementation

Treat its commands as controls, not a checklist. Use `scip-query evidence` and exact source to identify the initiating surface, current owner, existing patterns, consumers, effects, and constraints. When several implementations match, establish which paths are live before choosing where to edit. Compare existing contracts before creating another implementation.

State the observable outcome and current behavior with exact symbol and file/line references. Describe design choices as choices, including evidence that could make the proposed grouping wrong. Use `$scip-architecture-review` for design assessment and `$scip-integrity-audit` for doubts about whether a feature works.

## Write executable steps

| Step | Code reference | Change | Preserve or retire | Verify |
| --- | --- | --- | --- | --- |
| One coherent implementation step | Exact owner and relevant consumers | Concrete edit and purpose | Behavior, interfaces, state, or obsolete mechanisms | Check detecting the missing or incorrect outcome |

Order steps so earlier changes enable later ones and intermediate states are valid or have an explicit migration/rollback strategy. Give each rule/resource an identified owner. Name consumers that must migrate and legacy entry points, fallbacks, registrations, copies, and documentation to retire.

Preserve authorization, errors, bounds, defaults, operation/record identity, lock scope, order, retries, interruption, and cleanup where applicable. Do not hide unresolved decisions behind “wire it up,” “use the parser,” or “add tests.”

Validation must exercise promised behavior through a real consumer. Record independent expected outputs/failures when they distinguish a real fix from a shortcut. For a parser migration, include syntax that defeats the old method and evidence that the live consumer uses the replacement. Do not require arbitrary counts of tests, alternatives, or unrelated performance targets.

## Execute and update

Continue already-authorized implementation; planning does not create another approval gate. Update completed work and verified facts. Record material findings as fixed, retained with reason, or unresolved with missing evidence. Retire superseded steps so later agents do not repeat them.

Run focused behavioral tests and required repository checks. Run `scip-query review --base <commit>`, fresh `diff-impact`, and architecture checks when dependencies changed. Investigate findings without changing thresholds or policy to conceal them. Repeat checks after relevant changes, not the entire suite after every small step.

Report outcomes, actual validation, remaining limits, and migration status. Checking off implementation steps does not establish that the promised outcome works.
