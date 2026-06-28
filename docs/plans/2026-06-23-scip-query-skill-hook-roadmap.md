# scip-query Skill and Hook Utilization Roadmap

**Date:** 2026-06-23
**Status:** Draft implementation roadmap
**Scope:** Robust project setup, bundled skills, hook integration, command coverage, and new workflows that make the CLI harder for agents to underuse.

## Goal

Make scip-query install into a repository as an active agent operating surface, not just a CLI plus optional skills. Done means a user can run one setup command in a project and have scip-query install or repair the required local tooling, install agent skills and hooks, create a fresh index, verify every detected language/indexer path, smoke-test the related query families, run a whole-repo health audit, write a confirmed issue dossier, and leave the repository ready for Codex or Claude Code with no hand wiring. The setup experience should give the user every fact scip-query can prove about what needs to be fixed, including signals that are not immediately actionable. Codex and Claude Code agents should then be consistently reminded to use the right scip-query skill and command workflow; the bundled skills should cover the current CLI surface; verification should reflect the modern diff-gate and capability model; and missing workflows such as debugging, issue triage, HTML diagrams, and post-setup cleanup launch should have first-class skill instructions.

## Working Definitions

A scip-query skill is a bundled instruction package under `skills/` that teaches an agent a recurring codebase workflow, such as exploring code, verifying a change, or cleaning up AI-generated duplication; what separates it from ordinary documentation is that the agent loads it as executable procedure when the user's task matches its description.

An agent hook is a deterministic command attached to an agent lifecycle event, such as session start, user prompt submission, or turn stop; what separates it from an instruction in AGENTS.md is that it runs at the relevant moment even when the model would otherwise forget or fail to choose the right workflow.

A lifecycle event is a named point in the agent's work loop, such as `SessionStart`, `UserPromptSubmit`, or `Stop`; what makes it useful for scip-query is that each event corresponds to a specific failure mode: missing project context, missing routing, or finishing without verification.

A diff gate is the scip-query check over the current Git diff that finds incomplete migrations, echoes, missing co-change partners, uncited doc edits, unused params, new dead symbols, and baseline regressions; what makes it stronger than a general health report is that it blocks only the newly introduced risk in the work being finished.

A command coverage gap is a CLI command that exists in the command registry but is not taught by any bundled skill; what makes it actionable is that agents are unlikely to discover the command at the moment it would help unless a skill or hook points them at it.

Structured output is CLI output with stable field names, usually JSON, that a hook, test, or agent can consume without parsing prose; what separates it from human text is that downstream automation can make reliable decisions from it.

A project setup command is the user-triggered bootstrap workflow that makes one repository ready for scip-query; what separates it from `postinstall` is that it can inspect the current project, install or request project-specific toolchains, write project guidance, build the index, and prove the installed commands work in that repository.

An indexer is the language-specific program that turns source code into SCIP facts; what makes it essential to scip-query is that every compiler-resolved query depends on the indexer producing a current graph for the project language.

A toolchain dependency is an external runtime, compiler, package manager, SDK, or binary that an indexer needs but the npm package cannot reliably bundle for every platform; what makes it part of setup is that an absent toolchain makes the indexer present but unusable.

A setup smoke test is a small command suite run after installation and indexing to prove the workspace is usable; what separates it from a full test suite is that it checks representative scip-query behavior for each detected capability rather than exhaustively validating application code.

A code health signal is a reported fact from a scip-query detector, such as dead code, duplication, coupling, cycles, incomplete migration, unused parameters, stale abstractions, wrapper layers, or doc drift; what makes it useful is that it points from a general maintainability concern to concrete source locations and graph evidence.

A confirmed issue is a health signal that an agent has checked against the current code and the relevant scip-query evidence; what separates it from raw analyzer output is that the report records whether the signal is a true fix target, an intentional design choice, a false positive, or a blocked investigation.

A health dossier is a generated Markdown and JSON report that gathers every setup, capability, health, and detector finding for the repository; what separates it from console output is that it becomes the durable starting point for cleanup work and user review.

A health score is a summarized repository quality rating derived from confirmed scip-query signals, setup readiness, capability coverage, and verification results; what makes it useful is that it gives the user one visible measure of current code health before they inspect the detailed issue list.

Perfect code is the practical target state where every known local signal has either been fixed, verified as intentional, or reduced to a documented external constraint; what makes it contextual rather than mystical is that the target moves only when new evidence or product requirements reveal a new issue.

## Current State

- [x] scip-query ships 14 bundled skills through `BUILTIN_SKILLS`.
  - **Source:** `scip-query plan-context installSkills --full`, showing `src/runtime/setup.ts:8-22`.
- [x] `installSkills()` links bundled skills into Claude Code, Codex, and the shared agent root when those tool roots exist.
  - **Source:** `scip-query plan-context installSkills --full`, showing `src/runtime/setup.ts:37-98`.
- [x] `setupAgent()` currently writes the AGENTS.md/CLAUDE.md guidance block and optionally writes a Git pre-commit hook.
  - **Source:** `scip-query plan-context setupAgent --full`, showing `src/runtime/agent-setup.ts:78-88`, `writeInstructionsBlock()`, and `writeGitPreCommitHook()`.
- [x] `check-deps` reports dependency and indexer readiness, but it does not install missing toolchains or smoke-test command families.
  - **Source:** `scip-query plan-context checkDeps --full`, showing `src/runtime/commands/command-handlers.ts:237-281`.
