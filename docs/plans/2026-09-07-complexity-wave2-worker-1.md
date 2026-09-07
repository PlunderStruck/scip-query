# Complexity wave 2 worker 1

## Targets
- complexity:src/runtime/output-pagination.ts:captureOutputSnapshotPage
- complexity:src/symbols/definition-catalog.ts:parseCachedDefinition
- complexity:src/queries/graph/program-data-edges.ts:programDataElementsForSystemMapRelations
- complexity:src/reindex/typescript-index-protocol.ts:isTypeScriptIndexRequest
- complexity:src/symbols/graph/call-graph-evidence.ts:targetedCallerRowsMapForSymbols
- complexity:src/queries/internal/production-callables.ts:productionCallableDefinitions
- complexity:src/runtime/repository-cache-lifecycle.ts:sweepRepositoryCacheDirectory
- complexity:src/runtime/commands/command-handlers.ts:handleCheckDeps
- complexity:src/symbols/identifier-attribution.ts:findCallerFiles
- complexity:src/domain/observation-receipt.ts:isObservationReceiptV1

## Plan before edits
Read complete target implementations and relevant contracts through scip-query. Preserve pagination capture/continuation/cleanup, cache sweep ownership/lock/error contracts, validation sequence, caller attribution, production callable filtering, data-edge identity, and dependency-check output/status. Separate coherent responsibilities, keeping every changed target/new helper <=10 cyclomatic and <=15 cognitive. Run scoped source health, focused source tests, changed-file lint and formatting; root owns combined build/types/API/full suite/impact. No commits, builds, reindexing, policy/threshold/suppression changes or edits outside this manifest ownership.

## Original ten completed

All original targets and new helpers measured <=10 cyclomatic / <=15 cognitive using scoped `health --scope src` and `review --base aa3fa66b --scope src` with JSON exported to /tmp/complexity-wave2-worker1-health.json and /tmp/complexity-wave2-worker1-review.json; extracted owned metrics in /tmp/complexity-wave2-worker1-metrics.json. No owned target/helper findings. Other workers were editing outside this ownership, so no aggregate completeness claim is made.

- Pagination keeps invocation/cursor/page-size validation order, page/size/expiry checks, one-hour expiry removal, file type/size and before/after identity checks, page hash/character validation, read callbacks, catch-time snapshot removal, and descriptor closure.
- Cached definition checks retain numeric/string/null/undefined acceptance and field validation order. Each new assertion claims only its checked fields.
- Index requests retain array validation before header checks, duplicate detection and affected/removed presence rules. Legacy observation receipts retain optional index/worktree validation and final authority agreement.
- Program data edges retain exactly-one-site matching, callsite key/deduplication, static argument evaluation, used call results, local-flow bounds/unsupported messages, and final sorted unique blind spots.
- Caller evidence retains AST, resolved-reference, semantic-reference priority, first-observation deduplication, self-file/self-symbol exclusion, and ignored semantic-file filtering. File attribution retains skip/name prefilters and per-symbol caller sets.
- Production callables retain option defaults, memo lifetime per invocation, filter ordering, callable precedence, inclusive size acceptance (including original NaN comparison behavior), and final optional LOC sorting.
- Cache sweeping retains throttle-before-lock, repository-lock scope, per-worktree local lock, live-process checks before/after stop, stop failure skips, directory-before-lease deletion, then locks/temporaries/generations, evidence maintenance, state write, failure result, and finally releases.
- Dependency checking retains output order, all indexer reporting even after converter failure, indexer failures setting exit code, and informational semantic readiness.

Focused source tests: 120 passed across 6 files; 42 passed across 5 other files; 3 unique dependency-reporting regression cases passed. Total 165 tests across 12 files. Changed-file ESLint, Prettier check, and git diff --check passed. Complete owned diffs reviewed. No original-wave processes remain. A Node DEP0187 warning appeared in unused-params tests; passed without changing its unrelated source.

## Transfer accepted before editing

Root transferred the still-unedited entire `src/queries/graph/system-map.ts` to this worker, adding executeSystemMap (23/15), systemMapTopologyOwnerNodes (23/25), and systemMapLiteralMatches (24/31). Overall parallel-wave target count is unchanged. Root will not edit this file.

