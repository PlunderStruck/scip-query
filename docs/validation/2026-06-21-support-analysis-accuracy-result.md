# Support Analysis Accuracy Result

Date: 2026-06-21

Ledger item: AVL-004

## Verdict

Complete for the current TypeScript support-command slice. The reviewed support commands reported source-grounded facts for `validateProjectConfig()` and `src/runtime/config.ts`, and one support-output mismatch was fixed: `status` and `doctor` now use root-aware config validation just like `config-validate`.

A support analysis is an evidence provider. It reports definitions, references, imports, dependencies, graph pressure, capabilities, or planning context so a maintainer can reason about change. Its defining standard is not whether it finds a repair, but whether its facts agree with the source and clearly expose unsupported or incomplete evidence.

## Fix

`buildProjectDiagnosticReport()` now calls:

```ts
validateProjectConfig(config, { projectRoot })
```

That aligns `status` and `doctor` with `config-validate` for stale declared-coupling and structured suppression file-path diagnostics.

Regression coverage was added through `handleStatus({ json: true })` in a temp project selected with `SCIP_QUERY_PROJECT_ROOT`. The test asserts that status JSON includes the stale declared-coupling warning from root-aware config validation.

2026-06-22 locality-config note: the later `locality.architecturalBoundarySegments` config support still uses `validateProjectConfig()` in `src/runtime/config.ts`; this support-analysis target remains current.

## Command Review

Target: `validateProjectConfig()` in `src/runtime/config.ts`.

| Command | Reviewed output | Verdict |
| --- | --- | --- |
| `refs validateProjectConfig --json` | Reported five references: internal `addFindingSuppression()`, import in `command-handlers.ts`, `handleConfigValidate()`, and two diagnostic-report uses. | Accurate for indexed/source references. It intentionally includes import/type/value references, so it is broader than call graph fan-in. |
| `affected validateProjectConfig --json` | Reported first-order affected symbols `handleConfigValidate()`, `buildProjectDiagnosticReport()`, and `addFindingSuppression()`, then second-order command handlers. | Accurate call-impact support evidence. It is not a complete dynamic runtime analysis. |
| `change-surface src/runtime/config.ts --json` | Reported exported config helpers, external consumers, and medium risk on externally consumed config functions. | Accurate file surface summary. Counts are graph/index consumer counts, not test or textual `rg` counts. |
| `plan-context validateProjectConfig --full --json` | Bundled definition source, references, call graph, complexity, dataflow, affected symbols, dependencies, reverse dependencies, and surface. | Accurate composite view for the target. History churn remains committed-history-only, so current uncommitted edits do not appear as churn. |
| `imports src/runtime/config.ts --json` | Reported Node builtins and imported domain types. | Accurate import inventory; external modules are intentionally marked `(external)`. |
| `deps src/runtime/config.ts --json` | Reported `src/domain/config-types.ts` and `src/domain/types.ts`. | Accurate indexed project dependency view; external builtins are not project deps. |
| `rdeps src/runtime/config.ts --json` | Reported runtime context, command handlers, runtime index, and watch. | Accurate reverse dependency view for project files. |
| `fan-in validateProjectConfig --json` | Reported graph fan-in count 2 for the callable. | Accurate graph metric. It counts callable incoming graph edges, not every textual reference shown by `refs`. |
| `fan-out src/runtime/config.ts --json` | Reported file fan-out count 22. | Accurate graph metric for file-level outgoing references; useful as pressure evidence, not a smell. |
| `hotspots --json` | Top rows were central infrastructure symbols such as `ScipDatabase`, `domain/types`, `SymbolMatch`, and `shortenSymbol()`. | Plausible support ranking; centrality is context, not repair evidence. |
| `status --json` | Current repo reported no config diagnostics, available TypeScript indexing/semantic/checker capabilities, and stale freshness before the final reindex. | Accurate support report. Stale freshness was expected after source/build changes before reindex. |
| `self-audit --samples 60 --json` | Reference precision 1.0, reference recall 0.853, callee recall 1.0, and cheap-only callee disagreements in Vue/source and semantic-provider internals. | Useful trust metric. It should keep reporting disagreement classes; it is not proof of complete recall. |

## Known Boundaries

- `refs` and `fan-in` answer different questions. `refs` includes import/type/value references; `fan-in` reports graph incoming edges for the callable.
- `change-surface` external consumer counts are project-index counts and intentionally exclude test expectations and raw text matches.
- `plan-context` history uses committed git history. It does not treat working-tree edits as churn.
- `self-audit` is a sampled comparison against the TypeScript semantic oracle. A good sample does not imply all languages or dynamic patterns have compiler-level recall.
- The current result is TypeScript-focused. Cross-language capability boundaries remain a separate AVL-010 slice.

## Verification

Completed checks so far:

```text
npx vitest run tests/runtime/runtime-config.test.ts
node dist/cli.js status --json
node dist/cli.js refs validateProjectConfig --json
node dist/cli.js affected validateProjectConfig --json
node dist/cli.js change-surface src/runtime/config.ts --json
node dist/cli.js plan-context validateProjectConfig --full --json
node dist/cli.js self-audit --samples 60 --json
node dist/cli.js imports src/runtime/config.ts --json
node dist/cli.js deps src/runtime/config.ts --json
node dist/cli.js rdeps src/runtime/config.ts --json
node dist/cli.js fan-in validateProjectConfig --json
node dist/cli.js fan-out src/runtime/config.ts --json
node dist/cli.js hotspots --json
npm run typecheck
npm run build
npm test
node dist/cli.js recent-duplicates --json
node dist/cli.js unused-params --json
node dist/cli.js reindex
node dist/cli.js diff-gate --json
```

Repository verification passed. The full test suite reported 64 passing test files and 321 passing tests. `recent-duplicates` returned no findings. `unused-params` returned an empty result. Reindexing completed successfully. After reindex, `status --json` reported fresh index metadata and no config diagnostics.

`diff-gate` still reports the two accepted warnings already tracked in this validation pass:

- `SQ36D93309ABEA`, `echo`: changed `isCompileTimeContractAssertion()` shares symbol parsing helpers with established `indexedDefinitionFromRow()`, but the semantics are different.
- `SQ30E6CF5F9B38`, `doc-reference`: README configuration examples cite changed cleanup query files; the example target remains intentional.

## 2026-06-27 Citation Refresh

The persistent-refresh coordination slice rechecked `validateProjectConfig()` and `src/runtime/config.ts`. The support-analysis target remains current: `validateProjectConfig()` still validates project config diagnostics, and the new `watch.autoRefresh` field is an additional watch-policy diagnostic rather than a change to the support-command accuracy conclusions here.
