# TypeScript accuracy discovery recorders

These recorders exercise the real index and query implementation against compiler-valid programs with independent expected behavior. They intentionally **record tool failures without making each discovered defect a failing Vitest assertion**. A green test means the recorder completed; inspect the report to judge the tool.

The ordinary test suite does not include these `*.audit.ts` files. No agents or agent benchmarks are involved.

## Run

Use an existing build matching the source under audit. For a new code revision, build first with `npm run build`; do not rebuild a frozen audit baseline during discovery.

```sh
npx tsc -p benchmarks/typescript-accuracy-audit/tsconfig.json
SCIP_QUERY_AUDIT_OUTPUT=/tmp/scip-query-ts-discovery npx vitest run --config benchmarks/typescript-accuracy-audit/vitest.config.ts
node benchmarks/typescript-accuracy-audit/summarize.mjs /tmp/scip-query-ts-discovery /tmp/scip-query-ts-discovery/report.json
```

Read `report.json` programmatically; the raw graph packets contain repeated coverage text and are unsuitable for wholesale model output. The historical report uses compiler 6.0.2 and Node 26.8.1; a different installed compiler/configuration defines a different measurement context.

- `run.audit.ts`: 472 closed programs, compiler diagnostics, independent execution, invocation counts, selected compiler references, call targets, values, and parameter transfers. The source includes a fully enumerated 320-case composition space and 24 behavior-preserving variants.
- `histories.audit.ts`: eleven source/configuration transitions, independent compiler facts, and graph comparison with a separate clean repository at every step. Records the actual refresh path used.
- `public.audit.ts`: fifteen built-CLI projections, incoming call checks, bounded fold accounting, complete source pagination, thirteen module-reference forms, and three runtime-boundary path counterexamples. The `fetch` replacement records the argument without network access.
- `diagnosis.audit.ts`: raw SCIP versus definition catalog, plus local/imported write-binding controls.

Repositories and watchers created by the recorders are disposable fixtures and are cleaned up. They do not operate on an existing project watcher. The output directory retains JSON observations and the main corpus's binary SCIP; it must not contain user source that these scripts could overwrite.

## Exact-claim follow-up

The additional corpus contains 214 programs. It preserves the original 472 cases and adds independently executed call identities, cross-file writers, implicit evaluation effects, constructor decorators, alias formatting controls, and parameter-transfer forms. `runtime-call-trace.ts` instruments a second execution of selected programs; its outcome must match uninstrumented execution. The last recorded callable is used only for cases explicitly constructed to end in one marked leaf invocation. Absence from an arbitrary runtime trace is not treated as proof against a static may-call relationship.

```sh
SCIP_QUERY_AUDIT_SCOPE=all-claims SCIP_QUERY_AUDIT_OUTPUT=/tmp/scip-query-exact-claims npx vitest run --config benchmarks/typescript-accuracy-audit/vitest.config.ts benchmarks/typescript-accuracy-audit/run.audit.ts
SCIP_QUERY_AUDIT_SCOPE=exact-claims SCIP_QUERY_AUDIT_OUTPUT=/tmp/scip-query-exact-claims npx vitest run --config benchmarks/typescript-accuracy-audit/vitest.config.ts benchmarks/typescript-accuracy-audit/histories.audit.ts benchmarks/typescript-accuracy-audit/exact-public.audit.ts
node benchmarks/typescript-accuracy-audit/summarize-exact.mjs /tmp/scip-query-exact-claims /tmp/scip-query-exact-claims /tmp/scip-query-exact-claims/report.json
```

Use `SCIP_QUERY_AUDIT_SCOPE=exact-claims` with `run.audit.ts` to run only the 214 new cases. With no scope, the original corpus and histories remain selected; the new public recorder skips. The summarizer rejects invalid fixture expectations and changed instrumented outcomes, then records tool disagreements without requiring zero findings. Its optional fourth argument is a JSON map of production paths to SHA-256 hashes; when supplied, every hash must still match.

The follow-up history recorder compares values as well as graphs. Raw equality is retained separately from equality after substituting each disposable checkout's exact root path; source locations and other coverage text are preserved. The public recorder executes selected fixtures as both CommonJS and native ES modules, uses a local `fetch` recorder without network requests, and exercises the existing built CLI. Symbol line matches, precise range coverage, missing local compiler targets, unresolved implementations, and contradicted bodies are reported separately.

The diagnosis and history recorders validate their fixture compilation. The main recorder records invalid programs separately; an invalid fixture or an unexpected executed result invalidates that probe, rather than proving a tool bug. Inspect these counts on every run. The field named `contradictedTargets` is a runtime-versus-declaration comparison, **not** a count of false compiler references.

