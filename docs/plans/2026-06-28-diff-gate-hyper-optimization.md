# Diff Gate Hyper Optimization Plan

Date: 2026-06-28

## Goal

`diff-gate` is the CLI verification gate that takes the current Git diff and
runs change-focused analyzers whose shared purpose is to catch risky edits
before the user declares the work done. The user wants the cold Vega_2.0
`diff-gate --json` path to stop dominating the heavy benchmark while preserving
the same findings and exit behavior.

Done means:

- Vega_2.0 cold-like `diff-gate --json` is materially faster.
- `diff-gate` JSON output stays byte-for-byte identical on the benchmark diff.
- The implementation records enough profile spans to explain future regressions.
- Repo verification passes after the change.

## Current State

- `node dist/cli.js status --capabilities` reported the local scip-query index
  fresh after `node dist/cli.js reindex`.
- `node dist/cli.js plan-context diffGate --json --full` found
  `diffGate()` in `src/queries/impact/diff-gate.ts:159-248`. It builds a
  shared diff plan, then runs `echo`, `incomplete-migration`,
  `co-change-partner`, `doc-reference`, `unused-params`, and `new-dead`.
- `node dist/cli.js call-graph diffGate --json --full` showed the only runtime
  callers are `src/runtime/query-commands/impact.ts` and
  `src/runtime/agent-hooks.ts`.
- `node dist/cli.js code runEchoCheck --json` showed
  `runEchoCheck()` at `src/queries/impact/diff-gate.ts:353-415`; it loops new
  callable changed symbols and calls `similar(...)`.
- `node dist/cli.js code runIncompleteMigrationCheck --json` showed
  `runIncompleteMigrationCheck()` at `src/queries/impact/diff-gate.ts:488-547`;
  it delegates to `incompleteMigration(...)`.
- `node dist/cli.js code incompleteMigration --json` showed
  `incompleteMigration()` at `src/queries/impact/incomplete-migration.ts:88-218`;
  it finds new helper callables, computes helper callees, lazily builds a
  callee fingerprint index, then collects leftovers.
- `node dist/cli.js code newCallablesInDiff --json` showed
  `newCallablesInDiff()` at
  `src/queries/impact/incomplete-migration.ts:368-380`; it currently calls
  `index.productionCallableDefinitions({ requireFunctionLikeSymbol: true })`
  across the whole project before filtering to changed files.
- `node dist/cli.js code productionCallableDefinitions --json -C 5` and
  `node dist/cli.js code 'src/core/production-callables.ts:1-220' --json`
  showed `productionCallableDefinitions(...)` already accepts a `files` option
  and routes scoped files through `getDefinitionsForFile(...)`.
- `node dist/cli.js code docsCitingFiles --json` showed
  `docsCitingFiles()` at `src/queries/cleanup/doc-drift.ts:324-368`; it loops
  tracked living docs and calls `docPathEvidence(...)`.
- `node dist/cli.js code docPathEvidence --json` showed
  `docPathEvidence()` at `src/queries/cleanup/doc-drift.ts:493-511`; it reads a
  doc file, computes a content hash, checks `file_evidence`, extracts path
  references on miss, and writes `doc-path-evidence`.

## Measurements

Baseline full heavy cold matrix on Vega_2.0:

- Source: `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js bench --json --cold-index --include-heavy --timeout-ms 600000 --profile`
- Result JSON: `/tmp/vega-heavy-cold-20260628-125130.json`
- Profile JSONL: `/tmp/vega-heavy-cold-20260628-125130.jsonl`
- `diff-gate --json`: 23.027s, exit 1, 19,708 stdout bytes.

Targeted cold benchmark:

- Source: `node .../dist/cli.js bench --json --cold-index --command "diff-gate --json" --timeout-ms 600000 --profile`
- Result JSON: `/tmp/vega-diffgate-cold-20260628-130239.json`
- Profile JSONL: `/tmp/vega-diffgate-cold-20260628-130239.jsonl`
- `diff-gate --json`: 25.316s, exit 1, 19,708 stdout bytes.

