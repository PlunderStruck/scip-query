# scip-hyper-optimization Skill Plan

## Goal

Create a bundled `scip-hyper-optimization` skill for scientific performance
optimization campaigns. The skill must begin by establishing an objective
measurement harness when the target repository does not already have one, then
drive two complementary optimization tracks: trace and tune the current command
pipeline, and evaluate radically different implementations that preserve the
same observable result.

## Evidence

- Source: `scip-query status --capabilities` confirmed this repository has a
  fresh TypeScript index and all required scip-query capabilities.
- Source: `scip-query plan-context src/runtime/setup.ts` showed
  `src/runtime/setup.ts` exports the skill installation surface and is used by
  runtime command handlers.
- Source: `scip-query code 'src/runtime/setup.ts:7-31'` showed
  `BUILTIN_SKILLS` is the built-in skill registry.
- Source: `scip-query refs BUILTIN_SKILLS --json` showed the registry is used
  by `src/runtime/setup.ts:70` and by the `install-skills` command descriptor at
  `src/runtime/commands/command-descriptors.ts:126`.
- Source: `scip-query code 'src/runtime/commands/command-descriptors.ts:123-131'`
  showed the `install-skills` description is generated from
  `BUILTIN_SKILLS.join(', ')`, so adding a registry entry updates the CLI
  description without a second hardcoded list.

## Checklist

- [x] Add `skills/scip-hyper-optimization/SKILL.md` with a measurement-first
      workflow: benchmark harness bootstrap, command ledger creation, current
      pipeline trace, targeted optimization, radical alternative design,
      implementation, corpus verification, and result recording.
      Source: `scip-query plan-context src/runtime/setup.ts`,
      `scip-query code 'src/runtime/setup.ts:7-31'`.
- [x] Add `skills/scip-hyper-optimization/agents/openai.yaml` matching the
      bundled skill metadata pattern.
      Source: existing bundled skill metadata files under
      `skills/*/agents/openai.yaml`; install surface confirmed by
      `scip-query code 'src/runtime/setup.ts:7-31'`.
- [x] Add `'scip-hyper-optimization'` to `BUILTIN_SKILLS` in
      `src/runtime/setup.ts:8-29` so `install-skills` and setup install it.
      Source: `scip-query code 'src/runtime/setup.ts:7-31'`,
      `scip-query refs BUILTIN_SKILLS --json`.
- [x] Add a router row to `skills/scip-query/SKILL.md` so agents that load the
      scip-query router can dispatch hyper-optimization requests to the new
      specialist skill.
      Source: `scip-query plan-context src/runtime/setup.ts` confirmed bundled
      skill installation; router update follows the existing route table in
      `skills/scip-query/SKILL.md`.
- [x] Verify skill packaging and diff safety with typecheck, targeted setup
      tests, `scip-query reindex`, and `scip-query diff-gate --json`.
      Source: `scip-query refs BUILTIN_SKILLS --json`,
      `scip-query code 'src/runtime/commands/command-descriptors.ts:123-131'`.
