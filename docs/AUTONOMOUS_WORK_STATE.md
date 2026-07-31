# Autonomous work state

scip-query keeps the intent for long-running agent work as small, committed
records that survive process exits, clones, branches, and handoffs.

A goal is an authorized repository objective stated as observable behavior.
It says what must become true and what must remain true without prescribing
the implementation. An intended change is one bounded body of work undertaken
for a goal. It names the outcome the agent is trying to produce and gives
retries a stable identity. An attempt is one purposeful action together with
the condition it targeted and the effect actually observed. A decision is the
evidence-based conclusion about what action should follow one or more
attempts. These records preserve causal history: a later agent can tell what
was tried, what happened, and why the next strategy was chosen.

These are not prose progress logs. Plans may be revised as evidence changes;
the committed records are immutable anchors and facts from which current state
is derived.

## Create a goal

Write a temporary request such as:

```json
{
  "feature": "An autonomous coding agent carries an authorized repository change to verified completion",
  "invariants": [
    "Every mandatory action changes state, supplies decision-relevant information, preserves otherwise-lost state, verifies an effect, or preserves a live obligation",
    "Completion remains relative to the authorized goal"
  ],
  "acceptanceScenarios": [
    {
      "name": "Work resumes after process loss",
      "given": ["A prior agent stopped before the goal was complete"],
      "when": ["Another agent reads the committed work state"],
      "then": ["The agent can identify the same goal and intended outcome"]
    }
  ],
  "authorization": {
    "kind": "repository-delegation",
    "principal": "repository-owner",
    "source": "user-request:autonomous-completion"
  }
}
```

Then create the record:

```bash
scip-query goal create --input /path/to/goal-request.json
scip-query goal status
scip-query goal read SQG-...
```

The request schema is
[`schemas/goal-create-request.schema.json`](schemas/goal-create-request.schema.json).
Keep the feature concise, state only invariants that constrain every valid
implementation, and use scenarios for externally observable acceptance. If
the goal's meaning changes, create a new request with `predecessorGoalId`; do
not edit the earlier record.

## Create an intended change

Write a temporary request such as:

```json
{
  "goalId": "SQG-...",
  "idempotencyKey": "autonomous-completion-program-2026-07-30",
  "title": "Autonomous repository completion program",
  "intendedOutcome": "scip-query durably guides and independently verifies long-running agent work"
}
```

Then create the record:

```bash
scip-query change create --input /path/to/change-request.json
scip-query change status
scip-query change read SQC-...
```

The request schema is
[`schemas/intended-change-create-request.schema.json`](schemas/intended-change-create-request.schema.json).
The caller chooses an idempotency key stable across retries. The key is scoped
to the repository collaboration domain: retrying the same request reuses the
record, while using the same key for different work fails.

## Record attempts and decisions

An attempt request names an intended change, the condition the action tried to
establish, the action family, its observed effect, and any version-2
observation receipts it consumed. Its effect class distinguishes a read from a
write that is safe to repeat and a write whose repetition could create another
external effect:

```json
{
  "changeId": "SQC-...",
  "idempotencyKey": "slice-2.2:apply-migration",
  "intendedCondition": "The schema contains the new durable work tables",
  "action": {
    "family": "database-migration",
    "summary": "Apply the durable work-state migration once",
    "effectClass": "non-idempotent-write"
  },
  "evidenceReceipts": [],
  "observedEffect": "The connection ended before the migration acknowledged completion",
  "outcome": "unknown"
}
```

Create and inspect attempts with:

```bash
scip-query attempt create --input /path/to/attempt-request.json
scip-query attempt status SQC-...
scip-query attempt read SQA-...
```

An unknown non-idempotent attempt remains unsafe to repeat. Reconcile it by
creating a later terminal attempt with `reconcilesAttemptId` and at least one
supported observation receipt observed at or after the unknown action. The
original record remains unknown; the deterministic history projection records
the later reconciliation.

A decision names its basis attempts and the next autonomous disposition:

```json
{
  "changeId": "SQC-...",
  "idempotencyKey": "slice-2.2:next-strategy",
  "basisAttemptIds": ["SQA-..."],
  "evidenceReceipts": [],
  "disposition": "change-strategy",
  "rationale": "The first strategy did not establish the intended condition",
  "nextAction": "Use the repository-local migration verifier"
}
```

Create and inspect decisions with:

```bash
scip-query decision create --input /path/to/decision-request.json
scip-query decision status SQC-...
scip-query decision read SQD-...
```

The request schemas are
[`schemas/attempt-create-request.schema.json`](schemas/attempt-create-request.schema.json)
and
[`schemas/decision-create-request.schema.json`](schemas/decision-create-request.schema.json).
Supported workflows should emit these records as side effects of useful
actions and evidence-based choices. Asking an agent to narrate the same work a
second time would be ceremony, not durable state capture.

## Preserve completion obligations

An obligation is a completion condition discovered while doing an intended
change whose truth has not yet been established. Its real referents are
concrete unfinished facts such as an untested failure path, obsolete code that
still has consumers, documentation that still describes removed behavior, or
an architecture rule the new dependency graph must satisfy. What distinguishes
an obligation from a task or attempt is that it remains live until current
evidence establishes that its required condition is fulfilled or that its
premise is false.

Admit an obligation as a side effect of useful work:

```json
{
  "changeId": "SQC-...",
  "idempotencyKey": "slice-2.3:obsolete-adapter",
  "category": "residue",
  "title": "Remove the obsolete adapter",
  "requiredCondition": "The obsolete adapter has no remaining source or consumer",
  "source": {
    "kind": "agent-discovery",
    "referent": "src/obsolete-adapter.ts"
  },
  "basisAttemptIds": [],
  "evidenceReceipts": []
}
```

```bash
scip-query obligation admit --input /path/to/obligation-request.json
scip-query obligation status SQC-...
scip-query obligation read SQO-...
```

The lifecycle is `live -> fulfilled | invalidated | carried-forward`. Every
terminal transition requires a supported version-2 observation receipt
captured after admission. The receipt must identify the same collaboration
domain and complete repository content, and every repository source it read
must have an immutable or fixed-snapshot proof. Unknown, stale, bracketed, or
incompatible evidence cannot make work disappear from the live set.

A carried-forward transition embeds the complete successor obligation in the
same transition record. Closing the predecessor and introducing its successor
therefore survives Git merges as one fact; it does not depend on two filenames
being published atomically. The successor must name another intended change
under the same goal. If branches record different terminal meanings, status
reports a conflict and neither meaning wins by timestamp.

```bash
scip-query obligation transition --input /path/to/transition-request.json
scip-query obligation validate .scipquery/obligation-transitions/SQT-....json
```

The request schemas are
[`schemas/obligation-admission-request.schema.json`](schemas/obligation-admission-request.schema.json)
and
[`schemas/obligation-transition-request.schema.json`](schemas/obligation-transition-request.schema.json).

## Collaboration and validation

Commit `.scipquery/goals/*.json`, `.scipquery/changes/*.json`,
`.scipquery/attempts/*.json`, `.scipquery/decisions/*.json`,
`.scipquery/obligations/*.json`, and
`.scipquery/obligation-transitions/*.json` with the work they govern.
Equivalent goals in two clones have the same content-derived identity and
path. Distinct changes, attempts, decisions, obligations, and transitions use
distinct idempotency keys and therefore distinct paths. A same-path merge
conflict is not routine branch noise; it means two writers disagreed about one
identity and requires investigation.

Use `goal validate <repository-relative-path>` or
`change validate <repository-relative-path>`, with the corresponding
`attempt validate`, `decision validate`, and `obligation validate` operations,
to classify one record. Status commands classify the complete directories and
fail when a record is malformed, unsupported, conflicted, or has a broken
relationship. Do not delete an unreadable record merely to make status pass.
