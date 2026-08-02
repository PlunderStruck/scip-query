# Token-efficient agent workflow

Status: implementation complete; terminal verification follows this frozen plan

## Goal

scip-query should replace uncertain repository exploration with fresh, compact
evidence. It should not make a coding agent operate the index, restate the same
facts in several formats, or run verification before a coherent edit exists.

Done means:

- evidence commands internally obtain a source-fresh index or fail in that
  same command with one exact cause;
- the normal agent path never asks the model to poll, sleep, or manually
  reindex;
- one planning query supplies the decision packet for a normal relational
  change;
- the readable plan stays concise while the CLI derives durable record
  structure;
- repeated or final checks are selected by missing evidence, not by ritual;
- existing JSON contracts and repository records remain compatible.

## Current flow

`src/runtime/cli.ts` prepares a shared generation, starts or reuses the watch
service, and then immediately runs the requested command. If the index remains
stale, the command can still open it. Skills therefore tell the agent to run
`status`, wait, run `status` again, and sometimes run `reindex`.

`plan-context` already composes graph, flow, impact, reuse, surface, and history
evidence, but its default renderer exposes the full component report. The
planning skill then asks the model to restate much of that evidence in prose
and manually author the full durable-record schema.

The frozen retry-policy transcript showed the consequence: the control edited
source after 94,651 model tokens; the scip-query condition edited source after
610,432. The scip-query agent loaded 555 skill lines, wrote a plan over five
times larger, retried plan compilation, and managed index refresh itself.

## Affected consumers

- `src/runtime/cli.ts` and `src/runtime/cli-context.ts`: evidence-command
  preflight and database selection.
- `src/runtime/watch-service.ts`, `src/runtime/agent-hooks.ts`, and reindex
  support: refresh ownership, waiting, and fallback.
- `src/runtime/query-commands/planning.ts` and
  `src/queries/impact/plan-context.ts`: the default planning packet.
- `src/change-control/plan-contract.ts`,
  `src/runtime/plan-contract-compiler.ts`, and plan command handlers: concise
  input normalization into existing durable records.
- `src/runtime/agent-setup.ts`, `AGENTS.md`, and `skills/scip-*`: the instructions
  injected into model context.
- CLI, freshness, plan compiler, planning, hook, setup, and skill contract
  tests.

## Reuse decision

- Extend the existing CLI pre-action and reindex implementation. Do not create
  a second index builder.
- Extend `plan-context` as the single planning query. Do not add another
  discovery command.
- Normalize a compact plan input into the existing version-1 plan request and
  records. Do not create a parallel durable plan format.
- Keep uncommon protocol and recovery details as disclosed skill references.
  The main skills retain only the actions every ordinary run needs.
- Reuse the existing Stop gate and direct test evidence. Do not add a second
  fixed verification battery.

## Slices

1. Make evidence-command freshness internal and single-flight. Validate fresh,
   missing, active-watcher, budget-paused, explicit-index, and failed-refresh
   paths.
2. Make `plan-context` render a compact decision packet by default, with the
   full component report available explicitly. Validate that the packet names
   flow, consumers, reuse, risk, coverage, and next reads.
3. Accept a compact plan contract and normalize it into the existing immutable
   plan, goal, change, and obligation records. Preserve the full input form.
4. Compress router, planning, and verification skills; remove model-operated
   freshness and baseline-test ceremony; keep rare details behind precise
   context pointers.
5. Add token-efficiency regression facts to the private runner and run focused
   tests, the public suite, API/lint checks, and one final diff gate.

## Risks and unknowns

- A synchronous fallback reindex can increase one command's wall time. That is
  acceptable when it replaces several model turns, but it must coordinate with
  the watcher rather than race it.
- Compact output must not hide bounded coverage. It must say what is complete,
  what is capped, and which follow-up is justified.
- Compact plan syntax is authoring shorthand only. Stored records and their
  identities remain fully explicit.
- The completed implementation can prove lower workflow overhead mechanisms;
  only a later matched trial can measure the actual token reduction.

## Implementation result

- Evidence commands now reuse a fresh generation, briefly wait for an active
  watcher, or perform one lazy-loaded synchronous refresh inside the same
  command. Stop uses the same path.
- `plan-context` now returns a compact decision packet by default. `--detail`
  retains the old report, and JSON output remains unchanged.
- `plan apply --input` accepts `form: "compact"` and expands it into the
  existing strict version-1 records.
- The router, planning, and verification skills fell from 562 lines to 296
  lines while keeping the essential workflow and failure recovery.
- The private runner now records pre-edit tokens, model cycles, tool calls,
  scip-query calls, plan timing, and plan size for each condition.
- Focused checks, all 2,490 public tests, formatting, lint, build, API checks,
  dependency audit, skill-link checks, and all 24 private runner tests passed.
