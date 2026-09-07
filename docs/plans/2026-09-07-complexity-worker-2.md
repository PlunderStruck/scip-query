# Complexity worker 2 — 2026-09-07

## Targets

- complexity:src/runtime/command-kit/command-execution.ts:printJsonEnvelope
- complexity:src/queries/cleanup/similar-signatures.ts:truncateAtImplementationStart
- complexity:src/reindex/index.ts:reindex
- complexity:src/storage/bounded-mailbox.ts:inflightClaims
- complexity:src/queries/cleanup/recent-duplicates.ts:orientRecentDuplicate
- complexity:src/queries/internal/causal-corridor.ts:isClosureEdge.<callback:(edge.semantics ?? []).some:0>
- complexity:src/reindex/index.ts:prepareIndexerRun
- complexity:scripts/score-detector-labels.ts:rowIdentity
- complexity:src/queries/internal/causal-corridor.ts:isTraversableEdge.<callback:(edge.semantics ?? []).some:0>
- complexity:src/runtime/query-service-server.ts:executeRequest

## Plan

Inspect complete target implementations and contracts through scip-query. Preserve branching decisions, validation order, output shapes, state and cleanup effects while separating named responsibilities. Run focused source tests and changed-file lint; root handles build, full tests, health and impact. Own only the manifest files and this checkpoint; do not commit or alter shared maintenance files.

## Evidence and results

Completed all ten targets across the eight manifest source/script files. Source evidence was read through scip-query; original target bodies and output/validation contracts were inspected. Semantic identities may be stale after edits; root owns fresh aggregate review and impact.

### Changes and preserved contracts

- `command-execution.ts`: separate operation-role consistency, coverage validation/merge, result-only selection and evidence fields. Preserve validation before output, agent-result precedence, own-property `resultOnly` handling (including explicit undefined), optional-property presence and serialized field order.
- `similar-signatures.ts`: separate quote consumption, implementation-boundary decisions and delimiter depth updates. Preserve escaped quotes, literal punctuation, independently clamped depths, brace boundaries and top-level arrow termination.
- `recent-duplicates.ts`: orient two explicit file/symbol/age records once, retaining twin/echo classification, A on tied twin ages, unknown age handling and all shared evidence fields.
- `causal-corridor.ts`: distinguish closure-family policies and focused traversal policies. Preserve navigation exclusions, return/throw focus restrictions, lexical temporal adjacency, owner checks, focused-edge bypasses, and original `some()` semantics requiring a present semantic witness, including empty/sparse arrays.
- `bounded-mailbox.ts`: separate owner-directory traversal, claim-filename validation and claim reading. Preserve malformed-file rejection, request-header fallback, ENOENT-only tolerance, propagation of other stat failures, optional header fields and claimed-time/path sort.
- `reindex/index.ts`: separate language/heap selection, fingerprint reporting, lifecycle-lock acquisition, stale-workspace reporting, success/failure activity recording and indexer preparation. Keep shared-build/lifecycle/index lock ordering, watcher/manual waits of 1,000/30,000 ms, under-lock generation revalidation and immutable publication, cleanup order, activity warning text and failed-refresh writes. Local tools still require trust before installation fallback; executable refusal still occurs after argument/root-config preparation. No host-mutation authority was added. Original reindex annotation stays attached to reindex.
- `score-detector-labels.ts`: split identity schemes into typed helpers, preserving nullish fallback versus empty-string behavior, pair ordering and group member filtering/sorting.
- `query-service-server.ts`: use a request-kind handler table checked against the request union. Preserve lazy imports, generation-bound serialized caches, hashing, projection and code fallback; own-key selection prevents inherited object names from bypassing that fallback.

### Validation

- 287 focused tests passed across 14 files: causal-corridor; similar-signatures-fallback; recent-duplicates-pruning; frontend-recent-duplicates; bounded-mailbox; cli-json-envelope; score-detector-labels; reindex-reliability; project-tool-execution; reindex-activity; reindex-indexers; query-service; query-service-fastpath; query-service-envelope.
- After helper cleanup, 98 affected tests in seven suites passed again. Final language-selection/dispatch follow-up verification passed 191 tests across reindex-reliability, query-service and query-service-envelope.
- Deterministic differential checks against HEAD passed for 30,000 signature-scanner inputs and 4,480 closure/traversal predicate combinations. A direct dispatcher check passed five fallback discriminators (including inherited object names) plus a known stats handler.
- Changed-file ESLint, Prettier and `git diff --check` passed. No shared tests were edited and no new exported test seam was introduced.
- A mistaken `npx biome` invocation fetched unrelated `biome@0.3.3` into npm's execution cache; it made no project dependency edits. package.json and package-lock.json were confirmed unchanged. All actual formatting/lint used installed Prettier/ESLint.

### Remaining integration checks

Root will run the fresh complete complexity/helper scan, build/types/API, full suite, architecture/review and diff-impact after all workers freeze. Local approximate branch counts put changed targets and new helpers at ten or lower; this does not replace the authoritative scan. Existing non-target findings in these files remain outside this worker's assigned scope. No suppressions or thresholds were changed. No commits, pushes, builds or reindexes were performed by this worker.
