# Query Command Spec Compression Atlas

## Scope Map

This pass targets the CLI query command surface.

Relevant files:

- `src/runtime/command-descriptors.ts`
- `src/runtime/query-command-handlers.ts`
- `src/runtime/command-execution.ts`
- `src/runtime/command-descriptor-types.ts`
- `src/runtime/command-docs.ts`
- `src/runtime/command-registry.ts`
- `tests/cli-contract.test.ts`
- `tests/command-accuracy.test.ts`

## Role Inventory

A command declaration is the stable user-facing record for a CLI operation: its command name, arguments, options, description, documentation category, budget policy, heuristic notice, render shape, and implementation entry point. Its essential role is to be the single fact from which registration, help text, docs, and invocation behavior are derived.

A query command handler is the executable projection from parsed CLI input to a query result and rendered output. Its essential role is to adapt a pure query module to the terminal without changing query semantics.

A query command spec is a command declaration whose handler lives with the declaration. Its essential role is to make a query command a single maintained unit instead of a descriptor entry in one file and a same-named handler entry in another.

## Opportunity Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| C1 | Move query command metadata next to query command execution. | Every query command has a descriptor entry in `command-descriptors.ts` and a matching `handle*` export in `query-command-handlers.ts`. Changing a command requires editing both. | merge |
| C2 | Keep process/lifecycle commands in `command-descriptors.ts`. | `reindex`, `augment-*`, `diff-impact`, `health`, `install-skills`, `check-deps`, `init`, `watch`, and `status` manage process lifecycle, subprocesses, config, or isolated workers rather than pure query rendering. | keep |
| C3 | Centralize descriptor builder helpers. | `option()`, `doc()`, and parser aliases are descriptor construction policy, not query-command policy. | extract |
| C4 | Preserve public command order. | CLI help and docs are order-sensitive enough that reordering commands would be a behavior change even if tests did not catch it. | enforce |
| C5 | Keep `queries/index.ts` as public API barrel for now. | The package root exports query functions and types for library consumers. Folding exports into command specs would entangle CLI shape with package API. | skip |

## Compression Clusters

Cluster A: Query Command Specs

- New mechanism: `src/runtime/query-command-specs.ts` owns each query command's metadata and handler together.
- Old mechanisms: query metadata in `command-descriptors.ts` plus query handler exports in `query-command-handlers.ts`.
- Validation: CLI contract, command accuracy, full tests, build, local command smoke checks.

Cluster B: Descriptor Builders

- New mechanism: a small builder module for command option/doc helpers and parser aliases.
- Old mechanism: builder helpers local to `command-descriptors.ts`, making them unavailable to query specs without duplication.
- Validation: CLI option flag tests and docs generation tests.

## Dependency Order

1. Extract descriptor builders first.
2. Convert `query-command-handlers.ts` into `query-command-specs.ts` by adding metadata next to each handler.
3. Replace duplicated query descriptor entries in `command-descriptors.ts` with references to query specs while preserving command order.
4. Verify CLI contract, command outputs, build, reindex, and health.

## Implementation Log

- Extracted descriptor construction helpers into `src/runtime/command-spec-builders.ts`.
- Converted the query handler module into `src/runtime/query-command-specs.ts`, where every query command now owns its descriptor metadata and handler together.
- Reduced `src/runtime/command-descriptors.ts` to lifecycle/process commands plus ordered `query('<id>')` references for query commands.
- Preserved `queries/index.ts` as the public query API barrel because library exports and CLI command declarations are separate surfaces.
- Preserved command order, command ids, option parsers, render shapes, budget policies, heuristic notices, docs categories, and examples.
- Added `listQueryCommand`, `tableQueryCommand`, and `groupedQueryCommand` so simple query commands declare metadata, query invocation, and rendering as one command-spec unit instead of a `handleX` plus a separate descriptor.
- Converted `files`, `symbols`, `methods`, `deps`, `rdeps`, `surface`, `hotspots`, `imported-by`, `members`, `by-kind`, `kind-counts`, `hierarchy`, and `redundant-reexports` to the new command-spec algebra.
- Kept row/table/group command execution spec shapes internal to `command-execution.ts`; the query spec module now reuses the function parameter types rather than importing single-consumer exported type aliases.

## Verification Log

- `npm run typecheck`
- `npm run lint`
- `npm test -- tests/cli-contract.test.ts tests/command-accuracy.test.ts` - 27 tests passed.
- `npm test` - 177 tests passed.
- `npm run build`
- `node dist/cli.js reindex --force --allow-partial`
- `node dist/cli.js health --json` - health score 100.
- `node dist/cli.js stats`
- `node dist/cli.js files command-specs`
- `node dist/cli.js trace queryCommandDescriptor`
- `node dist/cli.js refs queryCommandDescriptor`
- `node dist/cli.js drift --min-deviation 3` - no drift detected.
- `node dist/cli.js wrapper-candidates --max-loc 30` - four existing heuristic candidates remained.
- `node dist/cli.js passthrough-candidates --max-loc 30` - no passthrough candidates found.
- `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 80` - no stale abstractions found.

Second algebra slice:

- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm test -- tests/cli-contract.test.ts tests/command-accuracy.test.ts tests/redundant-reexports-fallback.test.ts` passed: 3 files, 28 tests.
- `npm test` passed: 36 files, 177 tests.
- `npm run build` passed.
- `node dist/cli.js reindex --force --allow-partial` passed.
- `node dist/cli.js health --json` reported score 100 and zero findings.
- `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 80` reported no stale abstractions.
- `node dist/cli.js drift --min-deviation 3` reported no drift.
- `node dist/cli.js symbols src/runtime/query-command-specs.ts | rg "handle(Files|Symbols|Methods|Deps|Rdeps|Surface|Hotspots|ImportedBy|Members|ByKind|KindCounts|Hierarchy|RedundantReexports)|listQueryCommand|tableQueryCommand|groupedQueryCommand|queryCommandDescriptors"` showed only the new command builders and `queryCommandDescriptors`; the converted `handleX` symbols are gone from the refreshed index.