Cold-like cache ablation after clearing `file_evidence`, `semantic_callees`,
and `semantic_references`:

| Case                                               | Duration | Exit | Cache rows written                                                                                 |
| -------------------------------------------------- | -------: | ---: | -------------------------------------------------------------------------------------------------- |
| full                                               |  22.487s |    1 | `doc-path-evidence:11290`, `file-definitions:1779`, `source-facts:1779`, `source-fingerprints:864` |
| skip doc-reference                                 |  13.828s |    0 | `file-definitions:1779`, `source-facts:1779`, `source-fingerprints:864`                            |
| only doc-reference                                 |   3.217s |    1 | `doc-path-evidence:11290`, `file-definitions:7`, `source-facts:7`                                  |
| only echo                                          |  13.553s |    0 | `file-definitions:1779`, `source-facts:1779`, `source-fingerprints:864`                            |
| only incomplete-migration                          |  13.280s |    0 | `file-definitions:1779`, `source-facts:1779`                                                       |
| no echo, no incomplete-migration                   |   3.488s |    1 | `doc-path-evidence:11290`, `file-definitions:7`, `source-facts:7`                                  |
| no echo, no incomplete-migration, no doc-reference |   0.717s |    0 | `file-definitions:7`, `source-facts:7`                                                             |

The biggest confirmed waste is project-wide production-callable/source evidence
fill in the incomplete-migration path even when the diff touches only seven
files.

## Reuse Audit

- Reuse `productionCallableDefinitions(..., { files })`; do not create a new
  changed-file definition scanner. Source:
  `node dist/cli.js code 'src/core/production-callables.ts:1-220' --json`.
- Reuse `profileSpan`; do not create a new timing mechanism. Source:
  existing spans in `node dist/cli.js code buildCalleeFingerprints --json` and
  `node dist/cli.js code getCalleeFingerprintIndex --json`.
- Reuse `docsCitingFiles()` / `docPathEvidence()` for doc-reference correctness.
  Source: `node dist/cli.js code docsCitingFiles --json` and
  `node dist/cli.js code docPathEvidence --json`.
- Do not replace `similar(...)` or `getCalleeFingerprintIndex(...)` yet.
  Source: `node dist/cli.js code similar --json` and
  `node dist/cli.js code getCalleeFingerprintIndex --json`; they already share
  a per-process callee fingerprint cache, so the first safe win is scoping the
  caller that accidentally bypassed changed-file scope.

## Design Phases

### 1.1 — Add check-level diff-gate profile spans

- [x] **File**: `src/queries/impact/diff-gate.ts:159-248`
- **Source**: `node dist/cli.js plan-context diffGate --json --full`
- **What**: `diffGate()` runs each check through `runUnlessSkipped(...)`, but
  Vega direct profiling shows only one useless span for a 22s run.
- **Change**: Wrap each executed check in `profileSpan('diff-gate.check.<name>',
...)` and record findings added, skipped added, changed file count, and
  changed symbol count.
- **Why**: Future cold regressions must identify which check owns the wall time.

### 1.2 — Scope incomplete-migration new helper discovery to changed files

- [x] **File**: `src/queries/impact/incomplete-migration.ts:368-380`
- **Source**: `node dist/cli.js code newCallablesInDiff --json`
- **What**: `newCallablesInDiff()` currently calls
  `index.productionCallableDefinitions({ requireFunctionLikeSymbol: true })`
  over the whole repository, then filters by `changed`.
- **Change**: Pass `files: [...changed]` to `productionCallableDefinitions`.
- **Why**: `productionCallableDefinitions` already supports file scoping; Vega
  only changed seven files, so whole-project source evidence fill is avoidable.

### 1.3 — Benchmark scoped incomplete-migration before deeper changes

- [x] **File**: `docs/benchmarks/2026-06-28-diff-gate-hyper-optimization-ledger.md`
- **Source**: cold-like cache ablation commands recorded above.
- **What**: Current cold-like full `diff-gate` takes 22.487s and writes
  whole-project source evidence.
