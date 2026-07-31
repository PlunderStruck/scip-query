# Phase 4 — repository completeness

Date: 2026-07-30
Status: in progress; slice 4.1 complete
Parent: [Autonomous completion execution plan](./2026-07-30-autonomous-completion-execution.md)

## Goal

```gherkin
Feature: Completion reconciles the affected repository, including residue and structure

  Scenario: Replaced behavior leaves a plausible obsolete path
    Given qualified evidence ties the path to the intended change
    When repository policy admits it as a completion obligation
    Then completion remains blocked until the path has a current role or is removed

  Scenario: A dependency violates declared architecture
    Given a repository rule forbids the dependency and covers both files
    When the candidate introduces the edge
    Then the architecture obligation blocks completion

  Scenario: A descriptive signal is uncertain
    Given a heuristic has no declared obligation policy or required evidence authority
    When it reports possible residue
    Then it remains visible but cannot block completion
```

## Concepts fixed by this phase

Residue is a repository artifact that still plausibly communicates or enables
an alternative made obsolete by the intended change and has no evidenced
current role. Its referents include unwired implementations, obsolete flags,
stale adapters, duplicate registrations, superseded docs, and tests that only
preserve removed behavior. It is wider than compiler-detectable dead code; the
distinguishing fact is misleading causal availability, which can steer a later
agent into restoring behavior the repository no longer intends.

An architecture rule is repository policy over allowed structural
relationships among declared code units. Its referents are boundary
membership, permitted dependency directions, limits, and test-placement rules.
It is wider than a diagram or inferred cluster; the distinguishing property is
normative force—violating a covered declared relationship is forbidden rather
than merely unusual.

Obligation admission is the versioned policy decision that turns qualified
evidence into a live completion requirement for one intended change. It is
wider than detector severity; its distinguishing property is traceable
relevance to the goal and affected surface.

## Current code path and reuse

- `architecture()` already distinguishes declared policy coverage, forbidden
  and undeclared edges, cycles, limits, stale allowances, ambiguous files, and
  coarse descriptive boundaries.
- `runArchitectureCheck()` already promotes enforceable architecture findings
  into the diff gate.
- cleanup detectors cover new dead code, stale abstractions, incomplete
  migrations, wrappers, echoes, tests, and doc drift with evidence/action
  tiers.
- suppression adjudication and outcome events already retain factual
  dispositions.

Do not create a second architecture engine. Build obligation admission over
the existing typed reports and make normative versus descriptive status
explicit.

## Slices

### 4.1 Obligation admission contract

Exact change:

- define admission rules over finding identity, intended-change relevance,
  claim qualifications, policy version, and action tier;
- return `admit | advisory | insufficient-evidence | out-of-scope` with reasons;
- create obligation records only for `admit`; and
- preserve advisory evidence without forcing a disposition ritual.

Expected validation:

- the same detector result can be blocking under one declared policy and
  advisory under another without changing its factual payload;
- unknown state authority never admits a blocking obligation; and
- duplicate observations update evidence without duplicating obligations.

Execution result:

- added a pure, versioned admission decision that preserves the detector fact
  while classifying it as `admit`, `advisory`, `insufficient-evidence`, or
  `out-of-scope`;
- made policy, intended-change relevance, independent claim qualification,
  action authority, and the fixed observation receipt explicit inputs;
- persisted every decision as a mergeable `SQCA` record while creating a live
  obligation only for `admit`;
- keyed obligations by change, policy, rule, and finding so repeated
  observations retain fresh evidence without duplicating required work; and
- verified the domain and storage contracts, CLI/status decoding, setup and
  uninstall behavior, public API compatibility, lint, and all 2,320 tests.

SCIP verification found no declared architecture violation or recent
reimplementation. The unbounded migration scan reported the intentional
admission-storage wrapper that refreshes evidence while reusing one obligation;
the ordinary storage creator cannot replace it because its request identity
includes the refreshed receipt. The diff gate passes with only advisory
same-name signals for two record-specific validators.

### 4.2 Architecture obligations

Exact change:

- classify forbidden covered edges, covered boundary limits, stale allowances,
  and test-boundary violations as enforceable candidates;
- keep inferred coarse boundaries and undeclared relationships descriptive
  unless policy explicitly promotes them;
- tie each admitted edge to source/target files and the target observation; and
- require current absence or authorized transition evidence to close it.

Expected validation:

- strict repository structure is enforced exactly where declared;
- ambiguous or uncovered files fail visibly according to policy rather than
  being silently treated allowed;
- removing an edge closes the obligation only against current evidence; and
- baseline writing cannot self-approve a new forbidden edge.

### 4.3 Residue evidence and current-role proof

Exact change:

- add change-relative residue candidates from removed registrations, replaced
  entry-to-effect paths, migration leftovers, newly unreferenced symbols,
  obsolete docs/tests/config, and surviving alternatives;
- require a referent-specific current-role proof to invalidate a candidate;
- admit only candidates meeting declared confidence and relevance thresholds;
  and
- record “not detected” as bounded coverage, never universal absence.

Expected validation:

- a still-callable but no-longer-wired implementation is detectable in a
  protected fixture;
- a compatibility shim with consumer and policy evidence is not residue;
- an unrelated old smell does not become an obligation for the current change;
  and
- deleting a candidate without verifying affected consumers does not
  automatically establish completeness.

### 4.4 Completion reconciliation

Exact change:

- run admission on changed-state triggers and at completion;
- fold new and existing obligations into the Phase 3 controller;
- close only through fulfillment, factual invalidation, or atomic carry-forward;
  and
- present the smallest actionable root-cause groups to the agent.

Expected validation:

- a phase may pass tests while completion remains blocked on residue or
  architecture;
- every live obligation has one current reason and evidence path;
- resolving a root cause closes its dependent obligations without repeated
  ceremony; and
- no advisory-only finding prevents completion.

## Verification gate

Use protected before/after repository fixtures for feature replacement,
compatibility retention, architecture violation, policy transition, and
unrelated legacy smells. Run architecture, cleanup, diff-gate, and obligation
fold tests. Measure false blocking and detector cost separately.

## Risks and deferrals

- Residue detection is necessarily incomplete. The product claim is bounded
  reconciliation under declared producers and coverage, not proof that no
  conceivable obsolete artifact exists.
- Architecture enforcement can be strict only where unit membership and rules
  are declared. Uncovered structure must be disclosed, not fabricated.

## Handoff probe

Overhaul a fixture feature while leaving its old implementation callable but
unwired. Tests for the new behavior must pass, yet completion must remain
blocked until the old path is removed or given an evidenced current role.
