# Bootstrap workflow

Six ordered steps. Each has a completion condition — do not treat the step as
done until the condition is met.

## 1. Confirm the root

```bash
pwd
git rev-parse --show-toplevel
scip-query --version
```

Complete only when the repository root and a runnable `scip-query` command
are known, or the install/link blocker is reported.

## 2. Run setup

```bash
scip-query setup --json
```

`scip-query setup` is the bootstrap orchestrator. In a terminal it opens an
interactive checklist by default. For an agent or script, `scip-query setup
--json` runs the recommended non-interactive path and returns every result —
JSON mode is intentionally non-interactive and suitable for agents. When a
human is operating the terminal, prefer plain `scip-query setup` (no `--json`)
so they can review the checklist with arrow keys and Space. Use `scip-query
setup --yes` to accept recommended defaults without prompting.

Use `scip-query setup --no-hooks --json` when project-local Codex or Claude
Code lifecycle hooks should not be written. Use `scip-query setup --git-hook
--json` only when the user wants the local pre-commit diff gate.

The command, in full:

- detects supported project languages and lets a terminal user select them;
- installs or repairs supported language indexers when a safe installer
  exists;
- installs the Tree-sitter runtime and detected language grammars from the
  versions pinned by the installed scip-query package;
- installs bundled agent skills and checkout-local Codex/Claude hooks unless
  explicitly skipped;
- installs the minimum managed instructions that tell an agent to recover or
  derive one concise Gherkin goal, rely on automatic work capture, and obey
  the protected Stop-controller action;
- enables demand-started automatic incremental indexing unless the repository
  has or selects an explicit opt-out;
- builds or reuses language/project shards and publishes one atomic SQLite
  generation with recovery state;
- starts or reuses the clean-idle project service and verifies its lifecycle;
- checks TypeScript and Rust semantic readiness, compiler/checker readiness,
  representative commands, and optional health output;
- reports repository, checkout, user-environment, and rebuildable runtime
  state separately.

Complete only when `setup` reports `ready`, `partial`, or `blocked` and names
every written, skipped, or blocked artifact.

## 3. Resolve blockers

```bash
scip-query doctor
scip-query status
scip-query capabilities --matrix
scip-query config-validate
```

`doctor` reports config, index freshness, and dependency readiness. `status`
reports freshness and config. `capabilities --matrix` reports which
evidence/verification capabilities are available. `config-validate` validates
`.scipquery.json`.

Fix missing indexers, stale indexes, invalid config, or unavailable
verification only when the fix is safe; otherwise record the exact external
action needed (e.g. "user must approve npm install scripts for
tree-sitter-rust").

Complete only when each blocker is fixed, reported unavailable with a reason,
or waiting on a named external action.

## 4. Verify the language-specific optimal path

See [Language verification](language-verification.md) for what to check per
language and how to interpret `stopped`/idle service states.

```bash
scip-query status --capabilities
scip-query reindex
scip-query watch --status
```

Complete only when every selected language has an explicit
indexing/source/semantic/checker verdict and the published generation is
fresh.

## 5. Calibrate config only when needed

Run `scip-query init` only when `.scipquery.json` is absent and the project
needs config — it creates the config file. Add settings only for observed
repo facts: explicit languages, indexer projects, entry roots, declared
couplings, locality boundaries, or accepted suppressions.

- For TypeScript monorepos, prefer `indexer.typescript.projectMode:
  "workspace"` when multiple project shards are real (see
  [Language verification](language-verification.md) for when this earns its
  keep).
- Add `indexerConcurrency` only when measured cold-index timing or memory
  pressure justifies it.
- Keep `watch.enabled: true` for the designed demand-started lifecycle unless
  the user explicitly opts out.

Complete only when config validates and every setting has a stated reason.

## 6. Hand off

After setup, invoke `scip-audit` when the user wants a report, or
`scip-improve` when the user wants autonomous cleanup. If the repo is
new to scip-query, also route through [Per-repo triage](per-repo-triage.md)
so standing findings get encoded once rather than recurring on every gate run.
For an authorized implementation request with no existing canonical state,
route through `scip-plan`; the agent derives and materializes the concise
Gherkin goal and intended change instead of asking the user to populate
protocol metadata.

Close with the report template in the top-level `SKILL.md`.
