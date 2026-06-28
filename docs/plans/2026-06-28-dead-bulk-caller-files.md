# Dead Bulk Caller Files Plan - 2026-06-28

## Goal

Make `scip-query dead --json --full` faster on large repositories without
changing which symbols are reported or how they are classified. Done means the
Vega_2.0 command keeps the same exit code, stdout size, and SHA-256 hash while
the warm runtime drops.

## Current State

`scip-query plan-context supplementReferencesFromCallerMap --json` resolves the
target to `src/queries/cleanup/dead.ts:466-500`. The function is only called by
`dead()` at `src/queries/cleanup/dead.ts:141`.

Vega_2.0 baseline repeats put `scip-query dead --json --full` at
1.522s, 1.525s, and 1.531s, with CLI stdout SHA-256
`28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1`.

Direct query timing inside Vega shows the analyzer dominates runtime: `dead()`
itself takes 1.259s-1.335s while JSON projection and stringify take only
0ms-3ms. `deadCodeOnly` takes 0.646s-0.685s, so the expensive part is the
normal file-internal analysis path.

The CPU profile points at source-reference scanning and reference/caller SQL.
`scanSourceReferences()` already uses `sourceMayContainCandidateName()` as a
text prefilter, so the next larger avoidable cost is caller supplementation.

`scip-query code supplementReferencesFromCallerMap -C 100` shows that the
large-candidate path calls `callerRowsForSymbol()` once per candidate, even
when `useBulkSemanticCallers` is true. In this command, the caller row's
enclosing symbol and exact reference line are discarded; `recordCallerFile()`
only needs the caller file path.

`scip-query code getResolvedReferenceSites -C 180` shows the current targeted
caller path reads `mentionReferenceChunkRows(db, [symbolId])`, resolves source
lines, and looks up enclosing definitions. For dead-code liveness, that line
and enclosing-symbol work is unnecessary because the consumer records only
cross-file file presence.

`scip-query code mentionReferenceChunkRows -C 120` shows the storage layer
already supports batched symbol IDs, using `SQLITE_PARAM_BATCH_SIZE` internally.
`scip-query refs mentionReferenceChunkRows --json --full` shows current callers
are `reference-sites.ts` and `reference-callers.ts`; this plan adds one local
dead-code use without changing the storage function.

`scip-query change-surface src/queries/cleanup/dead.ts --json --full` marks
`dead()` and the module as medium risk. `scip-query co-change` reports no
required partner file for either `dead.ts` or `scip-mentions.ts`.

## Design

### 1.1 - Batch caller files for large dead-code candidate sets

- [x] **File**: `src/queries/cleanup/dead.ts`
- **Source**: `scip-query code supplementReferencesFromCallerMap -C 100`
- **What**: When there are enough candidates for bulk semantic callers, avoid
  calling `callerRowsForSymbol()` for each definition.
- **Change**: Import `mentionReferenceChunkRows()` and add a helper that maps
  candidate `symbolId` to `IndexedDefinition`, reads all mention reference
  chunks in batches, and calls the existing `recordCallerFile()` with each
  row's `relative_path`.
- **Why unchanged**: The old per-symbol targeted path ultimately records the
  same cross-file file set for dead-code liveness. Same-file/self-reference
  line refinement is not observable here because `recordCallerFile()` discards
  same-file callers and only records a minimum cross-file reference.
- **Result**: Implemented as `supplementCallerFilesFromMentionChunks()`, used
  only when the existing large-candidate bulk semantic condition is true.

### 1.2 - Keep small-repo behavior unchanged

- [x] **File**: `src/queries/cleanup/dead.ts`
- **Source**: `scip-query code getCallerRowsForSymbol -C 160`
- **What**: Small projects can keep using the existing caller row facade.
- **Change**: Use the bulk file path only under the same large-candidate,
  large-index condition already used for bulk semantic callers.
- **Why**: This limits behavior risk while targeting the Vega-scale bottleneck.
- **Result**: Small and non-bulk paths still call `callerRowsForSymbol()` with
  the existing semantic option.

### 1.3 - Record accepted or rejected evidence

- [x] **File**: `docs/benchmarks/2026-06-28-health-ledger.md`
- **Source**: Vega CLI hash/timing probe
- **What**: Add a section for the dead bulk caller-file experiment.
- **Why**: Hyper-optimization changes are accepted only with objective timing
  improvement and byte-identical output.
- **Result**: Accepted. Vega `dead --json --full` kept exit 0, 3,803,655
  stdout bytes, and SHA-256
  `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1`.

### 1.4 - Refresh the scoreboard

- [x] **File**: `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`
- **Source**: Vega repeat timing command
- **What**: Update the `dead --json --full` row and next-target notes if the
  experiment is accepted.
- **Result**: Updated the warm band and moved `dead` out of the next
  1.50s-1.60s target cluster.

## Stress Test

1. Output contract: compare Vega `dead --json --full` exit code, stdout bytes,
   and SHA-256 before/after.
2. Accuracy: classification depends on whether any cross-file caller exists;
   exact reference line and enclosing caller symbol are not part of
   `DeadSummary`.
3. Scope: the change is internal to `dead.ts`; public result types do not
   change.
4. Reversibility: fallback remains the existing per-symbol `callerRowsForSymbol`
   loop for small candidate sets.
5. Validation: run targeted dead tests if present, `npm run typecheck`,
   `npm run build`, Vega repeat timings, `scip-query reindex`, and
   `scip-query diff-gate`.

## Ship Order

Accepted. The bulk caller-file branch reduced Vega `dead --json --full` from
1.515s-1.531s to 1.119s-1.139s warm with byte-identical output.
`diff-gate --skip doc-reference` passed; the normal gate's remaining
`doc-reference` findings were accepted support-tier configuration-example
citations whose file target did not change.