- [x] `diff-gate --hook` already exists as the stop-hook enforcement primitive.
  - **Source:** `scip-query plan-context handleDiffGate --full`, showing `src/runtime/query-commands/impact.ts:193` and descriptor references around `src/runtime/query-commands/impact.ts:319-340`.
- [x] `health --json --full` already exists as the composite whole-repo report surface, but setup does not currently write its findings to a durable dossier or require agent confirmation of each signal.
  - **Source:** `scip-query help health`.
- [x] Query commands are centrally registered in `queryCommandOrder`, and top-level maintenance commands are registered in `commandDescriptors`.
  - **Source:** `scip-query plan-context queryCommandDescriptor --full`, showing `src/runtime/commands/query-command-specs.ts:10-73` and `src/runtime/commands/query-command-specs.ts:94-102`.
- [x] The current worktree already has unrelated modified files. This roadmap intentionally adds only this plan document.
  - **Source:** `git status --short` run during planning.

## Command Coverage Audit

The following commands exist in the CLI but had no strict `scip-query <command>` mention in any bundled skill during the audit:

- `fan-out`
- `by-kind`
- `kind-counts`
- `hierarchy`
- `cleanup-apply`
- `self-audit`
- `augment-sources`
- `install-skills`
- `check-deps`
- `capabilities`
- `init`
- `suppress`
- `doctor`
- `setup-ci`
- `watch`

`setup-ci` is intentionally deferred from setup/adoption workflows for now. The command exists, but the CI story needs more product hardening before bundled skills should recommend it as part of first-run setup.

Commands with very low bundled-skill coverage:

- `members`
- `augment-vue`
- `capability-matrix`
- `config-validate`

**Audit source:** local coverage script comparing the command registry from `src/runtime/commands/query-command-specs.ts` and `src/runtime/commands/command-descriptors.ts` against `skills/*/SKILL.md`; command registry source verified with `scip-query plan-context queryCommandDescriptor --full`.

## Phase 0 - Build the Robust Project Setup Command

### 0.1 - Add a top-level setup/bootstrap command

**Status:** Implemented

- [x] **File:** `src/runtime/commands/command-descriptors.ts`
- [x] **File:** `src/runtime/commands/command-handlers.ts`
- [x] **New file:** `src/runtime/project-setup.ts`
- **Source:** `scip-query plan-context commandDescriptors --full`; `scip-query plan-context handleCheckDeps --full`; `scip-query plan-context setupAgent --full`.
- **What:** `setup-agent` only writes agent guidance and an optional Git pre-commit hook. `check-deps` reports missing readiness but does not repair it. Users need one command that makes a repo usable.
- **Change:** Add a project-scoped setup command, tentatively `scip-query setup`, that orchestrates the full bootstrap:
  1. Resolve and validate project root.
  2. Detect languages, package managers, workspaces, config files, and existing `.scipquery.json`.
  3. Install or repair scip-query skills; user-level lifecycle hooks are installed during package postinstall and repairable with `scip-query setup-hooks --json`.
  4. Install or repair configured indexers where safe; report host toolchain blockers with exact recovery instructions.
  5. Initialize minimal project config when missing.
  6. Build or refresh the index.
  7. Run capability checks.
  8. Run language/capability-specific smoke tests.
  9. Run a complete health and signal audit.
  10. Write a health dossier with raw unconfirmed findings, blocked/unavailable checks, and the recommended confirmation handoff.
  11. Run `setup-agent` for project guidance.
  12. Emit a concise setup report with the health score, the issue list that needs attention, what was installed, verified, skipped, or still blocked.
- **Why:** The user goal is "run setup and have the agent do everything." A dedicated setup command makes that goal visible and keeps `setup-agent` from becoming an overloaded name.

### 0.2 - Make dependency installation real, bounded, and inspectable

**Status:** Implemented

- [x] **New file:** `src/runtime/project-setup.ts`
- [x] **Existing file used:** `src/runtime/project-readiness.ts`
- [x] **Existing file used:** `src/runtime/scip-cli.ts`
- **Source:** `scip-query plan-context handleCheckDeps --full`; `scip-query plan-context postinstall --full`.
- **What:** Current readiness checks can say what is missing, and postinstall can attempt the base `scip` CLI install. Setup needs to repair more than that.
- **Change:** Add a readiness-to-remediation layer:
  - For bundled npm indexers, verify the package binary resolves and runs.
  - For language toolchains that cannot be bundled, detect the missing runtime/compiler/package manager and report exact recovery; do not silently install host runtimes.
  - Prefer project-local dependencies when the ecosystem supports it; otherwise install user-level tools only with explicit logging.
  - If automatic installation is unsafe or unavailable, emit exact commands and mark setup blocked, not "mostly fine."
  - Keep all install actions idempotent.
- **Why:** "Indexer installed" is not enough. The setup command must prove the indexer can run in this project, including any external toolchain it depends on.

### 0.3 - Add indexer smoke tests per detected language

**Status:** Implemented

