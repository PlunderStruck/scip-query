# CLI Command Descriptor Conversion

## Compression Thesis

The CLI command surface should be a metadata-rendered surface. The real referents are the current Commander registrations, option declarations, descriptions, query calls, render calls, CLI contract tests, help output, README command reference, and agent docs. These all describe the same user-facing command surface, so one command descriptor model should own the facts that are currently repeated across runtime files, tests, and docs.

A command descriptor is a typed record for one CLI command: its name, arguments, options, description, hidden status, execution shape, budget needs, query or operation, renderer, empty state, heuristic notice, and documentation metadata. It lets the program register the command, verify its contract, and document it from one source of truth.

The conversion is not another helper extraction. It is a change in ownership: command metadata becomes data, while command behavior becomes a small set of executor and renderer functions referenced by that data.

## Current Evidence

- `node dist/cli.js health --json` reports score `95`, with `0` dead symbols, `0` isolated symbols, `0` cycles, and `0` similar pairs. The repo is not broadly unhealthy.
- `rg -n "\.command\(" src/runtime/*.ts | wc -l` reports `58`; `rg -n "\.action\(" src/runtime/*.ts | wc -l` reports `60`.
- [src/runtime/render.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/runtime/render.ts:1) already identifies the principle: most commands are "run query -> pick a render shape."
- [src/runtime/cli-core-commands.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/runtime/cli-core-commands.ts:9), [src/runtime/cli-graph-commands.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/runtime/cli-graph-commands.ts:6), [src/runtime/cli-health-commands.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/runtime/cli-health-commands.ts:6), and [src/runtime/cli-maintenance-commands.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/runtime/cli-maintenance-commands.ts:14) each repeat the same role: register command metadata, parse options, open context, run behavior, render output, and handle empty/error cases.
- [tests/cli-contract.test.ts](/Users/aydansalois/Documents/GitHub/scip-query/tests/cli-contract.test.ts:14) repeats command names, descriptions, options, and heuristic labels that already exist in the runtime registrations.
- `node dist/cli.js drift --min-deviation 3` reports one layer violation: [src/runtime/cli-maintenance-commands.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/runtime/cli-maintenance-commands.ts:72) imports TypeScript semantic status directly from `src/semantic`.

## Required End State

Every command currently registered in the four runtime registrar files must be represented by command descriptors. The root CLI should register descriptors through one registry executor instead of hand-building Commander chains throughout four files.

Commands with simple query-render behavior should use standard descriptor shapes. Commands with special behavior should still be descriptors, but they may reference named custom executor or renderer functions. The custom function is the exception point; the metadata and registration still live in the descriptor table.

The following facts must be descriptor-owned for every command:

- command name and argument signature
- description
- hidden status
- option flags, descriptions, parsers, default values, and collectors
- heuristic/candidate classification
- semantic budget requirements and scan-limit requirements
- database requirement, project-root requirement, or no-database execution requirement
- query/operation function or named custom handler
- renderer shape or named custom renderer
- empty message
- JSON output mode when supported
- documentation category and examples when the command belongs in generated docs

## Files To Add

### `src/runtime/command-descriptor-types.ts`

Own the command descriptor vocabulary.

Required concepts:

- `CommandDescriptor`
- `CommandOptionDescriptor`
- `CommandArgumentDescriptor`
- `CommandExecutionContext`
- `CommandBudgetPolicy`
- `CommandRenderShape`
- `CommandDocumentation`
- `CommandHeuristicNotice`

The type model must allow all current commands without using untyped escape hatches. A custom handler is allowed, but it must still sit behind a typed descriptor field.

### `src/runtime/command-registry.ts`

Own the conversion from descriptors to Commander registrations.

Responsibilities:

- apply name, description, arguments, options, hidden status
- apply parser and collector functions
- create execution context
- open and close the database when required
- compute command analysis budget when requested
- call standard query executors or custom handlers
- apply standard renderers or custom renderers
- print empty states and heuristic notices
- preserve exit/error behavior

### `src/runtime/command-descriptors.ts`

Own the full command list.

This file should export the ordered descriptor array used by the CLI. The order must preserve current help order unless a test explicitly updates it.

### `src/runtime/command-handlers.ts`

Own custom command behavior that cannot be expressed as a simple query-render descriptor.

Examples:

- `reindex`
- `augment-sources`
- `augment-vue`
- `dead`
- `trace`
- `outline`
- `fan-in`
- `fan-out`
- `coupling`
- `cycles`
- `diff-impact`
- `health-phase`
- `health`
- `convergence`
- `code`
- `dataflow`
- `slice`
- `check-deps`
- `init`
- `watch`
- `status`

These should be named behavior functions referenced from descriptors, not inline Commander chains.

### `src/runtime/command-renderers.ts`

Own command-specific renderers that do not belong in the generic `render` registry.

This prevents `command-handlers.ts` from becoming a mixed executor/formatter module.

### `src/runtime/command-docs.ts`

Own descriptor-to-documentation helpers.

