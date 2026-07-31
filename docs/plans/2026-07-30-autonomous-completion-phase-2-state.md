# Phase 2 — durable autonomous state

Date: 2026-07-30
Status: planned; depends on Phase 1
Parent: [Autonomous completion execution plan](./2026-07-30-autonomous-completion-execution.md)

## Goal

```gherkin
Feature: Autonomous work survives interruption without losing its reason or history

  Scenario: An agent resumes after compaction or process death
    Given an authorized goal with attempts, decisions, and live obligations
    When a supported agent session is restored
    Then it receives the current goal and the minimum state needed to continue without repeating settled work

  Scenario: Two branches contribute records
    Given separate attempts derived from one intended change
    When both branches merge
    Then immutable records compose without one writer silently erasing the other

  Scenario: An action is retried after an unknown outcome
    Given a prior attempt whose effect may have occurred
    When the agent resumes
    Then the system preserves the unknown outcome and prevents an unsafe duplicate effect
```

## Concepts fixed by this phase

An intended change is one mergeable body of repository work authorized by one
goal. Its referents are the plan, attempts, temporary decisions, and
obligations that travel with a feature branch or pull request. It is wider than
a process session and narrower than permanent project history; the
differentiating fact is that its identity survives branch movement and
collaborative merge until the change is completed or abandoned.

An attempt is an immutable record of one purposeful action and its observed
effect. It is wider than a command log entry because it names the condition the
action tried to move; the distinguishing property is causal continuity, which
lets a later agent distinguish a new strategy from repetition after context
loss.

A completion obligation is a durable, current requirement that must be
reconciled before the intended change may complete. Its referents are affected
tests, docs, residue, architecture edges, migrations, and other consequences
admitted by declared policy. It is wider than a detector finding; the
distinguishing fact is an explicit lifecycle that remains live until evidence
fulfills it, invalidates its premise, or carries it atomically to a successor.

## Current code path and reuse

- `agent-session-state.ts` persists one 24-hour, process-session restoration
  record with the latest stop receipt and unfinished paginated output.
- `revisioned-file.ts` already serializes cooperating writers without lost
  updates.
- `.scipquery/events/*.json` and `.scipquery/suppressions/*.json` already
  demonstrate mergeable immutable shared records.
- generation stores and outcome ledgers already use atomic publication,
  compatibility readers, and bounded retention.

Do not expand the short-lived session cache into the canonical project ledger.
Reuse its restoration adapter to point at canonical shared records.

## Slices

### 2.1 Goal and intended-change identity

Anchor and current behavior:

- no canonical goal exists outside prose plans and prompts;
- session identity and absolute project path do not survive clone or branch
  collaboration.

Exact change:

- add a versioned committed goal record under `.scipquery/goals/`;
- store one concise Gherkin feature, invariant rules, acceptance scenarios,
  authorization metadata, collaboration domain, and immutable goal identity;
- add an intended-change record under `.scipquery/changes/` that references the
  goal and uses an opaque stable ID rather than branch name; and
- expose create/read/validate/status operations that are idempotent and
  scriptable.

Validation and expected result:

- formatting-only or metadata-only edits do not silently change goal identity;
- a semantic goal revision creates a successor rather than overwriting
  history;
- two clones read the same committed goal/change identity; and
- malformed, future, and legacy versions receive explicit compatibility
  outcomes.

### 2.2 Append-only attempts and decisions

Anchor and current behavior:

- outcome events are immutable, but agent actions and why a strategy changed
  are not durably connected to the goal.

Exact change:

- add immutable attempt and decision records keyed by opaque event IDs and
  idempotency keys;
- record intended condition, action family, consumed evidence receipts,
  observed effect, outcome `succeeded | failed | unknown`, and successor
  decision;
- publish with create-if-absent semantics; and
- derive current summaries by folding immutable records in deterministic order.

Validation and expected result:

- replaying one idempotency key creates no duplicate effect record;
- concurrent writers preserve both distinct records;
- an unknown action outcome remains unknown until reconciled by current
  observation; and
- merging branches with distinct attempts is conflict-free by filename.

### 2.3 Obligation lifecycle

Anchor and current behavior:

- findings and suppressions persist, but no shared lifecycle connects a
  consequence to one intended change.

Exact change:

- add immutable obligation admission and transition records;
- use a closed lifecycle:
  `live -> fulfilled | invalidated | carried-forward`;
- require current evidence and reason codes for every terminal transition;
- derive current obligation state from the event fold; and
- reject terminal-to-live resurrection except through a new obligation.

Validation and expected result:

- no live obligation disappears through overwrite, merge order, or compaction;
- unknown evidence cannot close an obligation;
- carry-forward creates the successor and closes the predecessor atomically in
  one transition record; and
- terminal conflicts are exposed rather than resolved by last-writer-wins.

### 2.4 Restoration projection

Anchor and current behavior:

- post-compaction context restores pagination and the latest stop attempt only.

Exact change:

- project the canonical goal/change ledger into a bounded restoration summary;
- include current goal, last distinct failed/unknown attempts, settled
  decisions, live obligations, and exact continuation commands;
- record a summary cursor so unchanged state is not repeated at every hook;
  and
- preserve links to full records rather than truncating their meaning.

Validation and expected result:

- a restored agent can state the goal, current condition, last attempted
  strategy, and every live obligation without transcript access;
- the summary stays within a pre-registered byte/token budget; and
- unchanged hooks add no repeated context.

## Durability and concurrency gate

Before implementation, load the durability, concurrency, and distributed-data
lenses. Test atomic publish, crash before/after rename, partial files,
duplicate delivery, stale readers, concurrent distinct writers, same-ID
collision, branch merge, and forward-version handling.

The canonical source is the append-only shared record set. Session cache,
rendered summary, and derived current state are reconstructable projections.

## Risks and deferrals

- Git cannot make two writers choose the same filename conflict-free. Opaque
  random event IDs and create-if-absent publication make collisions
  negligible; a collision with different content is an explicit integrity
  error.
- Goal authorization identity may initially be a repository-local delegation
  record rather than a cryptographic human signature. Phase 3 protects its use
  during evaluation; stronger signing is deferred until a real trust boundary
  requires it.

## Handoff probe

Kill an agent after recording an action with an unknown outcome, resume in a
fresh process, and prove that the next autonomous decision neither repeats the
unsafe action nor asks a human to restate the goal.