- [x] **New file:** `src/runtime/project-setup.ts`
- [x] **File:** `src/runtime/commands/command-handlers.ts`
- **Source:** `scip-query plan-context handleCheckDeps --full`; `scip-query plan-context queryCommandDescriptor --full`.
- **What:** `capability-matrix` tells users what should work, but setup needs proof that representative commands actually work after install.
- **Change:** After `scip-query reindex`, run a bounded smoke suite that proves the setup-critical command families:
  - index lifecycle: `reindex` result and `status` freshness;
  - config lifecycle: `config-validate`;
  - capability inventory: `capabilities` and `capability-matrix --json`;
  - health signal collection: `health --json --full`;
  - Git impact/gate readiness when Git is available: `diff-impact --json` and `diff-gate --json`;
  - cleanup verification readiness through the capability matrix for `cleanup-plan --verify`;
  - project guidance: `setup-agent`.
- **Why:** Setup should fail during setup, not later when an agent confidently tries a command that was never proven in this repo.

### 0.4 - Produce a machine-readable setup report

**Status:** Implemented

- [x] **New file:** `src/runtime/project-setup.ts`
- [x] **File:** `src/runtime/commands/command-descriptors.ts`
- **Source:** `scip-query plan-context commandDescriptors --full`.
- **What:** Setup will perform many steps that agents and users need to understand after the fact.
- **Change:** Give `scip-query setup` text and `--json` output with:
  - detected languages;
  - installed tools;
  - skipped installs and why;
  - failed installs and recovery commands;
  - index status;
  - smoke-test results by command family;
  - capability matrix summary;
  - health score;
  - prioritized issue list;
  - health dossier path;
  - files written;
  - final verdict: ready, partially ready, or blocked.
- **Why:** Robust setup needs an audit trail. Agents should be able to consume the report without scraping prose.

### 0.5 - Run full health audit and write a dossier

**Status:** Implemented

- [x] **New file:** `src/runtime/project-setup.ts`
- [x] **New file:** `src/runtime/health-dossier.ts`
- [x] **Generated project file:** `docs/scip-query/health-dossier.md`
- [x] **Generated project file:** `docs/scip-query/health-dossier.json`
- **Source:** `scip-query help health`; `scip-query plan-context queryCommandDescriptor --full`; command coverage audit.
- **What:** Setup should not merely say "scip-query is installed." It should immediately tell the user what the repository needs next, including raw signals that may require agent confirmation.
- **Change:** After smoke tests, run the setup health and evidence inventory:
  - `scip-query health --json --full`;
  - smoke-test rows for impact, gate, cleanup verification, capabilities, config, guidance, and blocked/unavailable checks;
  - capability and unavailable-signal inventory so the dossier distinguishes "clean" from "not checked";
  - direct detector confirmation remains the job of `scip-health-audit`, which runs the full signal sweep before cleanup.
- Write every result to a Markdown dossier for humans and JSON for agents. The top of the Markdown report should show the health score, raw unconfirmed actions, blocked checks, unavailable signal classes, and the prioritized list of items that need attention. Each finding should include evidence, suggested first fix/confirmation step, confirmation status, and whether it is safe for an agent to start without more product input.
- **Why:** Users installing the tool should receive the full map of what scip-query can prove, not only the short list of easy fixes.

### 0.6 - Require agent confirmation before calling issues real

**Status:** Implemented

- [x] **New file:** `src/runtime/health-dossier.ts`
- [x] **File:** `skills/scip-health-audit/SKILL.md`
- **Source:** user product direction on 2026-06-23; `scip-query help health`; command coverage audit.
- **What:** Raw analyzer output is valuable, but the product promise should be stronger than "the tool printed warnings."
- **Change:** Treat CLI-collected signals as unconfirmed until an agent inspects the referenced code and SCIP evidence. The post-setup workflow should classify each signal as:
  - confirmed fix target;
  - intentional design, with reason;
  - false positive, with analyzer improvement note;
  - blocked by missing dependency, missing test command, or product decision.
- Before changing application code, the agent must first tell the user the health score and list the confirmed items that need to be addressed. The agent should also name the recommended first cleanup batch and why it is safe.
- After that visible handoff, the agent should not defer confirmed fix targets into vague future work. If the user has already asked for cleanup or selected an auto-cleanup mode, it should start with the safest, highest-confidence cleanup batch, apply it, verify it, update the dossier, and continue until it reaches a genuine blocker or an explicit user stop.
- **Why:** The north star is not "generate a report." The north star is steadily moving the codebase toward a state where every known issue is resolved or explicitly justified.

### 0.7 - Keep CI out of first-run setup

**Status:** Implemented

- [x] **File:** `skills/scip-query-setup/SKILL.md`
- [x] **File:** `skills/scip-adoption/SKILL.md`
- **Source:** user product direction on 2026-06-23; command coverage audit.
- **What:** `setup-ci` exists but is not fleshed out enough to be part of the main setup promise.
- **Change:** Exclude `setup-ci` from `scip-query setup`, `scip-query-setup`, and `scip-adoption` until CI setup has its own mature workflow and validation story.
- **Why:** A fragile CI writer would make robust setup feel less reliable. Keep the first-run promise focused on local capability, indexers, hooks, and smoke tests.

## Phase 1 - Update Existing Skills

### 1.1 - Rewrite scip-verify around the modern gate model

**Status:** Implemented