The first implementation only needs enough structure to let tests verify docs metadata exists. Later, it should render README command tables and agent guide command lists from descriptors.

## Files To Change

### `src/runtime/cli.ts`

Replace the four registrar calls with a single descriptor registration call.

Target shape:

```ts
import { commandDescriptors } from './command-descriptors.js';
import { registerCommandDescriptors } from './command-registry.js';

registerCommandDescriptors(program, commandDescriptors);
```

Keep `program`, version setup, `renderHeuristicNotice` export compatibility, and entrypoint parsing behavior stable.

### `src/runtime/cli-core-commands.ts`

Remove command registration logic after its commands have descriptors and handlers.

Either delete the file or keep a compatibility export that forwards only if public consumers require it. `change-surface` currently shows `registerCoreCommands()` is only consumed by `src/runtime/cli.ts`, so deletion is expected after migration.

### `src/runtime/cli-graph-commands.ts`

Remove command registration logic after graph commands have descriptors and handlers.

Expected command descriptors:

- `bottlenecks`
- `isolated`
- `by-kind`
- `kind-counts`
- `deep-chains`
- `hierarchy`
- `call-graph`
- `similar`
- `similar-files`
- `similar-chains`
- `extract-candidates`
- `affected`
- `change-surface`
- hidden diff-impact batch command

### `src/runtime/cli-health-commands.ts`

Remove command registration logic after health and insight commands have descriptors and handlers.

Expected command descriptors:

- `diff-impact`
- `drift`
- `wrapper-candidates`
- `passthrough-candidates`
- `stale-abstractions`
- `complexity-hotspots`
- hidden health phase command
- `health`
- `convergence`
- `code`
- `complexity`
- `dataflow`
- `slice`

### `src/runtime/cli-maintenance-commands.ts`

Remove command registration logic after maintenance commands have descriptors and handlers.

Expected command descriptors:

- `install-skills`
- `check-deps`
- `redundant-reexports`
- `similar-signatures`
- `init`
- `watch`
- `status`

Move TypeScript semantic readiness reporting behind a runtime-facing readiness function so this file no longer imports from `src/semantic` directly.

### `src/runtime/cli-support.ts`

Keep budget, isolated process, and report-rendering helpers if they remain coherent. Move command-specific rendering into `command-renderers.ts` where appropriate.

The `commandAnalysisBudget()` policy should be referenced from descriptors instead of manually called in each command body.

### `src/runtime/render.ts`

Keep the generic render registry. Do not turn it into a command-specific dumping ground. Add generic shapes only when at least two descriptors use the same output form.

### `tests/cli-contract.test.ts`

Change contract tests to read descriptor metadata as the source of expected command names, descriptions, options, hidden status, and heuristic labels. Then separately assert Commander was registered from descriptors.

### `tests/command-accuracy.test.ts`

Keep query accuracy assertions focused on query functions. Add or preserve CLI-level smoke tests only for behavior that descriptors could break: option parsing, custom handlers, JSON mode, hidden commands, and heuristic notices.

### `README.md`

Replace hand-maintained command reference sections with descriptor-generated output or a generated checked-in section. The command examples can remain hand-authored when they teach workflows rather than syntax.

### `docs/AGENT_GUIDE.md`

Keep workflow guidance hand-authored. Replace command lists, option references, and command categorization with descriptor-generated content or verified snippets from descriptors.

## Conversion Rules

1. Preserve command names, aliases, option flags, default values, descriptions, hidden status, output text, JSON shapes, and exit behavior unless a test intentionally documents a change.
2. Convert every command into a descriptor. Do not leave an inline Commander registration behind as a convenience escape hatch.
3. Use custom handlers for special lifecycles, but register them through descriptors.
4. Keep query modules pure. Do not move CLI parsing or rendering into `src/queries`.
5. Keep docs generated or verified from descriptors where they repeat command syntax.
6. Keep the public root exports stable unless a separate public API migration is explicitly planned.
7. Do not widen `src/index.ts` just to expose runtime internals.
8. Do not introduce a large flag-swamp function. If a descriptor kind becomes too broad, split the descriptor union into clearer variants.
9. Keep command order stable.
10. Preserve heuristic disclaimers for candidate commands.

## Descriptor Kinds

### Query List Command

For commands that call one query and render one row per result.

Examples:

- `files`
- `deps`
- `rdeps`
- `surface`
- `members`
- `hierarchy`
- `redundant-reexports` with grouped rendering

### Query Table Command

For commands that call one query and render aligned columns.

Examples:

- `hotspots`
- `bottlenecks`
- `kind-counts`
- `complexity-hotspots`
- top `fan-in`
- top `fan-out`

### Query Section Command

For commands that call one query and render named sections.

Examples:

- `system`
- `call-graph`
- parts of `trace`

### Candidate Command

For heuristic commands that must print a candidate disclaimer.

Examples:

- `similar`
- `similar-files`
- `similar-chains`
- `extract-candidates`
- `drift`
- `wrapper-candidates`
- `passthrough-candidates`
- `stale-abstractions`
- `complexity-hotspots`
- `similar-signatures`

