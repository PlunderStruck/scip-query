---
name: scip-api-impact
description: Assess and plan public API, module boundary, schema, route, CLI, config, or exported-surface changes with scip-query evidence. Use when the user asks what will break, who consumes an API, how to migrate a boundary, whether a signature change is safe, or how to coordinate docs/tests/generated artifacts.
---

# SCIP API Impact

Use this skill before changing a public surface. A public surface is a callable, export, route, schema, config field, CLI command, generated artifact, or documented behavior that other code or users can depend on. Its defining trait is that a local edit can require coordinated consumer, docs, test, or migration changes outside the implementation file.

## Rules

1. Identify the actual surface before planning the change.
2. Use scip-query to find direct consumers, reverse dependencies, transitive blast radius, and historical co-change partners.
3. Treat docs, generated files, tests, and config as part of the API when they describe or enforce the surface.
4. Prefer backward-compatible migration plans when consumers are broad or external.
5. Run `scip-verify` after implementation.

## Workflow

### 1. Identify the surface

```bash
scip-query status --capabilities
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query surface <module-or-package>
scip-query outline <file>
scip-query trace <symbol-or-command>
scip-query code <symbol-or-command>
```

Use `scip-query hierarchy <symbol> --json` for class members or nested methods so you know whether the real surface is the member, class, module, or package.

### 2. Find consumers and ownership

```bash
scip-query refs <symbol>
scip-query fan-in <symbol>
scip-query rdeps <file>
scip-query affected <symbol> --json
scip-query change-surface <file> --json --full
```

Record direct consumers separately from transitive consumers. Direct consumers must compile or adapt immediately; transitive consumers define blast radius and regression risk.

### 3. Find hidden partners

```bash
scip-query co-change <file> --json --full
scip-query doc-drift --json --full
scip-query similar <symbol> --json --full
scip-query similar-files <file> --json --full
```

Use co-change for schema/docs/generator/test partners that do not import each other. Use doc drift when docs mention the surface. Use similarity to find sibling APIs that should remain consistent.

### 4. Choose the migration shape

Pick one:

- Compatible extension: add optional behavior without breaking existing callers.
- Two-step migration: add the new surface, migrate callers, then remove the old surface.
- Breaking change: update all consumers and docs in one coordinated change.
- Adapter shim: keep a wrapper only when external consumers or compatibility windows require it.

Reject speculative parameters or wrappers by running:

```bash
scip-query unused-params --json --full
scip-query wrapper-candidates --json --full
scip-query passthrough-candidates --json --full
```

### 5. Build the impact plan

Before editing, write:

```markdown
Surface:
- <symbol/file/command/schema>

Consumers:
- direct: <count and important files>
- transitive: <count or affected clusters>

Required co-changes:
- code
- tests
- docs
- generated files
- config or schema partners

Migration:
- compatible extension / two-step / breaking / shim

Verification:
- targeted tests
- `scip-query diff-impact --json`
- `scip-query diff-gate --json`
- `scip-query doc-drift --json --full` when docs changed
- `scip-query config-validate` when config changed
```

### 6. Verify after editing

```bash
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query diff-impact --json
scip-query diff-gate --json
```

Then run routed checks:

```bash
scip-query unused-params --json --full
scip-query incomplete-migration --json --full
scip-query co-change <changed-file> --json --full
scip-query doc-drift --json --full
```

Invoke `scip-verify` before declaring the API change ready.

## Report Format

```markdown
API impact: low/medium/high

Surface changed:
- <surface>

Consumers:
- <direct consumers>
- <transitive blast radius>

Migration plan:
- <chosen shape and why>

Co-changes:
- <docs/tests/generated/config partners>

Verification:
- <commands run and results>

Remaining risk:
- <external consumers, unavailable capabilities, or accepted compatibility shims>
```

Do not call a public-surface change safe until direct consumers, docs/config partners, and `scip-query diff-gate --json` have been checked.
