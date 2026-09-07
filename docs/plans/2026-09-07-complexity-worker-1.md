# Complexity worker 1 checkpoint

## Targets
- complexity:src/runtime/cli-json-envelope.ts:decodeCliJsonEnvelope
- complexity:src/queries/internal/exploration-topology.ts:catalogExplorationRoutes
- complexity:src/queries/internal/exploration-topology.ts:selectExplorationTopology
- complexity:src/runtime/source-emission-session.ts:validPersistedRange
- complexity:src/platform/process-file-lock.ts:parseProcessFileLockRecord
- complexity:src/queries/impact/context.ts:repositoryContext
- complexity:src/runtime/config.ts:validateWatchConfig
- complexity:scripts/benchmark-query-service.ts:parseBenchmarkCommand
- complexity:src/queries/impact/context.ts:buildRepositoryContextSourcePacket
- complexity:src/reindex/typescript-overlay-store.ts:parseOverlayManifest

## Plan before edits
Read complete implementations and adjacent contracts with scip-query. Separate validation, selection, and assembly responsibilities while preserving decision order, defaults, identity, output ordering, and cleanup. Run focused existing source tests and changed-file lint. Root owns combined build, full checks, health, and impact analysis. No commits, suppressions, or threshold changes.

## Implemented behavior-preserving changes

- `src/runtime/cli-json-envelope.ts`: dispatches legacy/versioned decoding separately, then validates v1 core/result fields before evidence metadata. Preserves own-property identity checks, version rejection before v1 validation, producer inclusion for unsupported versions, unsupported-result precedence, role agreement, all error strings, and original accepted object identity.
- `src/runtime/source-emission-session.ts`: separates persisted range location, receipt, and content-hash checks in their original short-circuit order. Retains zero-based inclusive bounds, positive safe ordinals, exact-unit/preview policies, SHA256 checks, hash count, and optional owner symbol. Ledger persistence and cleanup are unchanged.
- `src/platform/process-file-lock.ts`: separates lock owner identity from timestamp/detail validation. Retains protocol/version, trimmed nonempty identity strings, safe positive PID, optional process-identity PID agreement, date parsing, and detail shape/output rules. Acquisition, reclaim locks, releases, durability, and cleanup are unchanged.
- `src/runtime/config.ts`: gives watch interval, cooldown, idle timeout, boolean, and resource-budget validation named responsibilities. Retains diagnostic order, the 5000 ms cooldown warning floor, integer checks and exact messages; invalid cooldowns do not additionally warn.
- `scripts/benchmark-query-service.ts`: replaces literal command disjunction with a typed membership list. Retains all accepted values including value-flow, undefined/search default, and the exact historical error text.
- `src/reindex/typescript-overlay-store.ts`: separates manifest header and per-overlay validation, retaining validation before path checks and duplicate detection, null blob/zero-length deletion records, string identity requirements, and exact errors. Persistence/materialization/pruning are unchanged.
- `src/queries/impact/context.ts`: separates dependency result reuse, match classification, warnings, definition recovery, consumer-window merging, and final source limits. Preserves profiling order, single-file system-edge reuse, ambiguous callable behavior, target/consumer/reuse ordering, deduplication keys, sorted focus-line merging, and 24 slices/600 total lines/200 target lines/80 reuse lines with omission accounting.
- `src/queries/internal/exploration-topology.ts`: separates anchor-pair connectors, explicit frontier expansion, selected nodes/edges, folded-edge accounting, proved incoming-edge ordering, endpoint recording, per-anchor enumeration, and path extension. Retains shortest proved path preference, candidate fallback and ambiguity, stable route IDs/ties, runtime-endpoint stopping, cycle avoidance, depth 10 coverage reporting, explicit-selection errors, repeated junction expansion, dispositions, upstream annotations, and the folded-edge invariant.

## Evidence and checks

Complete original implementations and adjacent contracts were read with `node dist/cli.js code`; all emitted continuation cursors were drained unchanged. Current-source reads disclosed stale semantic identities after edits; no reindex/build was performed. Shared scip-query/scip-plan skills were read. Root owns final combined review, source health, fresh diff-impact, build, types, architecture, and full checks.

- Initial focused source tests: 8 files, 145 passed (`cli-json-envelope`, `source-emission-session`, `process-file-lock`, configuration and topology filters).
- Context/overlay follow-up: 4 files, 36 passed (`context-consumer-reuse`, `typescript-fragment-store`, topology, envelope).
- Final changed graph/context plus new regression: 3 files, 33 passed. The unique worker test has 10 cases covering multiple-invalid-field envelope validation precedence, unsupported schema/result precedence, and identity preservation.
- Final changed-file ESLint: passed across all eight source/script files plus the unique regression test.
- Scoped `git diff --check`: passed.
- A pre-existing-looking Node DEP0187 warning appeared during context tests; tests passed. Its origin was not investigated as part of this bounded refactor.

## Remaining limits and handoff

Source/tests frozen after focused checks. No commits, builds, reindexing, installs, suppressions, threshold changes, or shared inventory edits. New helpers are intentionally bounded, but final complexity numbers and type/API compatibility remain subject to the root agent's combined checks. Any new helper findings must be fixed or explicitly reported, never suppressed. Focused test totals overlap and are not a unique test count.

## Overlay type-contract follow-up

Root review identified that header validation incorrectly claimed validated overlay records in its TypeScript assertion. The intermediate `TypeScriptOverlayManifestHeader` now contains the validated header and `unknown[]` overlays. `validateOverlayRecord` accepts unknown and asserts one record only after the original ordered checks; the full manifest cast remains after record/path/duplicate validation. This change adds no runtime restrictions and preserves exact errors.

Re-read the exact modified implementation. Overlay persistence/assembly/pruning focused tests: 3 passed. Overlay-file ESLint and scoped `git diff --check`: passed. All focused processes finished; source/tests frozen again.

## Remaining target complexity follow-up

The root provisional scan measured lock-record parsing at 12/10 and topology selection at 11/8 (cyclomatic/cognitive). Separated optional process-identity decoding and PID agreement from final lock-record assembly, preserving original property access order and absence/invalid distinction. Separated requested-route ID validation and route selection from topology assembly, retaining exact unknown-ID errors and catalog ordering. Both new helpers contain only their bounded validation responsibility.

Affected focused checks: 42 passed across process-file-lock and exploration-topology. Both files passed ESLint and scoped `git diff --check`. Final measured helper and target metrics requested from root's combined source scan; no aggregate-completeness claim is made from the provisional scan. All focused processes finished; source frozen again.
