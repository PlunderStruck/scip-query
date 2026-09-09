# TypeScript visitor failures can publish a partial index as successful

Status: resolved in the working tree; all validation passed. Investigated at
commit `d932c6e4` on 2026-09-08.

## Finding

A partial index is a stored set of code definitions and references that omits
facts the selected indexing operation should have produced. The bundled full
TypeScript indexer can publish one after a compiler visitor throws inside a file,
without recording the failure in the reindex result or freshness report.

This is a priority correctness issue because later exploration consumes those
records. Presence of every selected file does not establish that traversal of
each file completed.

## Live implementation

- Pinned `@sourcegraph/scip-typescript` 0.4.0, `dist/src/ProjectIndexer.js:135`:
  catches a failure from `visitor.index()`, logs it, and still writes the document
  if it already contains occurrences.
- Upstream `dist/src/main.js:100`: a nonempty emitted document set follows the
  successful completion path; the caught visitor failure does not set a failing
  exit code.
- `src/reindex/typescript-indexer.ts:19`: the bundled full compiler adapter calls
  that upstream entry point.
- `src/reindex/indexer-runner.ts:303`: a zero exit status is accepted; captured
  compiler stderr is only used for a nonzero exit status.
- `src/reindex/index-coverage.ts:46`: publication coverage compares document paths.
  A present but partly visited file passes this check.
- `src/reindex/index.ts:2388`: complete document coverage passes the candidate
  coverage assertion. The public reproduction also passed the remaining checks.

## Executed reproduction

Used a disposable Git repository with a real TypeScript configuration, watch
disabled, an isolated `.cache`, and these unchanged source files:

```ts
// owner.ts
export function before() { return 1; }
export function tripwire() { return before(); }
export function after() { return tripwire(); }

// consumer.ts
import { after } from './owner.js';
export const value = after();
```

Ran the built public CLI with `reindex --force --allow-expensive-rebuild`, first
normally and then with a temporary Node preload that throws from
`FileIndexer.prototype.visit` when visiting the `tripwire` identifier in
`owner.ts`. The preload affects only the full compiler child. It changes no
source files, dependency files, serialized records, or validation code. A
separate receipt confirms the injected exception executed exactly once.

| Observation | Clean run | Injected visitor failure |
| --- | --- | --- |
| CLI exit status | 0 | 0 |
| Reindex skipped entries | none | none |
| Captured public CLI stderr | empty | empty |
| Documents | 2 | 2 |
| Function definitions in owner.ts | before, tripwire, after | before |
| Stored mention rows | 10 | 6 |
| Status freshness / ok | fresh / true | fresh / true |
| Publication validation | passed | passed |

The damaged generation replaced an existing healthy generation. The previous
generation remained available as a recovery artifact, but the damaged one became
current. No `--allow-partial` flag was used.

Local reproduction artifacts, including `run.py`, `inject.cjs`, both database
snapshots, and complete exported CLI results:
`/private/tmp/scip-query-partial-index-audit-d3a56bj7/`.

## Limits and counterchecks

- This was an injected internal failure, not a naturally occurring source
  construct or an observed failure in LaunchPoint. Frequency is unknown.
- The confirmed path is full TypeScript indexing. Incremental emission, fallback,
  multiple compiler shards, and other languages require separate checks.
- `fresh` describes matching source fingerprints; that alone is not a semantic
  completeness promise. The defect is accepting a known failed traversal without
  preserving or exposing its failure.
- An incoming execution query returned no edges in both the damaged and clean
  fixture. That query does not isolate the damage and is not counted as evidence
  of its downstream effect. Its behavior remains unassessed.

## Proposed repair and acceptance checks

### Existing flow

The CLI and watcher both enter the existing reindex coordinator. A full rebuild
runs the bundled TypeScript adapter in a bounded child process. The adapter calls
the pinned upstream synchronous CLI, which invokes each project and file visitor.
The runner classifies a nonzero exit as a failed run; `collectIndexerOutputs`
excludes failed runs and blocks a concatenated language output if any shard
failed. `validateIndexingOutcome` rejects an unsuccessful required language before
publication, unless the user explicitly permits a partial set of languages.

For incremental work, `TypeScriptDocumentEmitter.emitSourceFile` calls the same
file visitor directly. `TypeScriptIndexServiceHost.handle` records and rethrows
errors before returning any fragment packet. `tryMaterializeTypeScriptIncrementalIndex`
then reports the reason the incremental path is unavailable. Full compiler
fallback, when permitted, reaches the defective adapter described above.

### Comparable features and conventions

The current full compiler adapter already adapts pinned upstream prototypes for
stable symbol identities and bounded project emission. The runner already
preserves compiler failure details and implements rejection through its exit
status contract. The indexer-history fixture exercises real compiler processes,
SQLite generations, and watcher recovery; producer-migration tests validate
rejection of incompatible existing metadata. These are the paths to extend.

### Reuse and ownership decisions

Keep error detection in the owned full compiler adapter. Retain the first file
visitor failure for that one synchronous compiler invocation and rethrow it
outside upstream's catch, including its source path and original cause. Do not
infer success or failure by parsing human log text. Reuse existing failed-run,
shard, language, and publication handling; preserve explicit `--allow-partial`
language policy.