- The complete diff-impact report was reviewed against the planned runtime,
  query, contract, skill, documentation, and test surfaces. The single terminal
  diff gate follows this frozen note.

```scip-query-plan
{
  "schemaVersion": 1,
  "goal": {
    "feature": "scip-query supplies fresh repository evidence without making coding agents operate its machinery",
    "invariants": [
      "Evidence commands do not silently use stale source relationships",
      "Direct work remains free of durable planning ceremony",
      "Existing durable records remain readable"
    ],
    "acceptanceScenarios": [
      {
        "name": "Evidence is ready in one action",
        "given": ["Repository source changed after the last index generation"],
        "when": ["An agent runs a compiler-evidence command"],
        "then": ["The command waits for or performs refresh internally and returns evidence from the resulting fresh generation"]
      },
      {
        "name": "Planning is compact",
        "given": ["A relational change needs consumer and reuse evidence"],
        "when": ["The agent prepares and applies its plan"],
        "then": ["One planning packet and one concise contract are sufficient before source editing"]
      }
    ],
    "authorization": {
      "kind": "repository-delegation",
      "principal": "repository-owner",
      "source": "authorized user request"
    }
  },
  "change": {
    "idempotencyKey": "token-efficient-agent-workflow-v1",
    "title": "Make the scip-query agent workflow token-efficient",
    "intendedOutcome": "Freshness, planning, and verification work happen in the tool with compact model-facing evidence"
  },
  "workflowClass": "sustained",
  "affectedSeeds": [
    { "id": "cli-preflight", "kind": "symbol", "referent": "prepareWorktreeIndex", "role": "evidence-command index preflight" },
    { "id": "planning-packet", "kind": "symbol", "referent": "planContext", "role": "composite pre-edit evidence owner" },
    { "id": "plan-compiler", "kind": "symbol", "referent": "applyPlanContract", "role": "durable plan compiler" },
    { "id": "agent-setup", "kind": "symbol", "referent": "setupAgent", "role": "repository instruction installer" }
  ],
  "preserve": [
    { "id": "fresh-evidence", "condition": "Compiler graph claims use a source-fresh generation", "evidenceIds": ["freshness-tests", "gate"] },
    { "id": "record-compatibility", "condition": "Existing full plan inputs and stored records remain compatible", "evidenceIds": ["plan-tests", "api"] },
    { "id": "output-contracts", "condition": "Programmatic JSON output retains its stable contract", "evidenceIds": ["cli-tests", "api"] }
  ],
  "retirements": [
    { "id": "manual-freshness-loop", "kind": "responsibility", "referent": "agent-managed status wait reindex loop", "responsibility": "making the model operate index freshness", "condition": "Ordinary evidence instructions no longer require status polling or manual reindex", "evidenceIds": ["skill-tests", "freshness-tests"] },
    { "id": "full-skill-preload", "kind": "responsibility", "referent": "preloading final-stage and rare protocol instructions", "responsibility": "loading instructions before they can affect a decision", "condition": "Main skills contain only ordinary-path actions and precise conditional pointers", "evidenceIds": ["skill-tests"] }
  ],
  "allowedSurvivors": [],
  "reuseAuthorities": [],
  "architecture": [
    { "id": "architecture", "predicate": "configured-policy-clean", "condition": "The configured architecture policy remains clean", "evidenceIds": ["gate"] }
  ],
  "completionEvidence": [
    { "id": "freshness-tests", "description": "Run CLI context, watch service, hook lease, and transparent freshness tests" },
    { "id": "plan-tests", "description": "Run plan contract decoder, compiler, storage, and compatibility tests" },
    { "id": "cli-tests", "description": "Run planning renderer and CLI contract tests" },
    { "id": "skill-tests", "description": "Run generated skill, setup, link, and instruction-size checks" },
    { "id": "api", "description": "Run build, type checking, and public API checks" },
    { "id": "gate", "description": "Run the configured final diff gate once" }
  ],
  "slices": [
    { "id": "freshness", "outcome": "Evidence commands internally obtain one fresh generation without model polling", "evidenceIds": ["freshness-tests"], "dependsOn": [] },
    { "id": "planning", "outcome": "One compact plan-context packet replaces repeated graph and source enumeration", "evidenceIds": ["cli-tests"], "dependsOn": ["freshness"] },
    { "id": "contract", "outcome": "Concise plan input compiles into the existing complete durable record", "evidenceIds": ["plan-tests", "api"], "dependsOn": ["planning"] },
    { "id": "skills", "outcome": "Ordinary agent instructions are short and omit freshness and premature verification ceremony", "evidenceIds": ["skill-tests"], "dependsOn": ["contract"] },
    { "id": "verification", "outcome": "The complete efficiency change passes public contracts and the final gate", "evidenceIds": ["api", "gate"], "dependsOn": ["skills"] }
  ]
}
```
