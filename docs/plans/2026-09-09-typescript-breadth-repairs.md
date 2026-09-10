# Repair the five TypeScript breadth findings

Status: all five repairs implemented and verified. Historical discovery artifacts stay unchanged.

## Existing flow and comparable owners

- Reindex builds a temporary SQLite database, augments it, checks coverage and calls `promoteReindexArtifacts` (`src/reindex/index.ts:2052`). The publisher retains an immutable previous generation, clones the candidate, publishes its pointer, then replaces stable mirrors (`src/reindex/sqlite-generation-store.ts:140`). Existing handoff tests exercise interruption and pinned readers. The three malformed fixtures have healthy immutable databases but a corrupt stable `index.db`, establishing a mirror/publication gap rather than a corrupt TypeScript index.
- Shared values are evaluated by `static-value-flow.ts`; `imported-value-context.ts` qualifies compiler-linked writes. Runtime extractors turn those facts into `BoundaryKeyPart` and `BoundaryObservation`; precision must survive that conversion.
- `semantic/typescript/local-flow.ts` builds function-local definitions and dependencies. `dependence-slice` and cohesion use that shared model. The existing alias/delete/closure limitations already report incomplete coverage; new unsupported effects belong in that mechanism.
- `getCalleeRowsForSymbol` shares callee collection and optional callable filtering. `call-graph` requests that filter; qualified construction evidence must survive it without regaining an exact body label.

## Reuse and decisions

Repair the existing publication, value/effect, boundary and callee owners. Do not add parallel analysis paths. Preserve immutable-generation reader lifetimes, serialized publication, rollback/recovery stages, literal/primitive positive controls and candidate distinctions. Use native SQLite integrity/readability assertions, compiler-valid executed examples and actual CLI consumers.

## Execution queue

- [x] B05: reproduce leftover SQLite journal interaction; seal/validate artifacts before pointer publication, preserve prior accepted state on rejection, and rerun fresh control→transport→frontend histories.
- [x] B03: invalidate or qualify nested, eager and implicit writes before complete local slice claims; add independent-input regressions and consumer checks.
- [x] B02: preserve value precision in runtime boundary keys and stop treating unknown operands as strings; add numeric/template/parameter-pattern controls.
- [x] B01: qualify mutable values escaping through other exported values/functions and preserve cache invalidation dependencies; add cross-file execution regressions.
- [x] B04: retain qualified construction rows in callable filtering; check real compiler and CLI outputs.
- [x] Build, run breadth repair gate, prior 686-program/18-history checks, relevant tests and full suite; review/diff-impact/architecture and document material remaining limits.

No agent benchmarks or VM installation is needed for this request. Existing changes and unrelated documents must remain intact.

## Repair progress

All five production repair groups are implemented and verified. New executable regression tests cover exported object escapes, numeric/string uncertainty, public slice completeness, and retained constructor candidates. The slice repair also includes nested callable bodies when the selected location is on an outer return line. Complexity now uses the same callable evidence filter as call-graph, so unresolved constructor targets are counted as candidates.

Publication testing reproduced both stale-WAL page replay and publication of invalid database bytes before the fix. The fix checkpoints and integrity-checks candidate databases and removes journals belonging to the replaced database. A first implementation changed journal mode; a later architecture-hook preparation failure prompted a closer investigation. Journal mode is now preserved and a regression checks stable identity after reopening. As recorded below, the remaining hook failure was caused by unpublished augmentation writes.

Final results: 109 compiler-valid breadth programs have zero wrong claimed literal values; 51 HTTP programs have zero wrong claimed literal paths; after including nested callable bodies, all 34 slice probes have zero falsely complete slices. Prior discovery artifacts are preserved. Final results and remaining limitations are recorded separately.

Further lifecycle diagnosis: preserving journal mode did not eliminate the hook failure. Per-command file hashes showed that `augment-sources` changed the stable database without publishing, and the failed `augment-vue` command also performed auxiliary writes before reporting its missing provider. Both standalone CLI commands now share `publishSqliteAugmentation`: acquire the repository index writer lock, back up to a private candidate, run the complete operation, and hand the successful candidate to the existing generation publisher. Failure removes the candidate and preserves the accepted files/pointer; prior deferred-SCIP publication metadata is retained. Two direct publication tests cover reader isolation and rollback after a later provider failure.

The original 686-program strict accuracy verifier passed again, including all 18 update histories (16 actual incremental updates), compiler/full-rebuild parity, and public/native-ESM checks.

The strict breadth repair gate passes all program, slice, command, lifecycle and database-integrity assertions, including a final replay against the completed build. Focused regular validation passes 157 tests across five files; the final full suite passes 3,799 tests across 415 files. The final build, TypeScript checks, formatting, ESLint and API check pass. The API acceptance record documents the additional `ProjectIndex.callableCallees` method. See the [repair report](../benchmarks/2026-09-09-typescript-breadth-repairs.md) and [machine summary](../benchmarks/typescript-accuracy-audit/2026-09-09-breadth-repairs.json) for results and limits.

Current-source review captured all 587 eligible production TS/JS files without capture problems. It reports 14 maintainability findings relative to HEAD across the accumulated worktree: 13 complexity findings and one configured source-module file-count limit. These are recorded separately from the five accuracy repairs; this pass does not claim a clean repository review. Indexed diff-impact reports 44 changed files, 175 changed symbols and 211 affected files, with 62 changed paths omitted by that index's coverage.