Bump the existing TypeScript producer contract version so unchanged local,
shared, and fragment indexes produced without this guarantee require a compatible
rebuild. An old index's document inventory cannot prove that its visitors
completed. Preserve previous generations as recovery artifacts. Use actual
visitor fault injection and independently expected definitions/references for
first-build, replacement, sharded, incremental-fallback, and recovery tests.

- [x] Preserve visitor failure as an explicit failed compiler outcome at the
      owned adapter boundary, even when upstream catches the exception.
- [x] Reject the candidate generation and keep the accepted generation current.
- [x] Surface the affected file and failure cause to CLI and watcher consumers.
- [x] Exercise errors before any occurrence, after partial emission, and after
      another file has completed, through the public indexing path.
- [x] Cover first build, replacement of a healthy index, compiler shards, and
      incremental-to-full fallback; assert durable publication and error results.
- [x] Test recovery without injection, with independent expected definitions and
      references so two equally incomplete builds cannot satisfy the oracle.

## Implementation and validation

The full compiler adapter wraps the existing file visitor for one process-scoped,
synchronous invocation. It retains only the first exception, adds its file path
and cause, and rethrows outside upstream's catch. Existing runner and publication
policy handle the failure. No log parser, alternative index writer, or new
publication path was introduced.

Producer contract version 2 and document-adapter version 4 invalidate old local,
shared, project-shard, fragment, and service identities through their existing
checks. The valid symbol spelling itself has not changed. A compatible rebuild
is required before trusting indexes emitted under the old guarantee.

- The new mid-file regression failed against the original build because the
  public CLI returned success: `/tmp/scip-query-partial-index-before.log`.
- 57 focused tests passed, including full first-build/replacement failures,
  compiler shard rejection, harmless stderr, a real mailbox worker failure
  followed by failed full fallback, and old producer migration/rejection:
  `/tmp/scip-query-partial-index-targeted2.log`.
- All six new failure tests also passed after adding independently specified
  function definitions and exact call bindings at each recovery checkpoint:
  `/tmp/scip-query-partial-index-bindings.log`.
- The fallback test verifies the current generation and database hash stay
  unchanged, status reports stale/ok=false with the service error, and removing
  the fault allows the same service to publish an incremental update.
- `npm run typecheck` passed: `/tmp/scip-query-partial-index-types.log`.
- `npm run lint` passed, including build, format, ESLint, public API compatibility,
  and skill links: `/tmp/scip-query-partial-index-lint-final.log`.
- Source review passed: 573/573 eligible production files, no findings, no
  missing/ambiguous internal imports, all 56 dependency rows declared, and no
  group cycles. The new visitor wrapper has cyclomatic/cognitive complexity 3/3.
  No source-matched test coverage artifact was supplied, so CRAP is unavailable:
  `/tmp/scip-query-partial-index-review.log`.
- [x] Complete the full repository test suite and fresh indexed diff review.
  All 3,433 tests in 397 files passed in 285.57 seconds, including the 19 indexing
  property tests: `/tmp/scip-query-partial-index-full-tests.log`.
  The repository rebuilt its TypeScript, Rust, and Python index successfully in
  21.3 seconds: `/tmp/scip-query-partial-index-self-reindex.log`.
  Fresh `diff-impact` resolved six changed symbols and three consumer files with
  no semantic-provider warning after starting the checkout watcher. It discloses
  eight changed paths outside the index and one changed line range outside an
  indexed symbol; source review and public compiler tests cover the new adapter
  behavior: `/tmp/scip-query-partial-index-diff-impact-final.log`.

The unrelated incoming execution query noted above remains outside this repair.
This fix establishes rejection of observed visitor exceptions; it does not prove
that every successful compiler traversal emits every semantically valid fact.

## VM installation

Installed the tested working-tree package through SSH profile `dev-agent` on
2026-09-08, replacing the canonical package at
`/home/launchpoint-agent/.local/lib/node_modules/scip-query`. The profile's login
shell resolves `scip-query` through `/home/launchpoint-agent/.local/bin/scip-query`.
Package version remains 0.25.0; archive SHA-256 is
`20505e0391cc0940ad17921ef7acd975ac6f8aa13ecefb6e7ed90e0b109b3c3d`.

- Verified all 459 installed package files against the local archive, including
  19 skill files. All six skills resolve through the existing Codex and Claude
  links (12 links total). Retained the VM's compatible Linux native dependencies.
- A VM smoke repository with watching disabled reproduced a visitor exception.
  The installed CLI exited 1, reported the file and cause, and published no
  partial database. A clean retry exited 0 and restored all three independently
  expected function definitions with producer contract version 2.
- Only two watchers were active at the initial process snapshot:
  `projects/launchpoint-next-read-latency` and
  `.t3/worktrees/launchpoint-backend/t3code-b92f0666`. Rechecked process identity
  before stopping them and restarted only those active checkouts. No stopped
  worktree was selected from cached watcher records.
- Both active checkout indexes completed the compatible rebuild: 168.6 seconds
  for next-read-latency and 165.9 seconds for b92f0666. Next-read-latency received
  further source changes and its watcher is actively indexing them; b92f0666 is
  fresh. Both services are running without a current error. Installation does
  not freeze either live worktree while other agents continue editing it.
- Deployment, migration, process snapshots, status exports, and smoke receipts
  are retained on the VM under
  `/tmp/scip-query-partial-success-install-20260908/`. The previous package is a
  rollback copy outside PATH in that directory, not a second global command.
