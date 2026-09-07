# Complexity wave 2 worker 2 — 2026-09-07

## Targets

- complexity:src/runtime/source-emission-session.ts:parseLedger — parseLedger: cyclomatic 23, cognitive 8.
- complexity:src/storage/bounded-mailbox.ts:maintainBoundedMailboxUnlocked — maintainBoundedMailboxUnlocked: cyclomatic 16, cognitive 34.
- complexity:src/queries/internal/dead-candidate-gate.ts:deadCandidateDecision — deadCandidateDecision: cyclomatic 22, cognitive 22.
- complexity:src/runtime/cli-main.ts:<callback:program.hook:1> — <callback:program.hook:1>: cyclomatic 22, cognitive 25.
- complexity:src/analysis/runtime-boundaries/graph.ts:materializeBoundedLinks — materializeBoundedLinks: cyclomatic 19, cognitive 32.
- complexity:src/analysis/runtime-boundaries/graph.ts:boundarySourceHashes — boundarySourceHashes: cyclomatic 21, cognitive 24.
- complexity:src/semantic/rust/durable-session-protocol.ts:decodeCurrentCorrelation — decodeCurrentCorrelation: cyclomatic 21, cognitive 7.
- complexity:src/semantic/rust/durable-session-protocol.ts:decodeDurableRustMailboxResponse — decodeDurableRustMailboxResponse: cyclomatic 21, cognitive 15.
- complexity:scripts/typescript-semantic-provider-comparison.mjs:parseArgs — parseArgs: cyclomatic 20, cognitive 21.
- complexity:src/domain/project-input.ts:buildProjectChangeManifest — buildProjectChangeManifest: cyclomatic 20, cognitive 16.

## Plan

Read complete target source and relevant contracts through scip-query. Preserve decisions, validation order, output shape, bounds, errors, state and cleanup while separating responsibilities. Keep target/new helper cyclomatic complexity at most 10 and cognitive complexity at most 15, measured through scoped health. Run focused source tests, installed ESLint/Prettier and diff checks. Root owns combined build, types, API, full suite, review and impact. Own only manifest source/script files, an optional unique regression test, and this checkpoint; no commits, builds, reindexing, VM actions, dependency changes or shared maintenance edits.

## Results

All ten targets completed in the eight owned source/script files. No source files outside this wave's manifest were edited. A unique regression file was added at `tests/runtime/complexity-wave2-worker2-regression.test.ts`.

### Preserved behavior

- Source emission ledger parsing: shared object validation, identity, ordinal and persisted-content checks retain legacy-v1 reset behavior, version-2 validation, ordinal preservation, timestamp fallback and the unchanged invalid-ledger error. No unchecked fields were added to a type predicate.
- Mailbox maintenance: separate claim recovery and temporary-file removal preserve one shared cleanup budget across claims, responses, dead letters and staging files. Completed claims win over expiration; recovery requires expiration and a dead owner. EEXIST removes the old claim; other rename errors propagate. ENOENT during staging stat is tolerated. Recovery sync order and final empty-owner-directory cleanup remain unchanged inside the caller's admission lock.
- Dead-candidate gate: lazy ordered rejection stages preserve first reason, callback order, local includeTests bypass, constructor/Python behavior, contract and Rust exclusions, member filtering and minimum LOC. The existing ignore-extract annotation remains attached to the gate.
- CLI pre-action: context/profile/update-notice/Git observation order remains intact, as do continue/source-only bypasses, file-listing cache lifetime, refresh fallback eligibility plus existing-db check, warnings, watch-service reporting and conditional cache sweep.
- Runtime boundary graph: line starts, template rescanning/depths and token hashing are separate operations with identical separators, token text filtering and line-sensitive hashes. Materialization preserves traversability, unique-pair/consumer checks, 64-pair cap, source selection, same-site/missing-observation exclusion, derived strength, stable IDs, overwrite semantics and sorted output.
- Rust protocol decoding: helpers validate only the operation/client strings and lifecycle numbers they claim. Mailbox/protocol/operation validation precedes time and session checks. Response object/protocol/identity checks precede deadline checks, which precede rejection/success payload checks. Errors, response identity, inclusive deadline and prior-session compatibility are unchanged.
- Comparison argument parsing: exact-key Maps distinguish value flags and boolean flags without inherited object keys; immediate list/help exits precede final ordered numeric validation. Defaults, repeated-flag updates, missing-value behavior and error text remain unchanged.
- Project change manifest: file change classification and uncertainty collection are separate. Last duplicate-map entry, sorted paths, added/deleted/modified shapes, hash/size comparison, input classification, identity comparison and sorted uncertainty remain unchanged.

### Exact current-source metrics

| Target                           | Cyclomatic | Cognitive |
| -------------------------------- | ---------: | --------: |
| parseLedger                      |         10 |         7 |
| maintainBoundedMailboxUnlocked   |          1 |         0 |
| deadCandidateDecision            |          6 |         1 |
| <callback:program.hook:1>        |          8 |         6 |
| materializeBoundedLinks          |          5 |        10 |
| boundarySourceHashes             |          6 |         6 |
| decodeCurrentCorrelation         |          6 |         4 |
| decodeDurableRustMailboxResponse |          6 |         6 |
| parseArgs                        |          5 |         5 |
| buildProjectChangeManifest       |          5 |         4 |

Every measured target and new helper is at most 10 cyclomatic / 15 cognitive. Maximum among the new helpers is 9 cyclomatic / 11 cognitive. Eight scoped health reports had accounted coverage and showed no remaining target/new-helper complexity findings after the final ledger adjustment; existing non-target findings remain outside scope. Scoped review supplied exact current-function numbers. Seven review comparisons were marked incomplete because another worker changed `src/queries/graph/system-map.ts` during the shared scan; no owned file changed during those captures. Root must use its final stable aggregate review for comparison/impact conclusions.

### Executed checks

- Existing focused suites: 149 tests passed in seven files (`source-emission-session`, `bounded-mailbox`, `dead-candidate-gate`, `durable-session-protocol`, `affected-set`, `runtime-boundaries`, `cli-contract`).
- Final affected/regression run: 23 tests passed in three files, including eight new worker-specific cases. These verify dead-gate callback short circuiting, response identity/deadline/payload precedence, ordered parse errors, inherited-name rejection and immediate list handling. Script cases stop during argument parsing and do not run comparisons or reindexing.
- Changed source/script/test ESLint, Prettier checks and `git diff --check` passed.
- Scoped health/review JSON artifacts are under `/tmp/wave2-worker2-*`; selectively summarized measurements are `/tmp/wave2-worker2-exact-metrics.json`.

### Handoff

Implementation, checks and checkpoint are complete. All worker test and inspection processes have finished. Files are frozen for root integration. Root owns complete stable review, build, types/API, full suite, architecture and diff-impact. No build, reindex, benchmark execution, VM action, dependency change, threshold/suppression/skill change, commit or push was performed by this worker in this wave.
