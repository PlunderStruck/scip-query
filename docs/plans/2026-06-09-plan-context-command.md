# Plan: `scip-query plan-context <target>`

Date: 2026-06-09

## Goal

`plan-context` should give an AI coding agent the code facts it needs before editing. A coding agent is a program that reads, changes, and verifies source code on a user's behalf; what makes this command useful to that agent is that it gathers the structural facts that normally require several separate `scip-query` calls and presents them as one preparation report.

The target is the user-supplied name or path that anchors the report. It may refer to a symbol, a file, or a module. A symbol is an indexed named program unit, such as a function, class, method, variable, or module export, identified by SCIP occurrences and useful because references can be traced to it. A file is an indexed source document stored in the SCIP database. A module is a related set of indexed files matched by a path pattern. A dependency is a file or symbol that another file or symbol uses. Downstream impact is the set of consumers that may break after a target changes. Change risk is the expected fragility of editing a target, estimated from consumers, callers, dependencies, complexity, and breadth of impact.

Done means a user can run:

```bash
scip-query plan-context <target>
```

and receive a bounded, sectioned report containing definitions, references, callers, callees, dataflow, dependencies, reverse dependencies, surface consumers, downstream impact, complexity, and risk notes. The command must reuse existing compiler-resolved query functions instead of building a second analysis engine.

## Current State

The CLI entry point in `src/runtime/cli.ts:9-14` names the program, applies the version, and calls `registerCommandDescriptors(program, commandDescriptors)`; `src/runtime/cli.ts:21-22` parses the command line when the file is the executable entry point. Source: `scip-query code src/runtime/cli.ts:1-37`.

`src/runtime/command-descriptors.ts:41-74` inserts existing query descriptors into the top-level command list through `query('<id>')`, then registers the custom `diff-impact` commands at `src/runtime/command-descriptors.ts:75-91`. `src/runtime/command-descriptors.ts:124-128` already places later query commands such as `code`, `complexity`, `dataflow`, and `slice` after health commands. Source: `scip-query code src/runtime/command-descriptors.ts:1-176`.

`src/runtime/query-command-specs.ts:9-56` defines the required query command order. `src/runtime/query-command-specs.ts:58-65` groups descriptor families, `src/runtime/query-command-specs.ts:70-74` maps ordered IDs back to descriptors, and `src/runtime/query-command-specs.ts:76-79` throws when a descriptor exists but is missing from the order. Source: `scip-query code src/runtime/query-command-specs.ts:1-87`.

Navigation commands already cover most local context. `src/runtime/query-commands/navigation.ts:158-167` wires `trace <symbol>` to `queries.trace`; `src/runtime/query-commands/navigation.ts:168-183` wires `deps <file>` and `rdeps <file>`; `src/runtime/query-commands/navigation.ts:184-207` wires `system <module>` and `surface <module>`; `src/runtime/query-commands/navigation.ts:278-309` wires `code`, `dataflow`, and `slice`. Source: `scip-query code src/runtime/query-commands/navigation.ts:120-312`.

Graph and impact commands provide the remaining high-value facts. `src/runtime/query-commands/graph.ts:212-230` renders `call-graph <symbol>` with callers and callees. `src/runtime/query-commands/impact.ts:41-63` registers `affected <symbol>` and `change-surface <file>`. `src/runtime/query-commands/health.ts:7-17` renders complexity metrics, and `src/runtime/query-commands/health.ts:19-28` registers `complexity <symbol>`. Sources: `scip-query code src/runtime/query-commands/graph.ts:118-232`, `scip-query code src/runtime/query-commands/impact.ts:1-65`, `scip-query code src/runtime/query-commands/health.ts:1-31`.

