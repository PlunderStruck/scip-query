---
name: scip-api-impact
description: Assess API impact with scip-query evidence. Use before changing public exports, module boundaries, schemas, routes, CLI commands, config fields, generated artifacts, signatures, docs-backed behavior, or consumer migrations.
---

# scip-api-impact

Use this skill before changing a public surface. A public surface is a callable, export, route, schema, config field, CLI command, generated artifact, or documented behavior that other code or users can depend on. Its defining trait is that a local edit can require coordinated consumer, docs, tests, or migration changes outside the implementation file.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

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
Consumers:
Required co-changes:
Migration:
Verification:
- targeted tests
- `scip-query diff-impact --json`
- invoke `scip-verify`
- `scip-query doc-drift --json --full` when docs changed
- `scip-query config-validate` when config changed
```

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
