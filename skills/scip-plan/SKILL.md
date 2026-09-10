---
name: scip-plan
description: Plan changes by mapping the existing system end to end, finding comparable features and conventions, and documenting how to reuse or extend current owners instead of creating parallel implementations.
---

# SCIP Plan

Load `$scip-query` for mechanics and use `$scip-explore` to establish the existing behavior the change will touch. Reuse facts already established by current evidence. A plan is an ordered set of concrete changes and checks another agent can execute without rediscovering the system.

The [planning and change-review commands](../scip-query/references/command-guide.md#orientation-and-change-review) distinguish a pre-change briefing, proposed symbol impact, actual diff metrics and downstream consumers. Choose the one that settles the current planning question; do not run them all for the same fact.

Plan changes spanning owners, consumers, dependencies, migrations, or several implementation steps. Skip a document for one obvious edit. Persist substantial plans in the project's normal location, usually `docs/plans/YYYY-MM-DD-<change>.md`, when they must survive a context reset.

## Map the existing system before designing the change

State the requested observable outcome. Then establish how the affected operation works today, from its actual initiating surface to the result its consumer observes. Cover the relevant authorization and validation, dispatch or registration, transformations, shared services, durable state changes, runtime handoffs, notifications, returned values, and failure/recovery paths. Follow queued work through its consumer when completion depends on that consumer. Bound this investigation to facts that can change the plan; an end-to-end map does not require reading the entire repository.

Locate the entry surface with ordinary repository search; use `entrypoints` when external roots are unclear. Use `context` for reuse candidates and `evidence` for the execution, runtime or dependency relationships needed to connect the existing path and consumers. Read implementation details with ordinary file tools; symbol-aware reads are optional. Choose commands to settle facts, not to complete a fixed query checklist. A module inventory, a matching type, a helper's implementation or the first search result does not establish the operation's live path.

Find existing features that perform the same operation or a closely related one, including features with different names that use the same resource, service, registration mechanism or state transition. Trace a relevant working example through its real consumer and shared owner. Compare its contracts with the requested change: inputs, policies, state, effects and completion behavior. If several implementations exist, establish which serves the affected entry surface, which others remain live, and whether one is a compatibility path or an incomplete migration.

A shared implementation path is the connected code several features use to enforce the same rules or update the same state, such as a dispatcher, policy service and persistence operation. Identify that path before proposing a new handler, service, registry, store or copy of its rules. Find its supported extension points and the consumers they serve. Prefer extending that path and reusing its existing code when its contracts fit the request.

Code conventions are recurring implementation choices in working features that coordinate how those features integrate, such as registration, dependency injection, error handling and test setup. Record the conventions demonstrated by the comparable features, with exact references. Follow them unless a verified defect or a requirement makes them unsuitable; in that case, explain the constraint and plan the coherent change and any consumer migration. Do not create a second implementation merely because a new file is easier to write, or copy an existing defect to match its style.

Before deciding that no reusable implementation exists, resolve relevant search and graph coverage gaps and examine the nearest related owners and features. Record the searched scope and remaining uncertainty. Missing, bounded or unsupported evidence does not establish absence. If an unresolved fact could change placement or reuse, keep that design decision unresolved and continue independent work; do not fill the gap with a speculative parallel implementation.

Use `$scip-architecture-review` for design assessment and `$scip-integrity-audit` when multiple paths, advertised behavior or an apparent replacement may conceal an incomplete implementation.

## Record the evidence in the plan

Before the proposed implementation steps, include these sections in every substantial plan:

- **Existing flow:** an ordered account or compact diagram from the initiating surface through the current owners and effects to observable completion, with exact symbol or file/line references. Include the relevant alternative outcomes and recovery behavior. Name the component that owns each rule and resource and any lifetime or sharing scope that affects the change.
- **Comparable features and conventions:** the working examples inspected, the shared path they use, their relevant contracts, and the conventions the change should follow. Separate observed facts from proposed choices. When no analogue was found, record the actual search scope and limits instead of asserting that none exists throughout the codebase.
- **Reuse and ownership decisions:** the existing symbols or modules to call, extend or adapt, where the new behavior enters the established flow, and the consumers affected. For a proposed new owner or parallel path, state why extending the existing owner cannot meet the requirement and how responsibility stays clear. A deliberate replacement must name the consumers to migrate and the old path to retire.

Another agent must be able to identify the existing central path and implement the extension from this record. Statements such as “follow existing patterns,” “reuse the service,” or “the system was explored” are insufficient without the actual path, references and decisions. Resolve contradictions between the proposed design and the observed implementation before marking the plan ready for dependent implementation. Planning does not add a user approval requirement.

## Write executable steps

| Step                             | Code reference                     | Change                    | Preserve or retire                                  | Verify                                           |
| -------------------------------- | ---------------------------------- | ------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| One coherent implementation step | Exact owner and relevant consumers | Concrete edit and purpose | Behavior, interfaces, state, or obsolete mechanisms | Check detecting the missing or incorrect outcome |

Order steps so earlier changes enable later ones and intermediate states are valid or have an explicit migration/rollback strategy. Give each rule/resource an identified owner. Name consumers that must migrate and legacy entry points, fallbacks, registrations, copies, and documentation to retire.

Preserve authorization, errors, bounds, defaults, operation/record identity, lock scope, order, retries, interruption, and cleanup where applicable. Do not hide unresolved decisions behind “wire it up,” “use the parser,” or “add tests.”

Validation must exercise promised behavior through a real consumer. Include a check that would fail if the new feature bypassed the shared registration, policy, state-management or persistence path it is meant to extend. Verify the relevant decisions and observable effects; a test of an isolated new helper or a mock replacing the shared path does not establish integration. Record independent expected outputs/failures when they distinguish a real fix from a shortcut. For a parser migration, include syntax that defeats the old method and evidence that the live consumer uses the replacement. Do not require arbitrary counts of tests, examples, alternatives, or unrelated performance targets.

## Execute and update

Continue already-authorized implementation; planning does not create another approval gate. Before dependent edits, use the recorded existing flow and reuse decisions. If implementation reveals a missed owner, convention or existing feature, update the plan and affected steps before proceeding with a conflicting design. Update completed work and verified facts. Record material findings as fixed, retained with reason, or unresolved with missing evidence. Retire superseded steps so later agents do not repeat them.

Run focused behavioral tests and required repository checks. Run `scip-query review --base <commit>`, fresh `diff-impact`, and architecture checks when dependencies changed. Investigate findings without changing thresholds or policy to conceal them. Repeat checks after relevant changes, not the entire suite after every small step.

During diff review, compare the implemented entry-to-result flow with the plan. Confirm that the real consumer reaches the intended shared owner, existing callers retain their required behavior, and new code has not duplicated registration, policy checks, data access or state ownership elsewhere. For a replacement, verify the named consumers migrated and the obsolete path was retired. Clean complexity metrics alone do not establish reuse or correct integration.

Report outcomes, actual validation, remaining limits, and migration status. Checking off implementation steps does not establish that the promised outcome works.