The query layer already exposes the needed data. `src/queries/trace.ts:25-60` returns source-corrected definitions and reference sites. `src/queries/call-graph.ts:24-61` returns incoming callers and outgoing callees. `src/queries/deps.ts:9-39` returns forward file dependencies, and `src/queries/deps.ts:42-72` returns reverse file dependencies. `src/queries/system.ts:18-89` returns matched files, exported symbols, dependencies, and reverse dependencies for a module. `src/queries/surface.ts:13-24` returns externally used module symbols. `src/queries/change-surface.ts:33-74` returns per-symbol consumer counts and risk labels. `src/queries/affected.ts:20-69` computes breadth-first downstream impact. `src/queries/dataflow.ts:36-78` returns definition sites, usage sites, producers, and consumers. `src/queries/slice.ts:32-46` returns backward or forward connected symbols. `src/queries/complexity.ts:36-67` returns LOC, branches, cyclomatic estimate, callee count, fan-in, and fan-out. Sources: `scip-query code trace -C 6`, `scip-query code callGraph -C 6`, `scip-query code deps -C 5`, `scip-query code rdeps -C 5`, `scip-query code system -C 6`, `scip-query code surface -C 5`, `scip-query code changeSurface -C 6`, `scip-query code affected -C 5`, `scip-query code dataflow -C 5`, `scip-query code slice -C 5`, `scip-query code complexity -C 5`.

Generated command documentation is descriptor-owned. `src/runtime/command-docs.ts:27-52` renders visible descriptors into the generated command reference. `scip-query trace renderCommandReferenceMarkdown` proves `scripts/render-command-reference.ts` references that renderer at lines 2 and 4, and `tests/cli-contract.test.ts` references it at lines 6 and 65, but `scip-query code tests/cli-contract.test.ts:1-120` could not read the test file. Sources: `scip-query trace renderCommandReferenceMarkdown`, `scip-query code renderCommandReferenceMarkdown -C 8`, `scip-query code tests/cli-contract.test.ts:1-120`.

Current blast radius is medium and descriptor-driven. `src/runtime/query-commands/navigation.ts` has two external consumers, `src/runtime/query-command-specs.ts` has two, `src/runtime/command-descriptors.ts` has two, and `src/queries/index.ts` has eight. Reverse dependencies show `navigation.ts -> query-command-specs.ts -> command-descriptors.ts -> cli.ts`, while `src/queries/index.ts` feeds all runtime command modules. Sources: `scip-query change-surface src/runtime/query-commands/navigation.ts`, `scip-query change-surface src/runtime/query-command-specs.ts`, `scip-query change-surface src/runtime/command-descriptors.ts`, `scip-query change-surface src/queries/index.ts`, `scip-query rdeps src/runtime/query-commands/navigation.ts`, `scip-query rdeps src/runtime/query-command-specs.ts`, `scip-query rdeps src/runtime/command-descriptors.ts`, `scip-query rdeps src/queries/index.ts`.

## Reuse Audit

- `planContext(db, target, options)` should be a new query-layer aggregator, not a new graph algorithm. It must call `trace`, `callGraph`, `complexity`, `dataflow`, `slice`, `affected`, `changeSurface`, `deps`, `rdeps`, `system`, and `surface` directly. Source: `scip-query code src/queries/index.ts:1-93`; reuse targets verified by the query commands listed in Current State.
- `PlanContextResult` should be new because no existing result type combines symbol, file, and module evidence into one report. `scip-query similar-chains` found unrelated domain type chain similarities, `scip-query similar-files src/runtime/query-commands/navigation.ts` found no similar file pairs, and `scip-query similar traceSections` found no similar symbols. Source: `scip-query similar-chains`, `scip-query similar-files src/runtime/query-commands/navigation.ts`, `scip-query similar traceSections`.
- `planningQueryCommandDescriptors` should be a new runtime descriptor family if the command is placed in its own Planning docs category. Existing family registration supports adding one array at `src/runtime/query-command-specs.ts:58-65`. Source: `scip-query trace navigationQueryCommandDescriptors`, `scip-query trace impactQueryCommandDescriptors`, `scip-query trace graphQueryCommandDescriptors`, `scip-query code src/runtime/query-command-specs.ts:1-87`.
- `handlePlanContext` should reuse `budgetedDbCommand`, `stringArg`, `definedNumberOption`, `stringOptionValue`, `option`, `parseInteger`, `displayLine`, `displayRange`, `displayPathRange`, and `render.empty`. Source: `scip-query code budgetedDbCommand -C 8`, `scip-query code stringArg -C 5`, `scip-query code src/runtime/command-spec-builders.ts:1-30`, `scip-query code src/runtime/query-commands/navigation.ts:71-118`, `scip-query code src/runtime/query-commands/impact.ts:1-65`.
- A small internal row limiter, for example `limitedRows`, is justified because no existing exported runtime helper caps arbitrary section rows. `render.list` prints every row in existing handlers, while `plan-context` intentionally combines many result sets. Source: `scip-query code src/runtime/query-commands/navigation.ts:71-118`, `scip-query code src/runtime/query-commands/graph.ts:212-230`, `scip-query surface runtime`.