- **Change**: Rebuild, clear cache rows, rerun full/only-incomplete/skip-docref,
  and record before/after timings plus output hash/byte equality.
- **Why**: If scoping removes the 1,779-file evidence fill, it may be enough for
  this round; if not, the new spans will identify the next target.

### 1.4 — Optimize doc-reference only if it remains material

- [x] **File**: `src/queries/cleanup/doc-drift.ts:324-368`
- **Source**: `node dist/cli.js code docsCitingFiles --json`
- **What**: `docsCitingFiles()` checks all tracked living docs and calls
  `docPathEvidence()` for each.
- **Change**: After phase 1.3, only implement a target-candidate prefilter if
  the profile still shows `doc-reference` as material and output can be kept
  identical.
- **Why**: `doc-reference` is about 3.2s cold-like on Vega, smaller than the
  source evidence bucket; correctness risk is higher because suffix/path
  citations are nuanced.

### 1.5 — Bound diff-gate echo source fallback by required shared tokens

- [x] **File**: `src/queries/cleanup/similar.ts:729-790`
- **Source**: Vega profile
  `/tmp/vega-diffgate-after-echo-prune-20260628202914.jsonl`.
- **What**: A weak two-token source prefilter still admitted 1,680 of 1,779
  indexed files for `ActiveNavIndicator`, so echo stayed above 11s.
- **Change**: For diff-gate echo's target-pruned source fallback, require a
  file to contain at least `ceil(targetTokenCount * minSimilarity)` target
  tokens before loading definitions and exact source fingerprints.
- **Why**: Since source-token similarity is `shared / union` and `union` cannot
  be smaller than the target token set, this is an exact necessary condition
  for any candidate to reach the configured similarity threshold.

## Stress Test

- Understand before touch: sources above show `diffGate()` is a coordinator and
  `incompleteMigration()` owns helper discovery; the scoped change preserves the
  same helper predicate and only narrows the candidate source to already-known
  changed files.
- Blast radius: `node dist/cli.js call-graph incompleteMigration --json --full`
  shows its only caller is `runIncompleteMigrationCheck()` in `diff-gate.ts`.
- Intermediate validity: phase 1.1 instrumentation and phase 1.2 scoping are
  independently buildable and reversible.
- Reversibility: no schema or output contract change; rollback is deleting the
  added span wrapper and removing the `files` option.
- Failure design: if `changed` is empty, `incompleteMigration()` already returns
  before calling `newCallablesInDiff()`; passing an empty file list is not on the
  active path.
- Concurrency: evidence cache writes already go through existing cache helpers;
  scoping reduces writes and adds no shared mutable state.
- Boundaries: CLI option behavior does not change.
- Data integrity: only cache reads/writes and in-memory analysis are affected.
- Observability: check-level spans make cold path visible.
- Human impact: same findings, faster first run.
- Reuse: uses the existing `files` option and `profileSpan`.

## Execution Order

1. Instrument `diffGate()` checks.
2. Scope `newCallablesInDiff()` to changed files.
3. Build and run focused tests.
4. Run Vega cold-like benchmark with cache clearing.
5. Compare full `diff-gate --json` output before/after.
6. Decide whether doc-reference needs a second optimization.
7. Bound echo source fallback by the exact minimum shared-token count.

## Verification

- `npx tsc --noEmit --pretty false`
- Focused tests covering diff-gate/incomplete-migration if present.
- Vega cold-like output parity:
  - baseline: `/tmp/vega-diffgate-direct-profile-20260628-130927.json`
  - final run: `/tmp/vega-diffgate-after-echo-threshold-20260628203105.json`
  - final profile:
    `/tmp/vega-diffgate-after-echo-threshold-20260628203105.jsonl`
  - final SHA-256:
    `8cb44814e1c5ab700c1caef3b8c8667ee6cb11b939ac7d2d20315c41d9f64d5e`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`; if only support-tier doc-reference
  warnings remain from prior work, also run
  `node dist/cli.js diff-gate --json --skip doc-reference`.
