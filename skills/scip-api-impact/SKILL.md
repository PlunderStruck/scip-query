---
name: scip-api-impact
description: Answer "what will break if I change this?" before editing an API, export, module boundary, schema, route, CLI command, config field, generated artifact, signature, documented behavior, or consumer migration.
commands:
  - template: 'scip-query surface <module-or-package>'
    when: 'Identify the surface: what consumers actually use from the module.'
  - template: 'scip-query refs <symbol>'
    when: 'Find consumers: every direct reference to the surface symbol.'
  - template: 'scip-query affected <symbol> --json'
    when: 'Find consumers: transitive blast radius of the change.'
  - template: 'scip-query co-change <file> --json --full'
    when: 'Find hidden partners: historically coupled files without a dependency edge.'
  - template: 'scip-query doc-drift --json --full'
    when: 'Find hidden partners: docs that describe the surface and may need an update.'
  - template: 'scip-query unused-params --json --full'
    when: 'Choose migration shape: reject speculative new parameters.'
---

# scip-api-impact

Use this skill before changing a public surface. A public surface is a callable, export, route, schema, config field, CLI command, generated artifact, or documented behavior that other code or users can depend on. Its defining trait is that a local edit can require coordinated consumer, docs, tests, or migration changes outside the implementation file.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query surface <module-or-package>` | What symbols consumers actually use from this module | consumer paths and consumed symbol identities | `complete` | Identify the surface: what consumers actually use from the module. |
| `scip-query refs <symbol>` | Find all files referencing a symbol | referencing file paths; reference line numbers grouped by file | `bounded` | Find consumers: every direct reference to the surface symbol. |
| `scip-query affected <symbol> --json` | Transitive closure of symbols that could break if this symbol changes | affected symbol identities, files, and traversal depths | `bounded` | Find consumers: transitive blast radius of the change. |
| `scip-query co-change <file> --json --full` | Files that change together in git history without a dependency edge — hidden coupling candidates | file pairs, co-change counts, confidence, and history context | `bounded` | Find hidden partners: historically coupled files without a dependency edge. |
| `scip-query doc-drift --json --full` | Stale-doc candidates: code the doc references or co-changed with kept changing after the doc stopped | document paths, coupled code subjects, and history evidence | `bounded` | Find hidden partners: docs that describe the surface and may need an update. |
| `scip-query unused-params --json --full` | Speculative-generality candidates: trailing parameters no body ever uses (TS/JS) | candidate parameters with callable and file identities | `bounded` | Choose migration shape: reject speculative new parameters. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Rules

1. Identify the actual surface before planning.
2. Find direct consumers, reverse dependencies, transitive blast radius, and historical co-change partners.
3. Treat docs, generated files, tests, and config as part of the API when they describe or enforce the surface.
4. Prefer backward-compatible migrations when consumers are broad or external.
5. Run `scip-verify` after implementation.

## Workflow

### 1. Identify the surface

```bash
scip-query surface <module-or-package>
scip-query outline <file>
scip-query trace <symbol-or-command>
scip-query code <symbol-or-command>
scip-query hierarchy <symbol> --json
```

This step is complete only when the real surface is named: member, class, module, package, route, schema, command, or config field.

### 2. Find consumers

```bash
scip-query refs <symbol>
scip-query fan-in <symbol>
scip-query rdeps <file>
scip-query affected <symbol> --json
scip-query change-surface <file> --json --full
```

Record direct consumers separately from transitive consumers.

This step is complete only when direct breakage and regression blast radius are known.

### 3. Find hidden partners

```bash
scip-query co-change <file> --json --full
scip-query doc-drift --json --full
scip-query similar <symbol> --json --full
scip-query similar-files <file> --json --full
```

This step is complete only when docs, generated files, fixtures, sibling APIs, and hand-synchronized partners are accounted for or ruled out.

### 4. Choose migration shape

Pick one:

- Compatible extension.
- Two-step migration.
- Breaking coordinated change.
- Adapter shim for external consumers or compatibility windows.

Reject speculative inputs and empty wrappers with:

```bash
scip-query unused-params --json --full
scip-query wrapper-candidates --json --full
scip-query passthrough-candidates --json --full
```

This step is complete only when the migration shape explains deploy order, rollback, and compatibility risk.

### 5. Build and verify the plan

```markdown
Surface:
Consumer dispositions:
| Consumer | Kind (direct/transitive/doc/config/test) | Disposition (unchanged-safe/update/shim/defer) |
| --- | --- | --- |
Required co-changes:
Migration:
Verification:

- targeted tests
- `scip-query diff-impact --json`
- invoke `scip-verify`
- `scip-query doc-drift --json --full` when docs changed
- `scip-query config-validate` when config changed
```

Every consumer from `refs`/`affected` appears as a row — a blank disposition is unfinished analysis, and the plan is not complete while one exists. Non-indexed consumers (SQL, fixtures, dynamic strings, external callers) are checked with `rg` and rowed the same way.

After editing, run routed checks from the shared reference and invoke `scip-verify`.

The work is complete only when direct consumers, docs/config partners, and `scip-verify` have been checked.

## Report

```markdown
API impact: low/medium/high
Surface changed:
Consumers:
Migration plan:
Co-changes:
Verification:
Remaining risk:
```