## Design Phases

### Phase 1 — Add the Query Aggregator

Deployable independently: yes, if the new query is exported and no command is registered yet.

#### 1.1 — Create the result model and aggregation function

- [x] **File**: `src/queries/plan-context.ts` (new)
- **Source**: `scip-query code trace -C 6`; `scip-query code callGraph -C 6`; `scip-query code dataflow -C 5`; `scip-query code complexity -C 5`; `scip-query code changeSurface -C 6`; `scip-query code system -C 6`; `scip-query code affected -C 5`.
- **What**: Today each command invokes one query at a time, so an agent must manually chain `trace`, `call-graph`, `deps`, `rdeps`, `surface`, `change-surface`, `affected`, `dataflow`, `slice`, and `complexity`.
- **Change**: Add exported interfaces `PlanContextOptions` and `PlanContextResult`, plus `planContext(db, target, options)`. The function should:
  - call symbol-oriented queries with `{ semantic: options.semantic }`: `trace`, `callGraph`, `complexity`, `dataflow`, `slice(... direction: 'backward')`, `slice(... direction: 'forward')`;
  - call `affected(db, target, { maxDepth: options.impactDepth ?? 3, scope: options.scope })`;
  - call file-oriented queries: `changeSurface(db, target, { semantic })`, `deps(db, target)`, and `rdeps(db, target)`;
  - call module-oriented queries: `system(db, target)` and `surface(db, target)`;
  - include `matched.symbol`, `matched.file`, and `matched.module` booleans derived from non-empty or non-null results;
  - include a warning `No symbol, file, or module matched target.` when all three target forms are empty.
- **Why**: This keeps the report's data contract testable in the query layer and avoids embedding analysis logic in CLI rendering.

#### 1.2 — Re-export the new query and types

- [x] **File**: `src/queries/index.ts:28-49` and `src/queries/index.ts:84-90`
- **Source**: `scip-query code src/queries/index.ts:1-93`
- **What**: The public query barrel exports existing query functions at `src/queries/index.ts:1-48` and result types at `src/queries/index.ts:50-92`.
- **Change**: Add `export { planContext } from './plan-context.js';` near the other impact/navigation-adjacent exports, and add `export type { PlanContextOptions, PlanContextResult } from './plan-context.js';` near the other result type exports.
- **Why**: Runtime command modules already import `* as queries from '../../queries/index.js'`; exporting here lets `plan-context` follow that pattern.

### Phase 2 — Add the CLI Renderer

Deployable independently: yes, if the file compiles but is not yet registered.

#### 2.1 — Add a Planning command module

- [x] **File**: `src/runtime/query-commands/planning.ts` (new)
- **Source**: `scip-query code src/runtime/query-commands/impact.ts:1-65`; `scip-query code src/runtime/query-commands/graph.ts:212-230`; `scip-query code src/runtime/query-commands/health.ts:1-31`; `scip-query code src/runtime/query-commands/navigation.ts:71-118`.
- **What**: Today renderers print single-purpose reports: impact prints affected symbols and change surface, graph prints callers/callees, health prints complexity, and navigation prints dataflow/slice.
- **Change**: Add `handlePlanContext = budgetedDbCommand('plan-context', ...)` and `planningQueryCommandDescriptors: CommandDescriptor[]`. The descriptor should be:

  ```ts
  {
    id: 'plan-context',
    command: 'plan-context <target>',
    description: 'Pre-edit planning context for a symbol, file, or module',
    options: [
      option('--impact-depth <n>', 'Maximum affected traversal depth', parseInteger, 3),
      option('--slice-depth <n>', 'Maximum backward slice depth', parseInteger, 3),
      option('-s, --scope <path>', 'Limit downstream impact to files matching path'),
      option('-n, --limit <n>', 'Rows per section', parseInteger, 20),
      option('--full', 'Run unbounded semantic analysis on large indexes'),
    ],
    budget: 'semantic',
    renderShape: 'custom',
    docs: doc('Planning', ['scip-query plan-context parseSymbol']),
    handler: handlePlanContext,
  }
  ```

- **Why**: `plan-context` is a user-facing command with semantic lookup pressure, so it should use the same budget path as `trace`, `call-graph`, `dataflow`, `slice`, `complexity`, and `change-surface`.