- [x] **File:** `skills/scip-verify/SKILL.md`
- **Source:** `scip-query plan-context handleDiffGate --full`; `scip-query help diff-gate`; current skill audit of `skills/scip-verify/SKILL.md`.
- **What:** The skill currently teaches a manual seven-check workflow: `diff-impact`, `cycles`, `dead`, `isolated`, `refs`, `fan-in`, `change-surface`, and `health`.
- **Change:** Make the default verification workflow:
  1. `scip-query doctor`
  2. `scip-query status --capabilities`
  3. `scip-query reindex`
  4. `scip-query diff-impact --json`
  5. Run routed postchecks based on actual change type.
  6. `scip-query diff-gate --json`
  7. `scip-query health --baseline` when a baseline exists.
  8. `scip-query config-validate` when `.scipquery.json` or suppressions changed.
- **Why:** Verification should use the highest-signal command first. `diff-gate` already groups diff-specific findings and has hook mode, so the skill should treat manual checks as drill-down evidence, not the primary gate.

### 1.2 - Expand the scip-query router routes

**Status:** Implemented

- [x] **File:** `skills/scip-query/SKILL.md`
- **Source:** `scip-query plan-context queryCommandDescriptor --full`; current skill audit of `skills/scip-query/SKILL.md`.
- **What:** The router covers exploration, planning, verification, debloat, AI cleanup, docs, directory architecture, maintainability, React, and Vue.
- **Change:** Add routing rows for:
  - Debugging or root-cause analysis -> new `scip-debug`.
  - Bug report or issue triage -> new `scip-triage-issue`.
  - Architecture or flow visualization -> new `scip-diagram`.
  - Post-setup health review and cleanup launch -> new `scip-health-audit`.
  - Tool adoption and repo bootstrap -> new `scip-adoption`.
  - Public API or module-boundary impact -> new `scip-api-impact`.
- **Why:** These are natural high-value combinations of existing commands, and their absence makes the CLI look narrower than it is.

### 1.3 - Upgrade setup guidance into robust bootstrap guidance

**Status:** Implemented

- [x] **File:** `skills/scip-query-setup/SKILL.md`
- **Source:** `scip-query plan-context setupAgent --full`; `scip-query plan-context installSkills --full`; `scip-query plan-context handleCheckDeps --full`; command coverage audit.
- **What:** Setup currently verifies the binary, reindexes, runs `setup-agent`, checks capability coverage, calibrates config, and runs the final gate. It does not yet install missing indexers/toolchains or smoke-test every relevant command family.
- **Change:** Add explicit use of:
  - `scip-query setup` once Phase 0 exists;
  - until then, `scip-query doctor`;
  - `scip-query check-deps`;
  - `scip-query install-skills`
  - `scip-query init`
  - `scip-query watch`
  - `scip-query health --json --full`
  - generated health dossier review through `scip-health-audit` once Phase 2 exists.
  - hook setup once Phase 3 exists.
  - Do not include `scip-query setup-ci` in the default setup path yet; leave CI wiring as a later, explicit workflow after the command is more mature.
- **Why:** Setup should turn a repo into a proven scip-query workspace, not merely a locally indexed repo.

### 1.4 - Teach verified cleanup application

**Status:** Implemented

- [x] **Files:** `skills/scip-ai-cleanup/SKILL.md`, `skills/scip-debloat/SKILL.md`
- **Source:** `scip-query help cleanup-plan`; `scip-query help cleanup-apply`; command coverage audit.
- **What:** Both skills teach `cleanup-plan --verify`, but neither teaches `cleanup-apply`.
- **Change:** Add a "when to apply" section:
  - Use `cleanup-plan --verify --json` or `--patch` for review.
  - Apply one batch at a time with `cleanup-apply --verified --batch <n>`.
  - Use `--all` only after explicit human approval.
  - Avoid `--force-dirty` unless the changed files are known to be unrelated.
- **Why:** The CLI has a safer application path for compiler-verified deletions, and the skills should steer agents toward it.

### 1.5 - Add underused navigation commands to exploration and language playbooks

**Status:** Implemented

- [x] **Files:** `skills/scip-explore/SKILL.md`, `skills/scip-language-playbook/SKILL.md`
- **Source:** `scip-query plan-context queryCommandDescriptor --full`; command coverage audit.
- **What:** `fan-out`, `by-kind`, `kind-counts`, and `hierarchy` are not taught by bundled skills.
- **Change:** Add guidance:
  - `fan-out` for files or symbols that may be doing too much.
  - `hierarchy` for class/module ancestry questions.
  - `by-kind` and `kind-counts` for unfamiliar language inventories or generated-code detection.
- **Why:** These are orientation commands, and orientation is exactly where agents need low-friction reminders.

### 1.6 - Teach suppressions as explicit acceptance, not silence

**Status:** Implemented

- [x] **Files:** `skills/scip-verify/SKILL.md`, `skills/scip-maintainability/SKILL.md`, `skills/scip-query-setup/SKILL.md`
- **Source:** command coverage audit; `scip-query help suppress`; `scip-query help config-validate`.
- **What:** `suppress` is not taught by bundled skills.
- **Change:** Add a small policy:
  - Prefer fixing findings.
  - Use `scip-query suppress <id> --reason "<human reason>"` only for intentional design, compatibility shims, framework entry points, or accepted false positives.
  - Always run `scip-query config-validate` after editing suppressions.
- **Why:** Suppression is the correct way to record intentional exceptions without making the gate toothless.

## Phase 2 - Add New Bundled Skills

### 2.1 - Add scip-health-audit

**Status:** Implemented

