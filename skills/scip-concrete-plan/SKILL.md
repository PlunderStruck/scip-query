---
name: scip-concrete-plan
description: Plan code changes with scip-query evidence and testable design. Use for non-trivial implementation, refactor, migration, API, or bug-fix plans before editing code; require source citations, reuse audit, test seams, side-effect boundaries, contracts, and verification.
commands:
  - template: "scip-query status --capabilities"
    when: "Discover: confirm the index is fresh before citing graph facts."
  - template: "scip-query plan-context <target>"
    when: "Discover: anchor the plan with pre-edit context for the target."
  - template: "scip-query refs <symbol>"
    when: "Reuse audit: find existing consumers before proposing a new unit."
  - template: "scip-query code <symbol>"
    when: "Reuse audit: read source before citing a behavior claim."
  - template: "scip-query trace <symbol>"
    when: "Verify the plan: rerun source-producing context for cited targets."
---

# Concrete Plan

Use this skill to write an implementation plan that another agent can execute without guessing. A concrete plan is a dated Markdown checklist whose code claims come from scip-query evidence and whose design makes the intended behavior easy to test before it is easy to ship.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md) when you need lookup tips, command families, postchecks, or subagent rules.

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | When |
| --- | --- | --- |
| `scip-query status --capabilities` | Show index status for this project | Discover: confirm the index is fresh before citing graph facts. |
| `scip-query plan-context <target>` | Pre-edit planning context for a symbol, file, or module | Discover: anchor the plan with pre-edit context for the target. |
| `scip-query refs <symbol>` | Find all files referencing a symbol | Reuse audit: find existing consumers before proposing a new unit. |
| `scip-query code <symbol>` | Read the source code for a symbol (bounded to its definition range) | Reuse audit: read source before citing a behavior claim. |
| `scip-query trace <symbol>` | Trace a symbol: definition + all references | Verify the plan: rerun source-producing context for cited targets. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Rules

1. Start with `scip-query status --capabilities`; reindex only when freshness is `stale`, `missing`, or `unknown`.
2. Anchor the plan with `scip-query plan-context <target>`. If the target is not indexed, record that fact and use scip-query for every code-adjacent claim it can answer.
3. Put the plan in `docs/plans/YYYY-MM-DD-<short-name>.md`.
4. Every code step includes a `Source` field naming the scip-query command that produced the path, line range, and behavior claim.
5. Every behavior-changing step includes a testability design: test seam, injected dependencies, pure core, side-effect boundary, and validation.
6. Do not propose a new helper, wrapper, type, parameter, config flag, component, hook, or module until the reuse audit proves reuse or extension is not the better move.

## Planning Terms

A reuse audit is the part of a plan that proves a proposed new symbol, file, option, wrapper, or contract is needed; what makes it useful is that it ties the new shape to existing definitions, consumers, and rejected extension points.

A test seam is the entry point a test can call to prove a behavior without replaying the whole product path; what makes it valuable in a plan is that it names the exact unit or boundary where correctness will be observed.

A side-effect boundary is the edge where deterministic program decisions meet files, processes, clocks, networks, databases, or other external capabilities; what makes it important is that failures and fakes can be isolated there while core decisions stay easy to test.

A contract is the stable promise one code unit exposes to another, including accepted inputs, returned outputs, errors, timing expectations, and side effects that callers may rely on.

## Workflow

### 1. Discover

Run:

```bash
scip-query status --capabilities
scip-query plan-context <target>
```

Use the shared reference for follow-up commands. Fill three gates before designing:

```markdown
## Goal
What the user is trying to accomplish and what done looks like for them.

## Current State
The affected end-to-end flow, with scip-query citations for entry points, callers, data flow, dependencies, downstream impact, and non-obvious invariants.

## Reuse Audit
For every new symbol or file being considered: reuse target, extension target, or evidence-backed reason new code is justified.
```

This step is complete only when the plan can explain the current flow, its consumers, and every proposed new unit's reuse decision with citations.

### 2. Shape for Tests

Before writing implementation phases, add:

```markdown
## Testability Design

| Behavior | Test seam | Dependencies to inject | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| <behavior> | <test entry point> | <clock/db/http/logger/etc.> | <calculation/decision function> | <I/O wrapper> | <small interface or call shape> |
```

Plan the code so tests can call the pure core directly and exercise the side-effect shell with injected replacements. Prefer this shape:

1. Parse and validate at the boundary.
2. Pass domain data and injected dependencies into a small orchestrator.
3. Put calculations, filtering, selection, formatting decisions, and state transitions in pure functions.
4. Keep database, network, filesystem, clock, randomness, logging, email, and payment calls in thin side-effect shells.
5. Depend on small contracts at boundaries; avoid broad option objects, booleans that hide behavior, and wrappers that merely forward.

This step is complete only when every changed behavior has a named test seam and the plan makes clear which logic can be tested without real external services.

### 3. Design the Checklist

Write phases in execution order. Keep each phase deployable or explicitly mark why it is not. Use this step format:

```markdown
### N.M - Imperative title

- [ ] **File**: `path/to/file.ts:LINE-LINE`
- **Source**: `scip-query <command>`
- **What**: Current behavior verified from source.
- **Change**: Exact edit to make.
- **Testability**:
  - Test seam:
  - Injected dependencies:
  - Pure core:
  - Side-effect shell:
  - Contract:
- **Validation**: Targeted test, smoke command, or manual check that proves the behavior.
- **Why**: Why this step is needed and why this order is safe.
```

This step is complete only when no checklist item says "update this file" without exact current behavior, target behavior, and validation.

### 4. Stress-Test

Apply these lenses to every phase. Add or change steps until each answer is concrete:

| Lens | Plan must answer |
| --- | --- |
| Purpose | Why does the current code exist, and what invariant must survive? |
| Blast radius | Which direct and transitive consumers move with this change? |
| Valid intermediate state | Would the project still work after only this phase? |
| Reversibility | Is this a one-way or two-way door, and what rollback exists? |
| Failure | What happens when I/O, external APIs, malformed data, retries, or crashes occur? |
| Concurrency | What shared state can be touched twice or out of order? |
| Boundaries | Who can call this entry point, and where is input validated? |
| Data integrity | What existing data, generated artifacts, or persisted contracts are affected? |
| Observability | Can a maintainer diagnose failures from logs/errors without rereading the source? |
| Human experience | What would surprise, confuse, or block a real user? |
| Reuse | Does existing code already solve this problem or most of it? |
| Testability | Are dependencies injectable, logic pure where practical, concerns separated, and contracts small? |

This step is complete only when every discovered gap has either a new plan step or a written reason it is accepted.

### 5. Verify the Plan

Run or delegate phase-by-phase reference checks. Each verifier confirms:

- every path exists;
- every line range is still within about five lines;
- every behavior claim matches source;
- every new unit has reuse evidence;
- every behavior-changing step has a validation command and testability design.

Then rerun the source-producing context for the cited targets:

```bash
scip-query plan-context <target>
```

Use the shared reference for subagent briefing text when delegating.

This step is complete only when stale references are fixed and every phase has a validation path.

## Output Shape

The plan file contains:

1. Title and date.
2. Goal.
3. Current State.
4. Reuse Audit.
5. Testability Design.
6. Design Phases.
7. Stress-Test Findings.
8. Execution Order and deployable phase notes.
9. Ship Order with one-way doors flagged.
10. Summary of files to create, edit, delete, and verify.