#### 2.2 — Render bounded planning sections

- [x] **File**: `src/runtime/query-commands/planning.ts` (new)
- **Source**: `scip-query code traceSections -C 5`; `scip-query code src/runtime/query-commands/navigation.ts:71-118`; `scip-query code src/runtime/query-commands/impact.ts:13-39`; `scip-query code src/runtime/query-commands/health.ts:7-17`.
- **What**: Existing renderers either print source lines (`handleCode`), sectioned definition/reference rows (`traceSections`), list dataflow endpoints (`handleDataflow`), or print risk metrics (`handleChangeSurface`, `handleComplexity`).
- **Change**: Render these sections in this order, truncating each list to `--limit` rows and printing `... N more` when truncated:
  - `TARGET`: whether the target matched as symbol, file, module;
  - `DEFINITIONS`: `trace.definitions` with `displayPathRange`, signature, and source lines;
  - `REFERENCES`: `trace.referencedBy`;
  - `CALL GRAPH`: callers and callees from `callGraph`;
  - `DATAFLOW`: producers and consumers from `dataflow`;
  - `DEPENDENCIES`: file deps/rdeps plus module deps/rdeps from `system`;
  - `SURFACE`: module consumer/symbol rows from `surface`;
  - `DOWNSTREAM IMPACT`: `affected` grouped by depth;
  - `CHANGE RISK`: `changeSurface.totalExternalConsumers`, per-symbol risk labels, and `complexity` metrics;
  - `PLANNING NOTES`: warning rows, plus fixed notes to inspect high-risk consumers before editing when risk is high.
- **Why**: The report must be dense enough for planning while bounded enough that a single command does not flood an agent context window.

#### 2.3 — Preserve graceful failures

- [x] **File**: `src/runtime/query-commands/planning.ts` (new)
- **Source**: `scip-query code src/runtime/query-commands/navigation.ts:71-118`; `scip-query code src/runtime/query-commands/impact.ts:30-39`; `scip-query code src/runtime/query-commands/health.ts:7-17`.
- **What**: Existing commands return `render.empty('Symbol not found.')` or `render.empty('File not found in index.')` when lookup fails.
- **Change**: If `PlanContextResult.warnings` contains only the no-match warning and all sections are empty, print `render.empty('No symbol, file, or module matched target.')`. Otherwise print the partial report and include warnings rather than failing the whole command.
- **Why**: A target may be a file but not a symbol, or a module but not a file; partial success is the useful behavior for this command.

### Phase 3 — Register the Command

Deployable independently: yes, after Phase 1 and Phase 2.

#### 3.1 — Add the Planning family to query specs

- [x] **File**: `src/runtime/query-command-specs.ts:1-87`
- **Source**: `scip-query code src/runtime/query-command-specs.ts:1-87`; `scip-query trace navigationQueryCommandDescriptors`; `scip-query trace impactQueryCommandDescriptors`.
- **What**: The file imports command families at `src/runtime/query-command-specs.ts:2-7`, orders IDs at `src/runtime/query-command-specs.ts:9-56`, and includes families at `src/runtime/query-command-specs.ts:58-65`. It throws if a descriptor is unordered at `src/runtime/query-command-specs.ts:76-79`.
- **Change**: Import `planningQueryCommandDescriptors` from `./query-commands/planning.js`, insert `'plan-context'` immediately after `'change-surface'` in `queryCommandOrder`, and add `planningQueryCommandDescriptors` after `impactQueryCommandDescriptors` in `queryCommandFamilies`.
- **Why**: Without this, `query('plan-context')` will throw `Unknown query command descriptor: plan-context`, or the order guard will reject the descriptor.

#### 3.2 — Add the top-level command descriptor

- [x] **File**: `src/runtime/command-descriptors.ts:41-75`
- **Source**: `scip-query code src/runtime/command-descriptors.ts:1-176`; `scip-query trace queryCommandDescriptor`.
- **What**: Top-level query commands are inserted with `query('<id>')`; `queryCommandDescriptor` throws for unknown IDs at `src/runtime/query-command-specs.ts:82-86`.
- **Change**: Add `query('plan-context')` immediately after `query('change-surface')`.
- **Why**: This makes `scip-query plan-context <target>` visible to Commander through the existing descriptor registration flow.

### Phase 4 — Documentation and Validation