- [x] **File:** `skills/scip-health-audit/SKILL.md`
- [x] **File:** `src/runtime/setup.ts:8-22`
- **Source:** `scip-query help health`; `scip-query help cleanup-plan`; command coverage audit.
- **What:** There is no skill that takes a fresh setup report, verifies every health signal, writes the issue dossier, shows the health score and issue list to the user, and then begins cleanup from an informed starting point.
- **Change:** Create a post-setup audit workflow:
  1. Run or read `scip-query setup --json`.
  2. Run `scip-query health --json --full` and all capability-backed detector checks that setup did not already run.
  3. Verify every signal against source code and SCIP evidence before calling it a real issue.
  4. Write or update `docs/scip-query/health-dossier.md` and `.json`.
  5. Rank confirmed issues by safety, confidence, blast radius, and expected cleanup value.
  6. Tell the user the health score, the confirmed issue list, blocked/unavailable checks, and the recommended first cleanup batch before editing code.
  7. Start fixing the safest confirmed issues only after that visible report point, using `cleanup-plan --verify`, `cleanup-apply --verified`, targeted refactors, and the relevant maintainability skills.
  8. Reindex, run diff-gate, rerun affected signals, and update the dossier after each batch.
- **Why:** This is the skill that turns setup from "tool installed" into "the user knows the repo's health and the agent has a grounded cleanup path."

### 2.2 - Add scip-debug

**Status:** Implemented

- [x] **File:** `skills/scip-debug/SKILL.md`
- [x] **File:** `src/runtime/setup.ts:8-22`
- **Source:** `scip-query plan-context installSkills --full`; `scip-query plan-context queryCommandDescriptor --full`.
- **What:** There is no bug/root-cause skill even though `trace`, `code`, `call-graph`, `dataflow`, `slice`, `change-surface`, `affected`, `similar`, and `diff-impact` fit debugging naturally.
- **Change:** Create a debugging workflow:
  1. Reproduce or restate the failure.
  2. Find the entry point with `files`, `outline`, and `trace`.
  3. Follow execution with `call-graph` and `code`.
  4. Follow state with `dataflow` and `slice`.
  5. Compare nearby implementations with `similar` and `convergence`.
  6. Bound blast radius with `change-surface` and `affected`.
  7. Produce a minimal fix hypothesis and verification plan.
- **Why:** This turns scip-query into a diagnosis tool, not only a refactor and cleanup tool.

### 2.3 - Add scip-triage-issue

**Status:** Implemented

- [x] **File:** `skills/scip-triage-issue/SKILL.md`
- [x] **File:** `src/runtime/setup.ts:8-22`
- **Source:** `scip-query plan-context installSkills --full`; command coverage audit.
- **What:** There is no skill that converts a user bug report into an evidence-backed issue.
- **Change:** Create a triage workflow:
  - Normalize the report.
  - Identify likely entry points.
  - Cite candidate files and symbols with `trace`, `system`, `call-graph`, and `dataflow`.
  - Estimate blast radius with `change-surface` and `affected`.
  - Record reproduction gaps.
  - Produce a TDD fix plan and issue body.
- **Why:** scip-query can make bug triage concrete before anybody edits code.

### 2.4 - Add scip-diagram

**Status:** Implemented

- [x] **File:** `skills/scip-diagram/SKILL.md`
- [x] **File:** `src/runtime/setup.ts:8-22`
- **Source:** `scip-query plan-context installSkills --full`; `scip-query plan-context queryCommandDescriptor --full`.
- **What:** There is no workflow for turning graph evidence into visual explanations.
- **Change:** Create an HTML diagram workflow that can render:
  - Module maps from `system`.
  - Dependency graphs from `deps` and `rdeps`.
  - Public API diagrams from `surface`.
  - Call-flow diagrams from `call-graph`.
  - Data-flow diagrams from `dataflow` and `slice`.
  - Risk overlays from `change-surface`, `affected`, `cycles`, and `bottlenecks`.
- **Why:** Visual artifacts help humans inspect code paths quickly, and the CLI already has the graph facts needed to generate them.

### 2.5 - Add scip-adoption

**Status:** Implemented

- [x] **File:** `skills/scip-adoption/SKILL.md`
- [x] **File:** `src/runtime/setup.ts:8-22`
- **Source:** `scip-query plan-context installSkills --full`; `scip-query plan-context setupAgent --full`; `scip-query plan-context handleCheckDeps --full`.
- **What:** Adoption is currently split across `scip-query-setup`, README guidance, and maintenance commands. The desired product behavior is one robust project setup command that installs tooling, verifies indexers, writes agent guidance, installs hooks, and smoke-tests commands.
- **Change:** Create an adoption skill centered on `scip-query setup` once Phase 0 exists. Until then, its fallback workflow should run:
  - `doctor`
  - `check-deps`
  - install or repair missing indexer/toolchain dependencies when the remediation is known and safe;
  - `install-skills`
  - `init`
  - `reindex`
  - `capabilities` or `capability-matrix`
  - representative smoke-test commands for each detected language/capability;
  - `health --json --full`;
  - generated health dossier handoff to `scip-health-audit`;
  - `setup-agent`
  - optional `setup-agent --git-hook`
  - optional hook install once Phase 3 exists;
  - optional `watch`
