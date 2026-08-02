# Evidence-to-completion efficiency

## Goal

```gherkin
Feature: Repository evidence produces complete work with bounded effort

  Scenario: An agent continues an active repository change
    Given the repository has active work and compiler-resolved evidence
    When the agent plans, implements, and reviews the change
    Then it reuses the active work, resolves shared ownership, and receives one actionable completion result
```

## Current flow

`applyPlanContract` compiles the compact form by creating an inline goal and
change. The compact decoder rejects existing `goalId` and `changeId` values.
Thus, a restored change cannot use the short form.

`planContext` treats a path as a file-only target. It skips the symbol graph,
even when the file contains one clear exported callable. The packet then names
files but does not supply the symbol flow or compact source evidence.

Reuse obligations exist only for owners that the plan includes. Discovery can
name a strong owner and the plan can omit it without an explicit rejection.
Stop can then report controller authority as if another local command can fix
it.

## Decisions

- Keep the strict v1 stored records as the one durable format.
- Extend the compact input only. Existing strict inputs remain valid.
- Continue active work only with explicit `goalId` and `changeId` values.
- Require a disposition for each high-confidence owner that planning reports.
- Resolve a file to a callable only when the choice is unambiguous.
- Keep source evidence bounded and disclose every omitted unit.
- Distinguish a local repair from an external completion authority.

## Contract

```scip-query-plan
{
  "schemaVersion": 1,
  "goalId": "SQG-12532F1CFF0F0B84E98440E9BC3D352D",
  "changeId": "SQC-1A2415329C13102CED863257667AA0DE",
  "workflowClass": "sustained",
  "predecessorPlanId": "SQP-BB1236038C8CB62F2720A7ACC8BF3CC6",
  "affectedSeeds": [
    {
      "id": "plan-compiler",
      "kind": "symbol",
      "referent": "applyPlanContract",
      "role": "compact plan compiler and active-work continuation boundary"
    },
    {
      "id": "planning-packet",
      "kind": "symbol",
      "referent": "planContext",
      "role": "bounded flow, owner, and source evidence packet"
    },
    {
      "id": "reuse-verifier",
      "kind": "symbol",
      "referent": "planReuseAuthority",
      "role": "shared-owner completion verifier"
    },
    {
      "id": "stop-output",
      "kind": "symbol",
      "referent": "renderStopHookOutput",
      "role": "next repair or external handoff boundary"
    }
  ],
  "preserve": [
    {
      "id": "strict-records",
      "condition": "Existing strict v1 plan inputs and stored records remain valid",
      "evidenceIds": ["plan-tests", "api"]
    },
    {
      "id": "bounded-evidence",
      "condition": "Planning source and graph evidence obeys disclosed fixed bounds",
      "evidenceIds": ["planning-tests"]
    },
    {
      "id": "fail-closed",
      "condition": "Ambiguous symbol ownership and unknown completion authority remain explicit",
      "evidenceIds": ["planning-tests", "completion-tests"]
    },
    {
      "id": "fixture-neutral",
      "condition": "Product logic uses repository evidence without task-specific names or expected patches",
      "evidenceIds": ["focused-tests"]
    }
  ],
  "retirements": [
    {
      "id": "duplicate-active-work",
      "kind": "responsibility",
      "referent": "compact plan input always creates a new goal and change",
      "responsibility": "forcing restored work to create duplicate durable records",
      "condition": "Compact input can continue explicit current goal and change identities without creating replacements",
      "evidenceIds": ["plan-tests"]
    },
    {
      "id": "file-only-planning",
      "kind": "responsibility",
      "referent": "source path planning omits an unambiguous primary callable",
      "responsibility": "making the agent repeat symbol discovery and source reads",
      "condition": "A file target with one clear callable includes that callable's bounded flow and source packet",
      "evidenceIds": ["planning-tests"]
    },
    {
      "id": "implicit-owner-omission",
      "kind": "responsibility",
      "referent": "a reported direct reuse owner can disappear from the plan",
      "responsibility": "allowing discovered shared ownership evidence to have no completion consequence",
      "condition": "Each reported direct owner has a stored reuse or evidence-backed rejection disposition",
      "evidenceIds": ["plan-tests", "completion-tests"]
    },
    {
      "id": "authority-probing",
      "kind": "responsibility",
      "referent": "external completion authority appears as a local repair",
      "responsibility": "causing repeated status and help commands after local work is complete",
      "condition": "Stop gives one terminal handoff when no local repair remains",
      "evidenceIds": ["completion-tests"]
    }
  ],
  "allowedSurvivors": [],
  "reuseAuthorities": [],
  "architecture": [
    {
      "id": "architecture",
      "condition": "The configured architecture policy remains clean and minimal",
      "evidenceIds": ["gate"],
      "predicate": "configured-policy-clean"
    }
  ],
  "completionEvidence": [
    {
      "id": "api",
      "description": "Check the public TypeScript API"
    },
    {
      "id": "completion-tests",
      "description": "Run completion action and Stop output tests"
    },
    {
      "id": "focused-tests",
      "description": "Run all changed workflow test files"
    },
    {
      "id": "gate",
      "description": "Run the configured final diff gate once"
    },
    {
      "id": "plan-tests",
      "description": "Run plan decoder, compiler, and obligation tests"
    },
    {
      "id": "planning-tests",
      "description": "Run file-target resolution, decision packet, and source packet tests"
    }
  ],
  "slices": [
    {
      "id": "active-continuation",
      "outcome": "Compact plans continue explicit current work without duplicate records",
      "evidenceIds": ["plan-tests"],
      "dependsOn": []
    },
    {
      "id": "owner-dispositions",
      "outcome": "Strong discovered owner candidates receive stored and checked dispositions",
      "evidenceIds": ["plan-tests", "completion-tests"],
      "dependsOn": ["active-continuation"]
    },
    {
      "id": "planning-packet",
      "outcome": "File targets return one bounded callable flow and compact source packet when unambiguous",
      "evidenceIds": ["planning-tests", "api"],
      "dependsOn": ["owner-dispositions"]
    },
    {
      "id": "terminal-handoff",
      "outcome": "Stop separates actionable local repairs from externally owned completion authority",
      "evidenceIds": ["completion-tests", "focused-tests"],
      "dependsOn": ["planning-packet"]
    },
    {
      "id": "verification",
      "outcome": "The complete change passes public checks and the final gate",
      "evidenceIds": ["api", "focused-tests", "gate"],
      "dependsOn": ["terminal-handoff"]
    }
  ]
}
```
