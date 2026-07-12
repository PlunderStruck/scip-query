# Setup AST Parser Installation

Date: 2026-07-12
Status: Complete

## Goal

Make Tree-sitter source parsing a visible, repairable setup capability. A user
selecting detected languages in `scip-query setup` must be able to install the
matching native parser runtime and grammars without learning npm package names
or running package-manager commands manually.

## Current State

- `scip-query plan-context planGuidedProjectSetup --json` resolves setup
  planning to `src/runtime/project-setup.ts`; its choices cover refresh,
  guidance, hooks, indexers, skills, and health, but not AST parsers.
- `package.json` declares Tree-sitter and its grammars as optional dependencies,
  so an initial npm install may omit them without failing scip-query.
- `src/source/ast/ast-runtime.ts` already owns runtime and grammar probing;
  `src/runtime/project-readiness.ts` uses that probe to downgrade source-fact
  capabilities when a native parser is unavailable.

## Reuse Audit

- Reuse `probeAstLanguageRuntime()` as the availability oracle and the setup
  wizard/action mapping already in `guidedProjectSetupOptions()`.
- Extend `runProjectSetup()` and its report rather than creating a second setup
  command.
- Add one installation boundary because indexer remediation installs unrelated
  external binaries and cannot install npm modules into scip-query's own
  package root.

## Testability Design

| Behavior | Test seam | Injected dependencies | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Select packages | language-to-package planner | none | dedupe package mapping | none | only supported detected languages produce packages |
| Install/repair | parser installer | probe and npm runner | before/after classification | child npm process | existing parsers are skipped; failures are reported, not hidden |
| Setup integration | `runProjectSetup()` options | installer mock | selected/deselected mapping | package installation | deselection performs no install; report names every parser state |
| Wizard | setup choice mapping | terminal state reducer | selected action set | TTY checklist | AST parser choice is visible before work begins |

## Design Phases

### 1. Add a parser package planner and installer

- [x] **Files:** `src/runtime/ast-parser-setup.ts` and focused tests.
- **Source:** `scip-query change-surface src/source/ast/ast-runtime.ts --json --full`.
- **Change:** Map supported languages to pinned optional dependency packages,
  probe availability, install only missing packages into scip-query's package
  root, and validate the resulting runtime. Preserve graceful degradation and
  return actionable errors when permissions/build tooling block installation.
- **Validation:** Pure mapping tests plus injected success, no-op, and failure
  installer tests.

### 2. Expose the choice through setup

- [x] **Files:** `src/runtime/commands/command-handlers.ts`,
  `src/runtime/project-setup.ts`, setup wizard/project setup tests, CLI docs.
- **Source:** `scip-query plan-context planGuidedProjectSetup --json`.
- **Change:** Always show a detected-language AST parser choice when any
  selected language has a Tree-sitter grammar. Recommend it when parsers are
  missing, pass consent into setup, stream installation progress, and include
  parser results and scope in the setup report. Non-TTY/`--yes` accepts the
  recommended repair; `--json` never prompts.
- **Validation:** Wizard-choice, setup-consent, JSON, help, and report tests.

### 3. Verify packaging and real installation

- [x] **Files:** this plan and repository records.
- **Source:** final setup/package smoke and `scip-query diff-gate --json`.
- **Change:** Run a packed-install fixture with optional parsers absent, invoke
  setup repair, prove the selected grammar loads, and document the outcome.
- **Validation:** tests, typecheck, lint, build, pack/install smoke, reindex,
  and diff-gate.

## Stress Findings

- Native module installation may fail because of permissions, registry policy,
  platform support, or build tooling; setup must remain usable and report a
  partial verdict with the exact recovery action.
- Parser packages belong to the installed scip-query package, not the analyzed
  repository. Setup must never modify the target project's `package.json` or
  lockfile.
- Clojure uses a built-in reader; Go and Dart have no bundled Tree-sitter
  grammar. They must not produce misleading installation choices.
- Multiple selected languages share the `tree-sitter` runtime and sometimes a
  grammar; package planning must deduplicate them.

## Execution Order

1. Implement and test package planning/installation.
2. Integrate consent and reporting into setup.
3. Run packed installation and closure gates, then mark this plan complete.

## Result

A packed `0.15.0` installation was installed with `--omit=optional` into an
isolated prefix. Running its normal setup flow in a fresh Rust project detected
that the AST runtime was unavailable, installed `tree-sitter@0.21.1` and
`tree-sitter-rust@0.23.1` inside the scip-query package, reset the runtime
probe, and reported Rust available. The analyzed project's `Cargo.toml` was
unchanged; no project npm manifest or lockfile was created.