### Operational Command

For commands that do work outside the database query path.

Examples:

- `reindex`
- `augment-sources`
- `augment-vue`
- `install-skills`
- `check-deps`
- `init`
- `watch`
- `status`

### Isolated Process Command

For commands that intentionally run analysis in isolated processes to control memory.

Examples:

- `health`
- `diff-impact`
- hidden health phase command
- hidden diff-impact batch command

## Phased Implementation

### Phase 1: Descriptor Infrastructure

- Add descriptor types.
- Add descriptor registry.
- Add test-only descriptor introspection helpers.
- Convert `files`, `deps`, `rdeps`, `members`, and `kind-counts`.
- Verify Commander registration matches descriptor metadata.

Validation:

```bash
npm run typecheck
npm test -- tests/cli-contract.test.ts
node dist/cli.js files src/runtime
node dist/cli.js kind-counts
```

### Phase 2: Core Navigation Commands

- Convert `symbols`, `methods`, `refs`, `trace`, `system`, `surface`, `imports`, `imported-by`, `unused-imports`, `outline`, `fan-in`, `fan-out`, `coupling`, and `cycles`.
- Use custom renderers where the current output is special.

Validation:

```bash
npm test -- tests/cli-contract.test.ts tests/command-accuracy.test.ts
node dist/cli.js trace ProjectIndex
node dist/cli.js system runtime
node dist/cli.js fan-in ProjectIndex
```

### Phase 3: Graph And Candidate Commands

- Convert all graph and candidate commands.
- Make heuristic classification descriptor-owned.
- Keep output notices byte-for-byte stable.

Validation:

```bash
npm test -- tests/cli-contract.test.ts tests/command-accuracy.test.ts
node dist/cli.js wrapper-candidates --max-loc 20
node dist/cli.js stale-abstractions --min-loc 1 --include-low-confidence
node dist/cli.js drift --min-deviation 3
```

### Phase 4: Health And Isolated Process Commands

- Convert `health`, hidden health phase, `diff-impact`, hidden diff-impact batch, `complexity`, `dataflow`, `slice`, `code`, and `convergence`.
- Keep isolated process behavior intact.

Validation:

```bash
npm test -- tests/cli-contract.test.ts tests/command-accuracy.test.ts
node dist/cli.js health --json
node dist/cli.js diff-impact
node dist/cli.js code ProjectIndex
```

### Phase 5: Operational And Maintenance Commands

- Convert `reindex`, `augment-sources`, `augment-vue`, `install-skills`, `check-deps`, `init`, `watch`, and `status`.
- Move semantic readiness behind a runtime-facing readiness boundary.
- Remove direct runtime-to-semantic drift.

Validation:

```bash
npm test -- tests/reindex-reliability.test.ts tests/reindex-install.test.ts tests/watch.test.ts tests/setup.test.ts tests/scip-cli.test.ts
node dist/cli.js status
node dist/cli.js check-deps
node dist/cli.js drift --min-deviation 3
```

### Phase 6: Delete Old Registrars

- Delete or empty `cli-core-commands.ts`, `cli-graph-commands.ts`, `cli-health-commands.ts`, and `cli-maintenance-commands.ts`.
- Confirm `src/runtime/cli.ts` registers only descriptor arrays.
- Confirm no `.command(` calls remain outside `command-registry.ts`, except tests or intentional Commander setup.

Validation:

```bash
rg -n "\.command\(" src/runtime
rg -n "register(Core|Graph|Health|Maintenance)Commands" src tests
npm run typecheck
npm test
```

### Phase 7: Descriptor-Verified Docs

- Add descriptor docs rendering.
- Generate or verify README command reference from descriptors.
- Generate or verify AGENT_GUIDE command lists from descriptors.
- Keep workflow prose hand-authored.

Validation:

```bash
npm test -- tests/cli-contract.test.ts
rg -n "scip-query .*--" README.md docs/AGENT_GUIDE.md
```

## Completion Evidence

The conversion is complete only when:

- all CLI commands are represented by descriptors
- command registration flows through `registerCommandDescriptors`
- no handwritten `.command(...)` registration remains in the old registrar files
- CLI contract tests derive expectations from descriptors and verify Commander registration
- command behavior tests pass
- docs command reference is generated from or checked against descriptors
- `node dist/cli.js health --json`, `node dist/cli.js status`, `node dist/cli.js check-deps`, and representative query commands still work
- `node dist/cli.js drift --min-deviation 3` no longer reports the runtime-to-semantic layer violation
- `npm run typecheck` and `npm test` pass

## Risks

Descriptor overgeneralization is the main risk. The fix is a discriminated union of descriptor kinds, not a single generic command object with many unrelated optional fields.

Output drift is the second risk. The fix is contract tests around representative command output and descriptors that preserve existing renderers until a deliberate output change is chosen.

Documentation generation can become a distraction. The correct order is runtime descriptors first, docs verification second, generated docs third.
