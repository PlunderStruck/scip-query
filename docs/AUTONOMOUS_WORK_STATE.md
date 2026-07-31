# Autonomous work state

scip-query keeps the intent for long-running agent work as small, committed
records that survive process exits, clones, branches, and handoffs.

A goal is an authorized repository objective stated as observable behavior.
It says what must become true and what must remain true without prescribing
the implementation. An intended change is one bounded body of work undertaken
for a goal. It names the outcome the agent is trying to produce and gives
retries a stable identity.

These are not plans or progress logs. Plans may be revised as evidence changes;
goals and intended changes are immutable anchors that let later phases ask
whether the work still serves the same objective.

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

## Collaboration and validation

Commit `.scipquery/goals/*.json` and `.scipquery/changes/*.json` with the work
they govern. Equivalent goals in two clones have the same content-derived
identity and path. Distinct intended changes use distinct idempotency keys and
therefore distinct paths. A same-path merge conflict is not routine branch
noise; it means two writers disagreed about one identity and requires
investigation.

Use `goal validate <repository-relative-path>` or
`change validate <repository-relative-path>` to classify one record. Status
commands classify the complete directories and fail when a record is
malformed, unsupported, or refers to a missing goal. Do not delete an
unreadable record merely to make status pass.