Plan: read all three complete implementations and adjacent contracts with scip-query; separate validation, topology node-kind construction, and per-file literal matching while preserving error order/messages, scope/depth defaults, node ordering/attributes, literal ownership fallbacks and seed priority. Run system-map/source-evidence focused source tests, lint/format, and measured target/helper complexity. No build/reindex/commit or policy changes.

## Transferred system-map targets completed

- `executeSystemMap`: separated relation policy, evidence-floor, source-scope, and numeric-bound validation. Retained order: normalized search/symbol anchors; relation validation; evidence floor; source scopes; missing-anchor rejection; depth; topology-character budget; index preparation. Defaults remain every relation, derived evidence, production scope, depth 5, topology characters 9000. Traversal stages and finalization unchanged.
- `systemMapTopologyOwnerNodes`: separated symbol, source-construct, and runtime-participant builders. Retained region-first/symbol/source-construct/runtime-participant node ordering; runtime participants still deduplicate by observation ID with last value then sort by ID. Missing-region error strings and timing, first containing boundary owner name, dispositions, anchor IDs, leaf/reference-scope/depth attributes, and public-entry evidence/priority remain unchanged.
- `systemMapLiteralMatches`: separated per-file match collection, line-match construction, focused ownership range, and owner naming. Retained file and line iteration order, ignored-file exclusion, empty/no-match file fast paths before definition/source-fact lookups, precise non-module compiler-owner preference, callable then broad compiler then line range fallbacks, null compiler owner symbol, focused source range, match kind and runtime/executable/other seed priorities 0/1/2. No new sparse-array assumptions.

Exact scoped source health/review artifacts: /tmp/complexity-wave2-worker1-system-map-health.json and /tmp/complexity-wave2-worker1-system-map-review.json; selected metrics: /tmp/complexity-wave2-worker1-system-map-metrics.json. All three targets and new helpers <=10/15 with no target/helper findings. Complete diff reviewed against observed original implementations.

Focused transferred checks: 105 tests passed across tests/queries/graph/system-map.test.ts (63), tests/queries/navigation/source-evidence.test.ts (35), tests/source/source-evidence.test.ts (2), and tests/queries/graph/system-map-edge-semantics.test.ts (5). File ESLint, Prettier check and git diff --check passed. All scan/test processes finished.

## Final measured target metrics

| Target | Cyclomatic | Cognitive |
| --- | ---: | ---: |
| isObservationReceiptV1 | 7 | 2 |
| programDataElementsForSystemMapRelations | 3 | 2 |
| productionCallableDefinitions | 6 | 8 |
| isTypeScriptIndexRequest | 7 | 6 |
| handleCheckDeps | 5 | 5 |
| captureOutputSnapshotPage | 5 | 4 |
| sweepRepositoryCacheDirectory | 10 | 6 |
| parseCachedDefinition | 6 | 5 |
| targetedCallerRowsMapForSymbols | 5 | 3 |
| findCallerFiles | 9 | 11 |
| executeSystemMap | 8 | 3 |
| systemMapLiteralMatches | 2 | 1 |
| systemMapTopologyOwnerNodes | 7 | 8 |

## Frozen handoff

Thirteen owned targets in eleven source files complete; one unique three-case regression file added. Total focused tests: 270 passed across 16 distinct files. All introduced helpers meet 10/15. Original ten source files were unchanged during the transferred three-target work. No commits, builds, reindexing, package/skill/threshold/suppression edits. Root owns combined types/API/build/full tests/review/health/impact; these focused results do not establish aggregate wave completion or fresh indexed relationships.

## Combined typecheck follow-up

Root found that applying ReturnType/Parameters to generic smallestSourceCallableAtLine erased callable name from the literal helper types. Updated the literal-file context to use the actual getSourceFacts callables array type, and both owner helpers to accept its element type or null. This type-only correction retains the source-fact name and range fields without asserting new validation or changing runtime behavior. Focused ESLint/format checks rerun; root owns the combined source typecheck.