Deployable independently: documentation and tests after Phase 3.

#### 4.1 — Extend the CLI contract test around generated docs

- [x] **File**: `tests/cli-contract.test.ts:65`
- **Source**: `scip-query trace renderCommandReferenceMarkdown`; `scip-query code tests/cli-contract.test.ts:1-120` returned `Symbol not found or file unreadable.`
- **What**: SCIP proves this test references `renderCommandReferenceMarkdown` at line 65, but SCIP cannot read the test body, so the exact assertion style must be confirmed during implementation.
- **Change**: Add an assertion in the existing command-reference test that the rendered reference contains `` `plan-context <target>` `` and the Planning category. Keep the assertion style already used in that file.
- **Why**: The generated command reference is descriptor-owned; adding a descriptor should update docs and the contract test should catch missing docs metadata.

#### 4.2 — Add command smoke coverage

- [x] **File**: `tests/cli-contract.test.ts:65`
- **Source**: `scip-query trace commandDescriptors`; `scip-query trace renderCommandReferenceMarkdown`.
- **What**: `commandDescriptors` feeds `src/runtime/cli.ts:14`, and the docs renderer is already test-referenced.
- **Change**: Add a smoke assertion, in the nearest existing CLI descriptor test, that `commandDescriptors` contains an entry with `id === 'plan-context'`, `command === 'plan-context <target>'`, `budget === 'semantic'`, and `renderShape === 'custom'`.
- **Why**: The highest-risk failure is registration drift: a descriptor can exist in a family but not be ordered or top-level registered.

#### 4.3 — Regenerate command reference

- [x] **File**: `docs/COMMAND_REFERENCE.md` (generated command section)
- **Source**: `scip-query trace renderCommandReferenceMarkdown`; `scip-query code renderCommandReferenceMarkdown -C 8`.
- **What**: `renderCommandReferenceMarkdown` says the syntax summary is generated from CLI command descriptors at `src/runtime/command-docs.ts:31-34`.
- **Change**: Run the existing command-reference generation path used by `scripts/render-command-reference.ts` so the generated section includes the Planning category and `plan-context <target>`.
- **Why**: Users discover syntax from the generated reference, and descriptor-owned docs should stay in sync with the command table.

#### 4.4 — Run manual behavior checks

- [x] **File**: no file edit
- **Source**: `scip-query code src/runtime/cli.ts:1-37`; `scip-query code src/runtime/query-command-specs.ts:1-87`; `scip-query code src/runtime/query-commands/navigation.ts:120-312`; `scip-query code src/runtime/query-commands/impact.ts:1-65`.
- **What**: The command registry will expose the command only after descriptor wiring is complete.
- **Change**: After implementation, run:

  ```bash
  scip-query reindex
  scip-query plan-context queryCommandDescriptor
  scip-query plan-context src/runtime/query-commands/navigation.ts
  scip-query plan-context src/runtime --impact-depth 2 --limit 5
  scip-query diff-impact
  ```

- **Why**: These checks cover symbol, file, and module targets, then compare the actual git diff blast radius against the plan.

## Stress-Test Findings

