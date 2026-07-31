# Phase 5 — autonomous agent workflow

Date: 2026-07-30
Status: planned; depends on Phases 2–4
Parent: [Autonomous completion execution plan](./2026-07-30-autonomous-completion-execution.md)

## Goal

```gherkin
Feature: The control system helps an agent work rather than making it perform control-system rituals

  Scenario: The agent performs a useful repository operation
    Given a current intended change
    When scip-query observes, mutates, verifies, or changes an obligation
    Then the corresponding evidence and attempt state are recorded automatically

  Scenario: Nothing decision-relevant changed
    Given the goal, repository state, decisions, and obligations are unchanged
    When another hook or command boundary occurs
    Then the agent receives no repeated workflow ceremony

  Scenario: Autonomous recovery is possible
    Given a failed, unknown, or blocked attempt has a policy-authorized next action
    When the workflow continues
    Then the agent replans or retries without requesting routine human approval
```

## Concepts fixed by this phase

Workflow integration is the automatic projection of the completion system into
the agent's existing plan–act–observe–verify loop. Its referents are session
context, pre-tool safeguards, command outputs, stop hooks, skills, and exact
continuations. It is wider than hook installation; the distinguishing property
is that useful operations produce and consume control state as a byproduct.

A changed-state trigger is an observable transition capable of altering the
next rational action: goal revision, repository identity change, new evidence,
attempt outcome, decision, obligation transition, or completion result. It is
wider than a timer or every tool call; the distinguishing property is
decision relevance, which prevents repeated context from becoming ceremony.

## Current code path and reuse

- setup installs project-local Codex and Claude hooks and managed instruction
  blocks.
- SessionStart, UserPromptSubmit, PostCompact, PreToolUse, and Stop already
  provide lifecycle boundaries.
- pre-tool handling prevents lossy output truncation.
- pagination state and stop evidence are already restored after compaction.
- specialist skills already route exploration, planning, improvement, and
  verification.

Extend these boundaries. Do not add a second daemon or require the agent to
copy receipt IDs, restate its goal, or manually maintain a progress checklist.

## Slices

### 5.1 Automatic event capture

Exact change:

- record observation, preview, mutation, verification, and obligation effects
  from operation-role-aware command completion;
- attach consumed and produced receipt IDs without agent input;
- coalesce read-only observations that add no new state; and
- expose explicit opt-out only for unsupported/manual workflows.

Expected validation:

- ordinary use adds zero metadata-entry commands;
- a command failure or timeout records failed/unknown rather than success;
- mutation results link pre-state evidence and post-state observation; and
- replay does not duplicate events.

### 5.2 Bounded context projection

Exact change:

- render the concise goal, current phase/condition, last novel attempt,
  settled decisions, live root obligations, and pending continuations;
- emit only on changed-state triggers or explicit status request;
- use stable cursors to suppress repetition; and
- keep full evidence retrievable through exact commands.

Expected validation:

- restoration stays within a pre-registered token budget;
- no essential live obligation is omitted;
- unchanged prompt hooks produce no repeated block; and
- the agent can recover the full referent behind every compact item.

### 5.3 Autonomous policy loop

Exact change:

- map controller outcomes to authorized next actions:
  continue, gather named evidence, repair, retry, replan, carry forward, or
  halt on a true authority boundary;
- apply bounded retry and deadline policies;
- distinguish blocked-by-work from blocked-by-missing-authorization; and
- retain attempted strategies so replanning does not cycle.

Expected validation:

- ordinary findings and mechanically valid suppressions resolve without human
  input;
- three repeated equivalent attempts trigger a different strategy or an
  explicit terminal blocker;
- unknown side-effect outcomes are reconciled before retry; and
- no policy path silently weakens the goal.

### 5.4 Skill and setup alignment

Exact change:

- update scip-query, plan, improve, verify, setup, and agent-design guidance to
  consume the canonical goal/change state;
- generate repeated command/evidence tables from runtime descriptors;
- install the minimum managed instructions needed to enter the protocol; and
- remove superseded manual checklist steps.

Expected validation:

- skill contract tests match the runtime registry;
- a newly set-up repository enters the workflow without hand-authored glue;
- uninstall removes local integration but preserves shared project history; and
- setup remains idempotent.

## Efficiency gate

Compare otherwise identical fixture tasks with event capture/context projection
on and off. Track added commands, repeated context tokens, tool latency, failed
attempts, and time to the next correct action. Any mandatory workflow step that
does not change one of the five decision-relevant state classes is removed.

## Risks and deferrals

- Provider hooks expose different lifecycle events. The shared protocol owns
  semantics; each provider adapter may offer weaker automation with explicit
  capability disclosure.
- Unsupported agents can use CLI operations manually, but manual integration
  is not evidence for the autonomous product claim.

## Handoff probe

Resume a compacted long-running fixture with no transcript and no human input.
The agent must identify the goal, avoid the last failed strategy, resolve the
next live obligation, and reach the controller again without restating
metadata.
