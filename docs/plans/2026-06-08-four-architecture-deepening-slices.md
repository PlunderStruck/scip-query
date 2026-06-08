# Four Architecture Deepening Slices

Date: 2026-06-08
Scope: current checkout of `scip-query`

This note records the four live deepening opportunities selected after the
latest architecture review. The repo is already healthy by its own detectors:
local health reports score 100 with no dead symbols, stale abstractions, drift,
wrappers, or passthroughs. These slices therefore target maintainer locality and
caller leverage, not ordinary cleanup.

A module is a code unit whose callers depend on an interface while its
implementation can change behind that interface. A deepening slice is a refactor
that puts repeated lifecycle, evidence, or rendering knowledge behind a smaller
module interface so later callers do not relearn the same policy.

## 1. Vue reference computation context

Files:

- `src/reindex/augment-vue.ts`
- `src/reindex/augment-vue-runtime.ts`
- `src/reindex/augment-vue-workers.ts`

Problem: the direct Vue augmentation path and the readonly worker path both
assemble the same local computation facts: source reader, Volar language
context, symbol lookup, Vue-symbol lookup, and the file/task set. The direct
path owns the writable transaction and worker dispatch; the worker path owns a
readonly database and bounded task input. Those lifecycles are different, but
the local computation setup is the same.

Solution: introduce a Vue reference computation context that builds the shared
local setup once for each path while keeping transaction and worker lifecycles
explicit.

Benefits: Volar setup, source reading, and symbol lookup drift is fixed in one
place. Tests can keep covering direct and worker behavior through unchanged
entry points.

## 2. Query command report shapes

Files:

- `src/runtime/command-execution.ts`
- `src/runtime/query-command-builders.ts`
- `src/runtime/query-commands/*.ts`

Problem: simple list, table, and grouped commands have a deep command interface,
but custom report commands still repeat report mechanics: empty states,
heuristic notices, section headings, row rendering, and final summaries.

Solution: add report-shaped command builders for sectioned reports and row
reports, then migrate suitable commands without changing command behavior.

Benefits: command modules describe query intent and report rows while shared
runtime code owns repetitive report mechanics.

## 3. Caller evidence interface

Files:

- `src/symbols/caller-evidence.ts`
- `src/symbols/call-graph-evidence.ts`
- `src/symbols/reference-callers.ts`
- `src/core/project-index.ts`

Problem: callers can still reach caller facts through several interfaces:
targeted caller rows, inverted callee maps, cross-file caller maps, resolved
references, semantic references, and source fallback maps. The facts are related
but the selection policy is scattered.

Solution: add a caller evidence module that owns the bulk caller-file map and
source fallback merge policy, then route query-facing callers through it.

Benefits: queries ask for caller evidence rather than composing cross-file,
semantic, and source fallback maps themselves. Evidence source modules remain
separate adapters behind one caller-facing module.

## 4. Isolated analysis runner

Files:

- `src/runtime/isolated-analysis-runner.ts`
- `src/runtime/cli-support.ts`

Problem: health phases and diff-impact batches both run isolated subprocess
analysis, parse JSON output, propagate selected command-line/environment state,
and report subprocess failures. The mechanics live in `cli-support.ts` rather
than behind a named runner.

Solution: introduce an isolated analysis runner for spawning the current CLI,
parsing JSON results, and chunking batch work.

Benefits: subprocess JSON handoff and failure reporting become one testable
interface. Health and diff-impact keep their own analysis semantics while
sharing process mechanics.

## Verification

Expected checks after implementation:

```bash
npm run typecheck
npm run lint
npm test
npm run build
node dist/cli.js health --json
node dist/cli.js diff-impact
node dist/cli.js refs ProjectIndex
node dist/cli.js call-graph ProjectIndex
node dist/cli.js cycles
node dist/cli.js similar --limit 5
```
