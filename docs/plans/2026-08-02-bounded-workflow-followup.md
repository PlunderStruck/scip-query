# Bounded workflow follow-up

## Goal

```gherkin
Feature: Match verification effort to the size of the coding task

  Scenario: A bounded relational change stays efficient
    Given one coherent change depends on several repository relationships
    When an agent plans, implements, and verifies it in one working context
    Then scip-query supplies the needed evidence without sustained-work ceremony or repeated completion probes
```

## Current evidence

The Luna Max pilot completed the same production task in both arms. The
scip-query arm used 225,272 more pre-edit model tokens and reached its first
stop with two failed predicates. Its Stop gate then found three stale
architecture allowances and the agent repaired them. The transcript ties the
extra context to three skill reads, a duplicated prose-and-JSON plan, repeated
relationship checks, and two identical completion-status probes.

## Changes

- Treat a one-slice relational change as bounded work. It gets one evidence
  packet and one concise readable plan. Durable contracts remain available for
  sustained work that must survive phases or context resets.
- Keep specialist skill entry phase-specific. Planning instructions do not
  require verification instructions before implementation exists.
- Prefer callable source slices over a whole-module slice for the same
  consumer file. Keep the module slice when it is the only useful definition.
- After Stop names local repairs, tell the agent to repair them and stop again.
  Do not direct it to poll completion status before that reevaluation.

## Verification

- Skill text and link checks prove the bounded and sustained routes remain
  usable.
- Plan-context tests prove useful module evidence remains while duplicate
  module-and-callable slices disappear.
- Stop output tests prove local findings lead directly to the next Stop and a
  true external authority boundary still terminates local work.
- The full suite, public API check, and final diff gate protect unrelated
  behavior.

```scip-query-plan
{
  "schemaVersion": 1,
  "form": "compact",
  "goalId": "SQG-12532F1CFF0F0B84E98440E9BC3D352D",
  "changeId": "SQC-1A2415329C13102CED863257667AA0DE",
  "predecessorPlanId": "SQP-18275FF548722BB69976F14F154171F8",
  "class": "relational",
  "seeds": [
    { "id": "skill-route", "kind": "file", "referent": "skills/scip-plan/SKILL.md", "role": "planning effort and durable-state route" },
    { "id": "source-packet", "kind": "symbol", "referent": "buildPlanContextSourcePacket", "role": "bounded source evidence selection" },
    { "id": "stop-output", "kind": "symbol", "referent": "formatStopExecutionEvidence", "role": "local repair and completion handoff instruction" }
  ],
  "preserve": [
    { "condition": "Sustained work can still create durable goals, changes, plans, slices, and obligations", "evidence": ["skills"] },
    { "condition": "A consumer file with no callable definition can still appear in the source packet", "evidence": ["planning-tests"] },
    { "condition": "External protected evaluation remains a terminal local authority boundary", "evidence": ["stop-tests"] }
  ],
  "retire": [
    { "kind": "documentation", "referent": "Relational or sustained work applies", "responsibility": "adding sustained-work ceremony to one-slice tasks", "condition": "Bounded relational work uses a concise readable plan without a durable contract", "evidence": ["skills"] },
    { "kind": "symbol", "referent": "if (!candidate.definition || unique.has(candidate.definition.symbol)) continue", "responsibility": "expanding planning context with overlapping source", "condition": "The packet keeps the most specific useful slice per role and file", "evidence": ["planning-tests"] },
    { "kind": "symbol", "referent": "Inspect: scip-query completion status", "responsibility": "causing repeated status probes before Stop reevaluation", "condition": "Named local repairs lead directly to another Stop", "evidence": ["stop-tests"] }
  ],
  "evidence": {
    "skills": { "description": "Run skill link and generated guidance checks" },
    "planning-tests": { "description": "Run plan-context decision packet and source packet tests" },
    "stop-tests": { "description": "Run Stop output and autonomous action tests" },
    "full": { "description": "Run the full test, lint, build, and API checks" },
    "gate": { "description": "Run the configured final diff gate", "command": "scip-query diff-gate" }
  }
}
```