- Do not include `setup-ci` in adoption yet; keep first-run setup focused on local agent behavior, indexing, capabilities, health audit, and hooks.
- **Why:** A first-time user should have one obvious workflow for "make this repo scip-query aware," and that workflow should prove the tool works before handing the repo back.

### 2.6 - Add scip-api-impact

**Status:** Implemented

- [x] **File:** `skills/scip-api-impact/SKILL.md`
- [x] **File:** `src/runtime/setup.ts:8-22`
- **Source:** `scip-query plan-context queryCommandDescriptor --full`; `scip-query plan-context installSkills --full`.
- **What:** There is no focused workflow for public API or module boundary changes.
- **Change:** Create a workflow centered on:
  - `surface`
  - `imported-by`
  - `fan-in`
  - `fan-out`
  - `refs`
  - `affected`
  - `change-surface`
  - `diff-impact`
- **Why:** API changes are where "who consumes this?" matters most, and scip-query has exactly that evidence.

## Phase 3 - Add Agent Hook Integration

### 3.1 - Install user-level agent hooks during CLI install

**Status:** Implemented

- [x] **File:** `src/runtime/setup.ts:112-134`
- [x] **New file:** `src/runtime/agent-hooks.ts`
- [x] **File:** `tests/runtime/setup.test.ts`
- **Source:** `scip-query plan-context postinstall --full`; `scip-query plan-context installSkills --full`; `scip-query plan-context setupAgent --full`; external Codex and Claude Code hook docs reviewed during planning.
- **What:** `postinstall()` currently installs bundled skills and checks the `scip` binary. `installSkills()` already writes into user-level Claude Code, Codex, and shared agent roots when those roots exist. `setupAgent()` currently writes project-local AGENTS/CLAUDE guidance and an optional Git pre-commit hook.
- **Change:** Add an install-time hook setup step after skill installation. This step should write user-level hook config for installed tools only:
  - Codex: `~/.codex/hooks.json`
  - Claude Code: `~/.claude/settings.json`
  - No project-local `.codex/`, `.claude/`, AGENTS.md, CLAUDE.md, or `.git/hooks` files during package postinstall.
- **Why:** CLI install is not scoped to a single project, so postinstall cannot correctly write project-local hook files. User-level hooks match the existing user-level skill install model and make scip-query available automatically in future Codex/Claude sessions.

### 3.1.1 - Preserve agent trust boundaries

**Status:** Implemented

- [x] **File:** `src/runtime/setup.ts:112-134`
- [x] **New file:** `src/runtime/agent-hooks.ts`
- **Source:** `scip-query plan-context postinstall --full`; external Codex hook docs reviewed during planning.
- **What:** Hooks execute commands during agent sessions, so auto-installing them is more sensitive than symlinking passive skills.
- **Change:** Keep the installed hooks reviewable by the host tool instead of bypassing trust:
  - Use ordinary Codex/Claude user hook config, not managed hooks.
  - Do not use Codex's hook trust bypass flags.
  - Print a short postinstall message telling users hooks were installed and may need review in `/hooks`.
  - Provide a documented opt-out environment variable for package managers and CI, for example `SCIP_QUERY_SKIP_HOOK_INSTALL=1`.
- **Why:** Codex and Claude Code both expose hook review surfaces. scip-query should install useful defaults, but it should not secretly bypass the agent client's trust model.

### 3.2 - Add a hook context renderer

**Status:** Implemented

- [x] **New file:** `src/runtime/agent-hooks.ts`
- [x] **File:** `src/runtime/commands/command-descriptors.ts`
- [x] **File:** `src/runtime/commands/command-handlers.ts`
- **Source:** `scip-query plan-context setupAgent --full`; `scip-query plan-context handleDiffGate --full`.
- **What:** Existing hook helpers only support stop-hook reentry and diff-gate block formatting.
- **Change:** Add a small command or helper that reads hook JSON from stdin and emits context for both Codex and Claude Code hook output contracts:
  - `SessionStart`: index status, capability summary, and a reminder to use the `scip-query` router skill.
  - `UserPromptSubmit`: prompt-classified guidance such as "debug request: use scip-debug", "implementation request: use concrete-plan", "review request: use scip-maintainability or scip-verify", "explain request: use scip-explore", and "fresh setup or health dossier request: use scip-health-audit".
  - `Stop`: delegate to hidden `scip-query hook-stop`, which wraps the diff gate and no-ops outside indexed scip-query workspaces.
- The helper must no-op quickly outside a Git repository or when `scip-query status` cannot find a usable index.
- **Why:** The model needs nudges at the exact points where the right workflow should be selected.

### 3.3 - Generate Codex user hook config

**Status:** Implemented

- [x] **Generated user file:** `~/.codex/hooks.json`
- [x] **File:** `src/runtime/setup.ts:112-134`
- [x] **New file:** `src/runtime/agent-hooks.ts`
- **Source:** `scip-query plan-context postinstall --full`; external Codex hook docs reviewed during planning.
- **What:** Codex discovers user-level hooks from `~/.codex/hooks.json`, and normal non-managed hooks are reviewable in Codex.
- **Change:** CLI postinstall should create or merge a scip-query-managed hook block that wires:
  - `SessionStart` to the scip-query context command.
  - `UserPromptSubmit` to the scip-query prompt router.
  - `Stop` to `scip-query hook-stop`.
- **Why:** This makes scip-query active in Codex sessions without requiring every project to run `setup-agent`.

### 3.4 - Generate Claude Code user hook config

