# Require existing flows and reuse in plans

## Outcome and current behavior

The user reported that an agent planning a LaunchPoint backend change created a parallel implementation despite an existing central implementation path. This checkout does not contain the failed agent trace, so that report does not establish whether graph evidence was missing or the agent failed to investigate it.

The current `skills/scip-plan/SKILL.md` asks for current owners, patterns and contracts in a short general instruction. It does not require a recorded end-to-end map or a concrete reuse assessment before proposed implementation steps. `skills/scip-plan/agents/openai.yaml` likewise describes owners and checks without naming existing conventions or reuse.

## Existing flow and conventions

- The canonical planning instructions live in `skills/scip-plan/SKILL.md`; its agent metadata selects that workflow and supplies the default prompt.
- `$scip-query` owns query mechanics. `$scip-explore` already requires evidence for the actual initiating surface, live owner, decisions, state changes, runtime handoffs, results and recovery. Reuse that workflow rather than introducing another exploration skill.
- The package includes skill Markdown and agent YAML through `package.json`'s existing `files` entries. `install-skills` installs the six workflows into agent roots.
- SSH alias `dev-agent` connects as `launchpoint-agent`, UID 1002. Its canonical installation is `/home/launchpoint-agent/.local/lib/node_modules/scip-query`; the executable resolves to that package's `dist/cli.js`. Verify the active Codex/Claude planning-skill targets before updating them.

## Changes and reuse decisions

1. Strengthen the existing planning skill, preserving its shared mechanics and exploration links. Require the affected existing flow and comparable features to be established before choosing a design.
2. Require the written plan to record the live flow, exact owners and consumers, conventions backed by comparable features, concrete reuse/extension choices, and the reason for any new owner or parallel path.
3. Require validation through a real consumer that can detect bypassing the established registration, policy or persistence path. Recheck the implemented flow against the recorded plan during diff review.
4. Update the existing agent metadata to advertise these requirements. Do not add an overlapping skill or require arbitrary counts of examples, tests or tool queries.
5. Check skill links, packaging/metadata and relevant existing tests; no agent benchmarks are required.
6. Back up the installed planning skill, sync the updated canonical files into the existing package on `dev-agent`, run its installer, and verify byte identity through the actual agent skill paths.

## Verification and unresolved scope

Record the local checks, installed file hashes and resolved VM paths below after verification. This work strengthens the planning procedure; it does not prove the original LaunchPoint failure was caused solely by the skill or guarantee every future agent will follow it. An unavailable relationship must remain an explicit gap, not a reason to invent a second implementation.

The already-authorized dead-code cleanup remains active and has passed its focused tests, type checks, build and unchanged public API check. Its fresh scans and final full suite must complete before committing the combined work.

## Completed implementation and rollout

Updated `skills/scip-plan/SKILL.md` and its existing agent metadata. Substantial plans must now record **Existing flow**, **Comparable features and conventions**, and **Reuse and ownership decisions** before implementation steps. The procedure requires locating the actual initiating surface, tracing the affected live path through its owners and effects to completion, inspecting comparable working features even when their names differ, and identifying the existing shared path and extension points. A proposed new owner or parallel path requires a concrete contract-based reason. Missing or bounded evidence cannot justify assuming an implementation is absent.

The plan must name code to reuse or extend, relevant policies and state ownership, consumers and migration/retirement steps, and a real-consumer check that would detect bypassing the shared path. Diff review must compare the implemented flow to that record. This extends the existing `$scip-explore` and `$scip-query` workflows and introduces no additional skill or approval gate.

Markdown/YAML formatting, skill links, package inclusion and the existing setup/CLI tests passed (52 tests in two files). The combined frozen full suite passed **3,267 tests across 368 files**. No agent benchmark was run; this verifies installation and repository compatibility, not measured compliance by an agent on the original LaunchPoint task.

Installed the two updated planning files through SSH alias `dev-agent` as `launchpoint-agent`, UID 1002. Updated their canonical package location and ran the installed `install-skills`: **0 installed, 12 already linked, 0 pruned, 0 skipped**. Both `/home/launchpoint-agent/.codex/skills/scip-plan` and `/home/launchpoint-agent/.claude/skills/scip-plan` resolve to `/home/launchpoint-agent/.local/lib/node_modules/scip-query/skills/scip-plan`. Their planning instructions and metadata match this checkout byte for byte. The shared query/exploration skill dependencies are present.

- `SKILL.md` SHA-256: `1c3be6a8a9ef3aa4a35d25918e426e4ba048737247eebbe247eb78251a91efda`.
- `agents/openai.yaml` SHA-256: `9db4a04a2aa731602323a9ed159f8680604438eeb19758e55d13ec54cbd6aa85`.
- VM backup: `/tmp/scip-plan-before-20260907-end-to-end-reuse.tgz`.
- Verification: `/tmp/scip-plan-vm-20260907-verification.json` on both this machine and the VM.

Rollout scope is the planning skill and metadata in the existing package. The installed runtime binary remains the previously verified build from `931fe6c1`; no binary rollout or watcher restart was needed. New Claude Code/Codex sessions load the updated instructions. Existing sessions that already loaded the old skill need to reload it or start a new session.

The dead-code removal has also completed its checks and its audit record documents the focused removal. The original LaunchPoint failure still has not been reproduced or attributed to a specific missing graph relationship; the planning procedure now explicitly requires the investigation and written evidence that were missing from the reported outcome.

Related dead-code cleanup commit: `3ed3c91b`.
