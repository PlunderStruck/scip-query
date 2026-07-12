# Setup Onboarding and 0.16.0 Release Plan

Date: 2026-07-11

## Goal

Make the human README and the bundled `scip-setup` agent skill describe the complete optimal setup path that the current CLI already implements, then prepare and validate the next npm release.

## Current State

- `scip-query code handleSetup --json` shows that terminal setup opens the checklist by default, while `--yes` accepts recommended defaults and `--json` remains non-interactive.
- `scip-query code guidedProjectSetupOptions --json` shows that setup selects detected languages, agent skills, detected Tree-sitter parser packages, optional hooks, automatic refresh, indexers, and the optional health audit.
- `scip-query code setupAstParsers --json` shows that missing detected grammars are installed at the scip-query package root using the versions pinned in optional dependencies, then probed again.
- `scip-query code remediateIndexers --json` shows that setup attempts configured indexer installation and reports exact recovery instructions when automatic installation is unavailable.
- `scip-query code semanticReadinessForLanguages --json` shows explicit TypeScript and Rust semantic readiness checks.
- The README still contains an obsolete claim that Rust reference, callee, signature, and import semantic evidence are future work.

## Reuse Audit

No new setup command or configuration option is needed. The existing interactive checklist, readiness report, capability matrix, watcher, TypeScript workspace mode, and durable Rust session already provide the desired behavior. This release should teach and verify those surfaces rather than add a parallel installer.

## Testability Design

| Behavior | Test seam | Side-effect boundary | Contract |
| --- | --- | --- | --- |
| Human setup guidance matches the CLI | README command examples plus `setup --help` | npm/global installation and terminal prompting | A developer can run one command and understand every scope and recovery step |
| Agent setup guidance reaches optimal state | bundled `scip-setup` skill | indexer/parser installation, hooks, config writes | Agent runs setup first, verifies per-language capabilities, and configures sharding only when repository shape warrants it |
| Release artifact contains current docs and runtime | `npm pack --dry-run` and packed-install smoke | npm packaging and registry | Package installs, exposes the CLI, includes skills, and passes setup-focused tests |

## Design Phases

### 1. Reconcile README onboarding

- [x] **File**: `README.md`
- **Source**: `scip-query code handleSetup --json`, `guidedProjectSetupOptions`, `setupAstParsers`, and `semanticReadinessForLanguages`.
- **Change**: Make interactive setup the primary human path; explain automatic detected parser/indexer installation, TypeScript workspace shards and persistent semantics, Rust SCIP plus durable semantics, verification, scopes, and recovery.
- **Validation**: Review commands against `setup --help`; run docs link checks through lint.

### 2. Make the setup skill an optimal-state playbook

- [x] **File**: `skills/scip-setup/SKILL.md`
- **Source**: the same setup entry points plus `scip-query code getProjectReadiness --json`.
- **Change**: Add interactive/non-interactive modes, parser/indexer ownership, TypeScript and Rust recipes, automatic incremental service verification, and explicit success criteria.
- **Validation**: `node scripts/check-skill-links.mjs` and full lint.

### 3. Prepare and verify the release

- [x] **Files**: `package.json`, `package-lock.json`
- **Source**: npm registry reports `scip-query@0.15.0` as latest; local history contains new setup, incremental indexing, accuracy, and suppression capabilities.
- **Change**: Bump the minor version to `0.16.0`.
- **Validation**: focused setup tests, full typecheck/lint/test/build, `npm publish --dry-run`, packed-install smoke, reindex, and diff gate.
- **Release boundary**: Actual `npm publish` requires authenticated npm credentials. Current `npm whoami` returns 401, so publication remains blocked until the user authenticates.

## Stress-Test Findings

- npm script approval cannot be bypassed by setup; the README must keep the explicit approval/rebuild recovery path.
- Workspace TypeScript project mode should not be enabled blindly for single-project repositories.
- Rust durable semantics are demand-started and may be stopped in status output without being unavailable.
- Generated caches and checkout hooks must not be described as repository records.
- The package prepublish hook also validates/publishes the Windows SCIP sidecar; dry-run must pass before any live publication.

## Verification Results

- Typecheck, lint, build, and the full suite passed: 190 test files and 1,329 tests.
- The focused setup suite passed: 61 tests covering project setup, the wizard, AST parser setup, readiness, setup behavior, and the CLI contract.
- `npm publish --dry-run` and `npm pack --json` succeeded for `scip-query@0.16.0`.
- A clean prefix install from `scip-query-0.16.0.tgz` exposed CLI version `0.16.0` and included the updated bundled setup skill.
- Live publication is the only incomplete release action because npm authentication currently returns `E401 Unauthorized`.