**Status:** Implemented

- [x] **Generated user file:** `~/.claude/settings.json`
- [x] **File:** `src/runtime/setup.ts:112-134`
- [x] **New file:** `src/runtime/agent-hooks.ts`
- **Source:** `scip-query plan-context postinstall --full`; external Claude Code hook docs reviewed during planning.
- **What:** Claude Code reads user-level hooks from `~/.claude/settings.json` when Claude Code is installed.
- **Change:** CLI postinstall should create or merge a scip-query-managed hook block for:
  - `SessionStart`
  - `UserPromptSubmit`
  - `Stop`
- **Why:** Claude Code users should get the same lifecycle reminders and diff-gate stop check without per-project manual setup.

### 3.5 - Add hook safety tests

**Status:** Implemented

- [x] **Files:** `tests/runtime/setup.test.ts`, `tests/runtime/agent-hooks.test.ts`
- **Source:** `scip-query plan-context postinstall --full`; `scip-query plan-context setupAgent --full`; `scip-query plan-context handleDiffGate --full`.
- **What:** Hook config generation must preserve user settings, avoid infinite stop-hook loops, and stay no-op outside indexed repos.
- **Change:** Test:
  - existing configs are merged, not overwritten;
  - existing scip-query managed blocks are replaced cleanly;
  - stop hook uses `scip-query hook-stop`;
  - reentry is still guarded by `isStopHookReentry()`;
  - postinstall does not write project-local files;
  - postinstall respects `SCIP_QUERY_SKIP_HOOK_INSTALL=1`;
  - hook context renderer exits quietly outside scip-query workspaces.
- **Why:** Hook config is a trust-sensitive integration point.

## Phase 4 - Improve CLI Support for Agent Workflows

### 4.1 - Add structured output to diff-impact

**Status:** Implemented

- [x] **File:** `src/runtime/commands/command-descriptors.ts`
- [x] **File:** `src/runtime/commands/command-handlers.ts`
- [x] **File:** `tests/runtime/cli-contract.test.ts`
- **Source:** `scip-query help diff-impact` showed no `--json`; `scip-query plan-context handleDiffGate --full` shows surrounding impact command patterns.
- **What:** `scip-query diff-impact --json` currently errors with unknown option.
- **Change:** Add `--json` output using the same envelope conventions as other commands.
- **Why:** Verification skills and hooks need a stable changed-symbol contract.

### 4.2 - Add a command or script for skill coverage

**Status:** Implemented

- [x] **File:** `tests/runtime/cli-contract.test.ts`
- **Source:** `scip-query plan-context queryCommandDescriptor --full`; command coverage audit.
- **What:** The command-to-skill coverage audit was useful, but it is not available as a built-in check.
- **Change:** Add either:
  - a dev script that compares command descriptors against bundled skill docs; or
  - a `scip-query skill-coverage` maintenance command.
- **Why:** Once the skills are updated, the repo should be able to prevent future command underutilization.

### 4.3 - Decide where self-audit belongs

**Status:** Implemented

- [x] **File:** `skills/scip-verify/SKILL.md`
- **Source:** command coverage audit; `scip-query help self-audit`.
- **What:** `self-audit` is not taught by any bundled skill.
- **Change:** Either:
  - add it to `scip-verify` for maintainers working on scip-query itself; or
  - create a focused analyzer validation skill later.
- **Why:** `self-audit` is not a general app-developer command, but it is important for maintaining the analyzer.

## Phase 5 - Documentation and Distribution

### 5.1 - Update README skill and setup sections

**Status:** Implemented

- [x] **File:** `README.md`
- [x] **File:** `docs/AI_FAILURE_MODES.md`
- **Source:** `scip-query plan-context setupAgent --full` reports `README.md` as a co-change partner for `src/runtime/agent-setup.ts`; `scip-query plan-context installSkills --full` reports documentation co-change pressure for setup surfaces.
- **What:** README currently describes `install-skills`, `setup-agent`, and optional git hook setup.
- **Change:** Document:
  - the new `scip-query setup` bootstrap promise;
  - what setup can install automatically and what it will report as blocked;
  - setup smoke-test coverage;
  - the setup health score and prioritized issue list;
  - post-setup health dossier generation;
  - the `scip-health-audit` workflow for confirming signals and starting cleanup;
  - new skills;
  - updated verification flow;
  - user-level hook installation during CLI/package install;
  - the difference between AGENTS.md guidance, git hooks, and agent lifecycle hooks.
- **Why:** Installation behavior and agent expectations must be visible to humans, not only encoded in skills.

### 5.2 - Update command reference and agent guide

**Status:** Implemented

- [x] **File:** `docs/COMMAND_REFERENCE.md`
- [x] **File:** `docs/AGENT_GUIDE.md`
- **Source:** `scip-query plan-context installSkills --full`; `scip-query plan-context handleDiffGate --full`.
- **What:** New setup behavior, hook install behavior, new skills, and any `diff-impact --json` output need durable docs.
- **Change:** Add examples for:
  - `scip-query setup`
  - `scip-query setup --json`
  - setup output that shows the health score before any cleanup work;
  - generated `docs/scip-query/health-dossier.md`
  - setup blocked output with exact remediation commands;
  - `scip-query health --json --full`
  - `diff-impact --json`
  - `cleanup-apply --verified`
  - skill coverage if added.
