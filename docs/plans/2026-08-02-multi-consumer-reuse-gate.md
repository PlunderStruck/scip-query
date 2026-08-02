# Multi-consumer reuse gate

## Goal

```gherkin
Feature: The final gate checks shared owners found across changed consumers

  Scenario: Several changed consumers retain one established responsibility
    Given each consumer has direct but moderate reuse evidence for the same owner
    When the finished diff is checked
    Then the repeated-owner evidence is reviewed even below the one-off echo threshold
```

## Current flow

`runEchoCheck` uses the general 80% echo threshold before collecting reuse
candidates from changed callables. It later requires at least two changed
consumers to point to the same established owner. Moderate direct candidates
never reach that stronger grouping step, even though `plan-context` can show
them during planning.

## Changes

- Keep the strict configured threshold for one-off echo findings.
- Give the repeated-owner scan a lower candidate floor, then retain its
  existing requirements: direct evidence or 70% similarity, one unchanged
  owner, and at least two changed consumers.
- Exclude a proposed owner when the repository's closed architecture policy
  would forbid the consumer-to-owner dependency.
- Add an end-to-end diff-gate test whose grouped owner evidence is below the
  one-off threshold and whose tempting application-layer owner is forbidden.

## Checks

- Run the focused echo test.
- Run type checking, lint, format checks, and the full test suite.
- Run the final scip-query diff gate once.
