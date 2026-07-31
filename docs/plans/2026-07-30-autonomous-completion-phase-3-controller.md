# Phase 3 — protected completion controller

Date: 2026-07-30
Status: in progress; slices 3.1 through 3.3 complete
Parent: [Autonomous completion execution plan](./2026-07-30-autonomous-completion-execution.md)

## Goal

```gherkin
Feature: Completion is a protected state transition, not an agent assertion

  Scenario: All required conditions are established
    Given one authorized goal and a fixed evaluation context
    When current evidence fulfills every required predicate and no obligation is live
    Then the intended change transitions exactly once to complete

  Scenario: A judgment artifact changes in the candidate work
    Given the candidate modifies a goal, policy, evaluator, test, baseline, suppression, or configuration used by its gate
    When completion is evaluated
    Then that artifact cannot alone supply the authority that accepts its own change

  Scenario: A pre-authorized successor is valid
    Given repository policy permits a named transition with protected invariants
    When the candidate satisfies that transition rule
    Then evaluation continues against the successor without a human approval prompt
```

## Concepts fixed by this phase

A completion evaluation is an immutable judgment record connecting one
intended change, one authorized goal version, one policy version, one evaluator
version, one fixed target state, and the evidence used to decide it. It is
wider than a gate exit code; the differentiating property is reproducibility,
which prevents later edits from changing what an earlier pass meant.

A protected judgment artifact is any candidate-editable input capable of
changing whether the same candidate passes. Its referents include goals,
transition rules, evaluator code, tests, baselines, suppressions, and
configuration. It is wider than a test file; the distinguishing cause is
reflexive authority—the artifact would otherwise be able to approve itself.

A transition rule is pre-authorized repository policy describing when one goal
or judgment artifact version may succeed another while preserving named
invariants. It is wider than an approval bypass; its distinguishing property is
delegated, checkable authority established before the candidate evaluation.

## Current code path and reuse

- `handleAgentHookStop()` is the existing completion choke point.
- `runIsolatedStopHookDiffGate()` already enforces deadlines and isolates the
  expensive gate.
- stop evidence leases bind one generation and worktree observation.
- `diffGateFailedClosed()` and structured suppression adjudication already
  distinguish findings, policy escalation, and unresolved execution.

Keep the hook as an adapter. Put state-transition decisions in a pure controller
that receives immutable goal, policy, target, obligation, and evidence inputs.

## Slices

### 3.1 Typed evaluation state machine

Exact change:

- add explicit `pending | evaluating | blocked | complete | superseded`
  evaluation variants with state-specific fields;
- define required predicates for goal fulfillment, invariant preservation,
  evidence compatibility, coverage, live obligations, and policy permission;
- make unknown required predicates block without being mislabeled false; and
- emit an immutable evaluation record and idempotent completion transition.

Expected validation:

- illegal combinations are unrepresentable;
- identical retries produce one completion event;
- every non-pass output names unsatisfied predicates and evidence reasons; and
- the hook renders controller results without re-deciding them.

### 3.2 Fixed evaluation context

Exact change:

- capture the goal, policy, evaluator build identity, command registry,
  protected-artifact set, and target observation before evaluation;
- execute all completion checks against that captured context;
- reject or retry if a required target source changes during evaluation; and
- store the context identity in the evaluation record.

Expected validation:

- a mid-evaluation source change cannot yield pass;
- replay against the same context yields the same pure decision; and
- a future reader can distinguish the evaluated candidate from the later
  repository.

Execution result:

- the stop adapter captures and durably publishes one content-addressed
  context snapshot for each current intended change;
- the context fixes the complete goal record, policy, evaluator entrypoint
  build, diff-gate registry, protected-artifact rules, and whole-repository
  target before isolated evaluation;
- a second fixed observation and evaluator hash must match before any
  controller record is published; and
- controller output directories are excluded from candidate-content identity,
  preventing repeated Stop calls from manufacturing endless novel contexts.

### 3.3 Reflexive-authority firewall

Exact change:

- compute which protected artifacts changed in the candidate;
- partition supporting evidence into candidate-controlled and externally fixed
  or predecessor-authorized sources;
- prevent a changed artifact from being the sole authority for its own
  acceptance; and
- give each protected class a bootstrap or predecessor rule.

Expected validation:

- adding a permissive test, baseline, suppression, config, or evaluator branch
  does not turn a failing candidate into a pass by itself;
- legitimate code plus test changes can pass through independent behavioral
  and predecessor-policy evidence; and
- the decision explains the exact reflexive dependency.

Execution result:

- one versioned `SQA-...` assessment partitions exact Git-overlay paths into
  candidate-controlled protected classes and fixed or explicitly authorized
  referents;
- evaluator protection follows the actual executable boundary: external
  installations do not claim target source, while a checkout-local built
  evaluator protects its entrypoint, source tree, and build inputs;
- the assessment is identity-bound, canonicalized, persisted with each new
  evaluation, and optional only so earlier schema-version-1 records remain
  readable;
- the pure firewall changes an otherwise established predicate to `unknown`
  when the same changed artifact would supply its only authority, while
  preserving a `disproven` predicate and its contrary evidence;
- the Stop controller declares its actual current reliances: goal and
  evaluator always, configuration for coverage and policy, baseline when that
  check ran, and suppression only when a suppression was used; and
- mutation tests cover every protected class, a predecessor-authorized
  exception, record tampering, no-predecessor failure, and the full evaluator
  effect across all six predicates.

### 3.4 Autonomous successor transitions

Exact change:

- add versioned transition rules with predecessor, permitted fields,
  invariants, required evidence qualifications, and successor identity;
- evaluate them under the fixed predecessor context;
- atomically supersede the old goal/policy and create the successor; and
- retain the transition evaluation as shared history.

Expected validation:

- permitted maintenance evolves goals and baselines without prompts;
- unlisted weakening remains blocked;
- conflicting successor transitions are explicit; and
- crash recovery cannot leave both predecessor and successor current.

## Verification gate

Use model-based state-machine tests plus real stop-hook integration. Protect
the evaluator fixtures outside candidate diffs. Run mutation tests that attempt
to self-approve through each artifact class. Measure the ordinary no-finding
stop path and require no new agent command.

## Risks and deferrals

- “Independent” evidence is contextual, not synonymous with external service.
  A fixed predecessor artifact or repository observation can be independent of
  the candidate dimension it judges.
- Cryptographic remote attestation is not required for the local agent threat
  model. The controller must nevertheless make its trust roots explicit so it
  can be strengthened later without changing completion semantics.

## Handoff probe

Give the candidate full permission to edit this repository, including its
tests and gate code, and demonstrate that it still cannot produce completion
without satisfying one protected externally distinguishable scenario.