- **Why:** Agent-facing skills should have human-facing documentation that matches them.

## Suggested Issue Breakdown

1. [x] Add robust `scip-query setup` project bootstrap orchestration.
2. [x] Add dependency/indexer remediation and setup smoke-test reporting.
3. [x] Add health dossier generation to setup; full signal confirmation continues in `scip-health-audit`.
4. [x] Add `scip-health-audit`.
5. [x] Modernize `scip-verify` and the router skill.
6. [x] Patch existing setup, cleanup, debloat, exploration, and language-playbook skills for uncovered commands.
7. [x] Add `scip-debug`.
8. [x] Add `scip-triage-issue`.
9. [x] Add `scip-diagram`.
10. [x] Add `scip-adoption`.
11. [x] Add `scip-api-impact`.
12. [x] Add Codex and Claude Code lifecycle hook generation during CLI install.
13. [x] Add structured `diff-impact --json`.
14. [x] Add skill coverage automation.
15. [x] Update README, command reference, and agent guide.
16. [x] Run full verification and accept or fix diff-gate findings.

## Verification Results

- [x] Skill validation: `quick_validate.py` passed for all changed bundled skills.
- [x] Command docs: `npm run docs:commands` regenerated `docs/COMMAND_REFERENCE.md`.
- [x] Focused tests: `npx vitest run tests/runtime/agent-hooks.test.ts tests/runtime/setup.test.ts tests/runtime/cli-contract.test.ts tests/runtime/project-setup.test.ts tests/runtime/health-dossier.test.ts` passed.
- [x] Full tests: `npm test` passed 71 test files / 364 tests.
- [x] Typecheck: `npm run typecheck` passed.
- [x] Lint/format: `npm run lint` passed.
- [x] Build: `npm run build` passed.
- [x] Dist smoke: `SCIP_QUERY_SKIP_HOOK_INSTALL=1 node dist/cli.js setup-hooks --json` emitted the expected skipped hook result.
- [x] Dist smoke: temporary empty repo `setup --json` exited blocked and reported unavailable smoke checks plus a health dossier path.
- [x] Dist smoke: temporary TypeScript repo `setup --json` exited ready with health 100 and all smoke rows passing.
- [x] Dist smoke: temporary Java fixture with an invalid/missing index path exited blocked rather than ready.
- [x] Config validation: `node dist/cli.js config-validate --json` returned no diagnostics.
- [x] Impact audit: `node dist/cli.js diff-impact --json` reported the intended runtime/setup diff slice plus the pre-existing `recent-duplicates` work already in the tree.
- [x] Final gate: `node dist/cli.js reindex && node dist/cli.js diff-gate --json` passed with 0 findings.

## Open Decisions

- [x] Hook install timing: install user-level hooks during CLI/package postinstall when the matching tool root exists.
- [x] Setup command name: use `scip-query setup`.
- [x] Toolchain install policy: auto-install only configured indexers when their prerequisite package manager/tool is already present; missing host runtimes and unsafe installs are blockers with exact recovery instructions.
- [x] Health dossier location: use `docs/scip-query/health-dossier.md` plus a sibling JSON report.
- [x] Confirmation boundary: setup records health actions as unconfirmed signals; `scip-health-audit` must inspect code/graph evidence before calling them fix targets.
- [x] Cleanup autonomy policy: after a visible score/items handoff, the agent may continue only on safest confirmed cleanup batches when the user already asked for cleanup; product-intent or API-shaping changes require explicit approval.
- [x] Health score formula: reuse the existing `health` score in setup and dossier output for now; blocked/unavailable setup checks are reported beside the score instead of silently folded into a new formula.
- [x] Manual hook setup command: add `scip-query setup-hooks --json`; keep `setup-agent` project-local.
- [x] Hook command shape: generate user-level lifecycle hook config that calls hidden `scip-query hook-context` and `scip-query hook-stop` commands.
- [x] Hook output schema: use JSON `hookSpecificOutput.additionalContext` for Codex and Claude Code context injection, with the Stop hook exiting 2 only when `diff-gate` reports findings.
- [x] Skill naming: keep `scip-debug`; it matches user language for debugging and can later alias to `scip-diagnose` if needed.
- [x] Diagram output: make `scip-diagram` target static HTML first; Mermaid can be an optional intermediate later, not the primary contract.
- [x] Adoption packaging: install user-level hooks during package postinstall, and describe repair/adoption through setup and `scip-adoption`.
- [x] Automation boundary: keep skill coverage as a repository contract test instead of a public command.

## Recommended Ship Order

1. Build `scip-query setup` as the robust project bootstrap and report surface.
2. Add dependency/indexer remediation and smoke-test coverage.
3. Add health dossier generation and all-signal collection to setup.
4. Add `scip-health-audit` so the agent confirms findings and starts cleanup after setup.
5. Update the setup/adoption skills to route users through the new setup command and health-audit workflow.
6. Add `diff-impact --json`, because later hooks and verification workflows benefit from it.
7. Update the existing verification/router/cleanup/exploration skills.
8. Add the remaining new workflow skills and register them in `BUILTIN_SKILLS`.
9. Add hook context rendering and user-level hook config generation.
10. Wire hook config generation into CLI postinstall with an environment-variable opt-out.
11. Add skill coverage automation so future commands cannot quietly become untaught.
12. Update README and command reference.
13. Run full verification and then cut the release.