1. Understand before touch: The command is a composition over existing query primitives, not a new analyzer. Current entry points and query behavior are mapped in Current State. Sources: `scip-query system runtime`, `scip-query code src/runtime/query-command-specs.ts:1-87`, `scip-query code src/queries/index.ts:1-93`.
2. Blast radius: The riskiest files are descriptor barrels and the query barrel. `change-surface` marks them medium risk; `rdeps` shows the path into `cli.ts`. Sources: `scip-query change-surface src/runtime/query-command-specs.ts`, `scip-query change-surface src/runtime/command-descriptors.ts`, `scip-query change-surface src/queries/index.ts`, `scip-query rdeps src/queries/index.ts`.
3. Valid intermediate states: Phase 1 adds an exported query, Phase 2 adds an unregistered renderer, Phase 3 registers the command, Phase 4 updates docs/tests. No phase requires deleting or renaming existing symbols. Sources: `scip-query deps src/runtime/query-command-specs.ts`, `scip-query deps src/runtime/command-descriptors.ts`, `scip-query deps src/runtime/query-commands/navigation.ts`.
4. Reversibility: All steps are additive. Rollback removes `query('plan-context')`, removes the ordered ID/family import, removes the exported query, then deletes the two new files.
5. Failure design: Missing target must produce `No symbol, file, or module matched target.` Partial matches must render available sections. Existing commands already use `render.empty` for missing symbols and files. Sources: `scip-query code src/runtime/query-commands/navigation.ts:71-118`, `scip-query code src/runtime/query-commands/impact.ts:30-39`.
6. Concurrency: The command reads from the SCIP SQLite database through `withDb`; it does not write files or shared mutable state. Source: `scip-query code dbCommand -C 8`.
7. Boundaries: The CLI command is a trust boundary over user input. It should pass the raw target only into existing query functions and parse numeric options through `parseInteger`. Source: `scip-query code src/runtime/command-registry.ts:1-41`, `scip-query code src/runtime/command-spec-builders.ts:1-30`.
8. Data integrity: No database schema or source data writes are introduced. Existing read-only query functions issue SELECT-style lookups and return result objects. Sources: `scip-query code changeSurface -C 6`, `scip-query code system -C 6`, `scip-query code deps -C 5`.
9. Observability: This is a CLI report, so observability is the output. The plan adds warnings and explicit target match state to explain why sections are missing.
10. Human experience: The command must be bounded by `--limit` and grouped into planning sections so users and agents can scan it. Existing unbounded list renderers are unsuitable for a combined report. Source: `scip-query code src/runtime/query-commands/navigation.ts:71-118`.
11. Reuse over reimplement: Every analysis fact comes from an existing query; the only new code aggregates and renders. Reuse audit commands found no existing complete plan-context flow. Sources: `scip-query similar-chains`, `scip-query similar-files src/runtime/query-commands/navigation.ts`, `scip-query similar traceSections`, `scip-query surface runtime`.

## Execution Order

1. Phase 1: add `src/queries/plan-context.ts`, then export it from `src/queries/index.ts`.
2. Phase 2: add `src/runtime/query-commands/planning.ts`.
3. Phase 3: register the family in `src/runtime/query-command-specs.ts`, then register the top-level command in `src/runtime/command-descriptors.ts`.
4. Phase 4: update tests/docs, run reindex, run symbol/file/module smoke checks, run `scip-query diff-impact`.

No step within a phase depends on a later phase. Phase 3 depends on Phase 1 and Phase 2.

## Ship Order

Ship as one small additive change. There are no one-way doors: no schema migrations, no deletes, no public command behavior changes except adding `plan-context`.

Baseline verification note: `scip-query diff-impact` before this plan already reported changed files `src/runtime/command-descriptors.ts` and `src/runtime/setup.ts`, with affected consumers `src/runtime/cli.ts`, `src/runtime/index.ts`, `src/runtime/command-handlers.ts`, and `src/runtime/postinstall.ts`. Those changes predate this plan and must not be reverted by the implementation.

The requested subagent verification step from the planning workflow was not run because the available subagent tool permits spawning only when the user explicitly requests subagents or delegation. Direct verification was run with `scip-query reindex`, `scip-query diff-impact`, `scip-query change-surface`, `scip-query rdeps`, `scip-query trace`, and `scip-query code`.

Implementation verification completed:

- `npm run typecheck`: passed.
- `npm test`: passed, 40 files and 197 tests.
- `npm run lint`: passed.
- `npm run build`: passed and emitted `dist/queries/plan-context.js` plus `dist/queries/plan-context.d.ts`.
- `node dist/cli.js reindex`: passed after implementation.
- `node dist/cli.js plan-context queryCommandDescriptor --limit 5`: passed for a symbol target.
- `node dist/cli.js plan-context src/runtime/query-commands/navigation.ts --limit 5`: passed for a file target.
- `node dist/cli.js plan-context src/runtime --impact-depth 2 --limit 5`: passed for a module target.
- `node dist/cli.js diff-impact`: completed; expected blast radius includes the new plan-context files plus the pre-existing dirty `src/runtime/setup.ts` changes.

## Summary

Files to create:

- `src/queries/plan-context.ts`
- `src/runtime/query-commands/planning.ts`

Files to modify:

- `src/queries/index.ts`
- `src/runtime/query-command-specs.ts`
- `src/runtime/command-descriptors.ts`
- `tests/cli-contract.test.ts`
- `docs/COMMAND_REFERENCE.md`

Files to delete: none.

Estimated net code delta: about 220-320 lines, mostly result typing and bounded rendering. The analysis logic delta should stay small because it delegates to existing query functions.