## Verify the six exact-claim repairs

Build the current source, run both exact-claim commands above into the same output directory, then run:

```sh
node benchmarks/typescript-accuracy-audit/verify-exact-repairs.mjs /tmp/scip-query-exact-claims /tmp/scip-query-exact-claims/verified.json
```

This command fails for incorrect literal results across all 686 programs, contradicted established implementations, the six audited failure families, false parameter pairs, incremental/clean mismatches, incorrect public HTTP paths or exact calls, and differences between CommonJS and native ESM execution. It also requires all 18 histories, 16 actual incremental updates, 7 HTTP consumers and 8 CLI projections. The required direct-call, constructor, constant, sibling-property and lazy-evaluation controls live in `tests/queries/graph/typescript-exact-claim-repairs.test.ts`; the full suite also protects existing runtime consumers.

Compiler-target omissions and placeholder declaration ranges remain reported coverage gaps. Passing this command establishes that the audited errors are absent from these programs; it does not establish exhaustive TypeScript runtime support.

## Breadth and public-command discovery

The [breadth report](../../docs/benchmarks/2026-09-09-typescript-breadth-audit.md) records five open finding groups on the frozen repaired build. It adds 109 closed programs, 51 HTTP consumer executions, 34 slice programs with 102 input executions, ten runtime/slice CLI projections and 35 further call-graph consumers. The slice oracle proves a missing influence by changing an input and observing a changed result; unchanged results do not prove independence. Compiled runtime artifacts stay outside the indexed fixture roots.

Use a new output directory for each frozen source revision. The example below uses the default path expected by the reproduction scripts; pass the output/root-file environment options when selecting another path.

```sh
node benchmarks/typescript-accuracy-audit/prepare-breadth.mjs /tmp/scip-query-breadth-audit
python3 benchmarks/command-contracts/2026-09-05/make-cli-fixture.py > /tmp/scip-query-breadth-audit/command-root.txt
python3 benchmarks/command-contracts/2026-09-05/run-cli-cases.py "$(cat /tmp/scip-query-breadth-audit/command-root.txt)" /tmp/scip-query-breadth-audit/commands
python3 benchmarks/command-contracts/2026-09-05/assert-cli-cases.py "$(cat /tmp/scip-query-breadth-audit/command-root.txt)" /tmp/scip-query-breadth-audit/commands
SCIP_QUERY_AUDIT_SCOPE=breadth SCIP_QUERY_AUDIT_OUTPUT=/tmp/scip-query-breadth-audit/isolated npx vitest run --config benchmarks/typescript-accuracy-audit/vitest.config.ts benchmarks/typescript-accuracy-audit/run.audit.ts benchmarks/typescript-accuracy-audit/breadth-public.audit.ts benchmarks/typescript-accuracy-audit/breadth-slices.audit.ts benchmarks/typescript-accuracy-audit/breadth-call-consumers.audit.ts benchmarks/typescript-accuracy-audit/breadth-command-diagnosis.audit.ts
```

Replay the lifecycle phases in order with `python3 benchmarks/typescript-accuracy-audit/replay-controls.py controls`, then `transport`, then `frontend`. `architecture` uses an independent root. These scripts redirect historical output into the new directory without changing the old runners or artifacts. They operate on disposable Git/skill roots; teardown stops only the fixture watcher.

Set `SCIP_QUERY_BREADTH_OUTPUT` to repeat the lifecycle in separate directories. `SCIP_QUERY_BREADTH_INTEGRITY=1` records native SQLite integrity checks after each frontend invocation and snapshots the first corrupt database. Preserve the initial frontend output as `frontend-initial` before testing recovery; the report uses separate `reproduction` and `stage-diagnosis` directories for its two further fresh sequences. The corrupted fixture is intentionally retained for diagnosis.

After reproducing that full layout, run:

```sh
node benchmarks/typescript-accuracy-audit/summarize-breadth.mjs /tmp/scip-query-breadth-audit /tmp/scip-query-breadth-audit/report.json --check
```

The summarizer verifies frozen production/build hashes, valid fixtures, required coverage counts and positive controls. **Its accuracy gate currently exits 1**, recording the wrong literals/HTTP paths, false complete slices, failed historical constructor assertion and corrupt lifecycle runs. The recorder tests themselves passing means observation completed, not that the product passed. The historical constructor assertion demands an exact label that now needs qualification; future repair verification must preserve the constructor candidate without restoring false certainty.
