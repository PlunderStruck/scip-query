# Reuse decision evidence

## Goal

```gherkin
Feature: Planning resolves existing shared owners from their behavior

  Scenario: A changed path duplicates a surfaced shared owner
    Given plan-context shows both implementations
    When the agent chooses whether to reuse the existing owner
    Then current wiring alone cannot justify keeping duplicate ownership
```

## Current flow

`plan-context` finds direct reuse candidates and shared owners near affected
consumers. It shows their source and tells the agent to make a reuse decision.
The planning skill asks for that decision, but it does not state what evidence
can justify separate ownership. An agent can therefore reject an equivalent
owner only because the changed path does not call it yet.

## Changes

- Strengthen the `plan-context` planning note. Require a responsibility and
  behavior comparison. State that current reachability is not semantic
  evidence for separate ownership.
- Put the same rule in the ordinary `scip-plan` workflow, the compact plan
  contract reference, and generated repository instructions.
- Add focused tests for the rendered planning note and generated guidance.

## Checks

- Run the focused planning and setup tests.
- Run the repository type check, lint, format check, and full test suite.
- Run the final scip-query diff gate once.
