---
name: scip-setup
description: Set up or repair scip-query in a repository. Use for bootstrapping, onboarding, refreshing indexes, project-local hooks, agent guidance, capability diagnostics, health dossiers, .scipquery.json, or setup cleanup handoff.
commands:
  - template: 'scip-query setup --json'
    when: 'Run setup: install skills, refresh the index, report health.'
  - template: 'scip-query doctor'
    when: 'Resolve blockers: human diagnostic for config, index, and dependencies.'
  - template: 'scip-query status --json'
    when: 'Resolve blockers: machine surface for freshness and config.'
  - template: 'scip-query capabilities --matrix'
    when: 'Resolve blockers: which evidence/verification capabilities are available.'
  - template: 'scip-query config-validate --json'
    when: 'Resolve blockers: validate .scipquery.json.'
  - template: 'scip-query init'
    when: 'Calibrate config: create .scipquery.json only when absent and needed.'
---

# scip-setup

Use this skill to make a repository a reliable scip-query workspace: indexed, diagnosed, documented for agents, and honest about unavailable capabilities.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query setup --json` | Bootstrap this project: enable automatic indexing, install agent skills, refresh the index, verify capabilities, and report health | setup step outcomes, files, capabilities, smoke tests, and warnings | `complete` | Run setup: install skills, refresh the index, report health. |
| `scip-query doctor` | Diagnose config, index freshness, dependency readiness, and project capabilities | config, freshness, dependency, and capability diagnostics | `complete` | Resolve blockers: human diagnostic for config, index, and dependencies. |
| `scip-query status --json` | Show index status for this project | freshness, generation, language shards, watcher, and optional capabilities | `complete` | Resolve blockers: machine surface for freshness and config. |
| `scip-query capabilities --matrix` | Report which evidence and verification capabilities are available in this project | capability matrix with availability and reasons | `complete` | Resolve blockers: which evidence/verification capabilities are available. |
| `scip-query config-validate --json` | Validate .scipquery.json, including structured suppressions and declared coupling groups | validation diagnostics with config paths | `complete` | Resolve blockers: validate .scipquery.json. |
| `scip-query init` | Create a .scipquery.json config file for this project | configuration path and creation outcome | `complete` | Calibrate config: create .scipquery.json only when absent and needed. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Per-Repo Triage (once, after setup)

New repos surface standing findings that are intentional. Encode them once so
every later gate run is precise:

1. Sweep initial findings (`health --json`, `diff-gate --json`) and, for each accepted one, `suppress <id> --reason <why>` — reasons are required and audited.
2. Declare files that legitimately change together in `.scipquery.json` `declaredCouplings`.
3. List dated snapshot docs (benchmarks, validation ledgers, historical plans/reviews) in `docs.snapshotPaths` so doc checks skip them with a labeled exclusion instead of recurring findings.
4. Seed `coverageContracts` for every hand-maintained enumeration (policy maps, capability tables, registry lists) so enumeration rot fails the gate the day it happens.
5. Set a hygiene cadence: run `scip-twin-drift` and `scip-claim-audit` after large refactor campaigns or quarterly — the gate only sees diffs; these lenses see accumulated state.

This step is complete only when a clean working tree produces a finding-free `diff-gate` and every suppression carries a reason a reviewer would accept.

## Rules

1. Prefer the single setup command over hand-running its internals.
2. Do not run `scip-query setup-ci` unless the user explicitly asks for CI setup.
3. Treat unavailable capabilities as unproven, not clean.
4. Keep `.scipquery.json` minimal and evidence-backed.
5. Let setup install detected AST parser packages and supported indexers; do not
   make users reproduce package-manager commands unless setup reports a blocker.
6. A demand-started service or Rust helper in `stopped` state can still be
   correctly configured. Availability comes from capabilities; lifecycle state
   only says whether work currently keeps the helper awake.

## What Setup Owns

`scip-query setup` is the bootstrap orchestrator. In a terminal it opens an
interactive checklist by default. For an agent or script, `scip-query setup
--json` runs the recommended non-interactive path and returns every result.

The command:

- detects supported project languages and lets a terminal user select them;
- installs or repairs supported language indexers when a safe installer exists;
- installs the Tree-sitter runtime and detected language grammars from the
  versions pinned by the installed scip-query package;
- installs bundled agent skills and checkout-local Codex/Claude hooks unless
  explicitly skipped;
- enables demand-started automatic incremental indexing unless the repository
  has or selects an explicit opt-out;
- builds or reuses language/project shards and publishes one atomic SQLite
  generation with recovery state;
- starts or reuses the clean-idle project service and verifies its lifecycle;
- checks TypeScript and Rust semantic readiness, compiler/checker readiness,
  representative commands, and optional health output;
- reports repository, checkout, user-environment, and rebuildable runtime state
  separately.

Do not manually install AST grammar packages before trying setup. If npm uses
script approval and native packages remain unavailable, report the pending
packages and ask the user to approve them; a package must not approve its own
install scripts.

## Workflow

### 1. Confirm the root

```bash
pwd
git rev-parse --show-toplevel
scip-query --version
```

This step is complete only when the repository root and runnable `scip-query` command are known, or the install/link blocker is reported.

### 2. Run setup

```bash
scip-query setup --json
```

When a human is operating the terminal, prefer plain `scip-query setup` so they
can review the checklist with arrow keys and Space. Use `scip-query setup --yes`
to accept recommended defaults without prompting. JSON mode is intentionally
non-interactive and suitable for agents.

Use `scip-query setup --no-hooks --json` when project-local Codex or Claude Code lifecycle hooks should not be written. Use `scip-query setup --git-hook --json` only when the user wants the local pre-commit diff gate.

This step is complete only when setup reports ready, partial, or blocked and names every written, skipped, or blocked artifact.

### 3. Resolve blockers

```bash
scip-query doctor
scip-query status --json
scip-query capabilities --matrix
scip-query config-validate --json
```

`doctor` is the human diagnostic surface. `status --json` is the machine surface for freshness and config. Fix missing indexers, stale indexes, invalid config, or unavailable verification only when the fix is safe; otherwise record the exact external action.

This step is complete only when each blocker is fixed, unavailable with reason, or waiting on a named external action.

### 4. Verify the language-specific optimal path

#### TypeScript, JavaScript, and Vue

Require all applicable capability rows to explain their state:

- `scip-typescript` is runnable for SCIP indexing;
- the detected Tree-sitter TypeScript/JavaScript parser is available for source
  facts;
- ts-morph semantic readiness is available for TypeScript;
- the demand-started service is enabled and status exposes TypeScript semantic
  and TypeScript index session counters.

For a real multi-project TypeScript monorepo, set
`indexer.typescript.projectMode: "workspace"`. This makes project/tsconfig
boundaries the sub-shards: a changed project and its project-reference,
workspace-package, or tsconfig-path dependents rebuild while unrelated project
shards are reused. Use `indexer.typescript.projects` only when automatic
discovery is too broad; a non-empty list is authoritative. Do not enable
workspace mode for a single-project repository merely to seek speed—the normal
incremental document producer and persistent ts-morph service already reuse
unchanged work.

#### Rust

Require these distinct facts:

- `rust-analyzer` is runnable and supports `rust-analyzer scip` for indexing;
- the Tree-sitter Rust grammar is available for source facts;
- Rust semantic readiness is available for compiler-backed references,
  callees, signatures, and module/use evidence;
- status reports the durable Rust transport with worker fallback. `stopped` is
  healthy when no semantic request currently needs the clean-idle helper.

If rust-analyzer is missing and rustup is available, setup can run `rustup
component add rust-analyzer`. `SCIP_RUST_SEMANTIC_DURABLE_SESSION=0` is an
explicit worker-only fallback, not the optimal default.

#### Other languages

Trust the capability matrix, not a language name. Setup may install supported
indexers automatically (for example Python or Go), may provide only source
facts through a detected Tree-sitter grammar, or may report a manual install
URL. A missing semantic provider must be reported as unsupported, never as a
clean semantic analysis.

Verification:

```bash
scip-query status --capabilities
scip-query reindex --json
scip-query watch --status --json
```

This step is complete only when every selected language has an explicit
indexing/source/semantic/checker verdict and the published generation is fresh.

### 5. Calibrate config only when needed

Run `scip-query init` only when `.scipquery.json` is absent and the project needs config. Add settings only for observed repo facts: explicit languages, indexer projects, entry roots, declared couplings, locality boundaries, or accepted suppressions.

For TypeScript monorepos, prefer `indexer.typescript.projectMode: "workspace"` when multiple project shards are real. Add `indexerConcurrency` only when measured cold-index timing or memory pressure justifies it. Keep `watch.enabled: true` for the designed demand-started lifecycle unless the user explicitly opts out.

This step is complete only when config validates and every setting has a reason.

### 6. Hand off cleanup

After setup, invoke `scip-cleanup-audit` when the user wants a report or `scip-cleanup-improve` when the user wants autonomous cleanup.

Report:

```markdown
Setup: ready/partial/blocked
Capabilities:

- available:
- unavailable:
  Health:
- score:
- dossier:
  Written or changed:
- files:
  Runtime:
- automatic indexing:
- TypeScript project/index sessions:
- Rust semantic transport/lifecycle:
  Next:
- cleanup audit/improve, CI setup, or external blocker
```
