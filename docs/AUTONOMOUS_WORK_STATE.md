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

## Collaboration and validation

Commit `.scipquery/goals/*.json`, `.scipquery/changes/*.json`,
`.scipquery/attempts/*.json`, and `.scipquery/decisions/*.json` with the work
they govern. Equivalent goals in two clones have the same content-derived
identity and path. Distinct changes, attempts, and decisions use distinct
idempotency keys and therefore distinct paths. A same-path merge conflict is
not routine branch noise; it means two writers disagreed about one identity
and requires investigation.

Use `goal validate <repository-relative-path>` or
`change validate <repository-relative-path>`, with the corresponding
`attempt validate` and `decision validate` operations, to classify one record.
Status commands classify the complete directories and fail when a record is
malformed, unsupported, or has a broken relationship. Do not delete an
unreadable record merely to make status pass.
