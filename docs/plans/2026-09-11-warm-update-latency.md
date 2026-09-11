# Reduce ordinary warm TypeScript updates

Status: validated; committing and deploying. Baseline code `85ab45c1`, current HEAD `8025396a`. Preserve the unrelated untracked LaunchPoint validation document and disabled watchers. No agent benchmarks.

## Outcome

Reduce the complete 16–20-second private LaunchPoint edit requests, including required validation and publication. Preserve compiler document identity, runtime observations/groups/links/frontiers, source freshness, cancellation and immutable-reader guarantees. Report ordinary edits separately from broad public type changes and one-time cache preparation.

## Existing flow and evidence

`runtime/project-reindex.ts:reindexConfiguredProject` and the watcher invoke `reindex/index.ts:reindex`. The coordinator fingerprints current inputs through `platform/project-files.ts`, obtains publication locks, then calls `typescript-incremental-index.ts:tryMaterializeTypeScriptIncrementalIndex`. That planner computes affected files and batches through `TypeScriptIndexRequester.request` to the existing watcher-owned `TypeScriptIndexServiceHost.handle`. The emitter updates its retained program and returns new documents or verified retained references. The coordinator copies/patches SQLite, updates source checkpoints and runtime relationships, validates source again, and promotes an immutable generation through `sqlite-generation-store.ts:promoteReindexArtifacts`.

The current `context src/reindex/typescript-incremental-index.ts` confirms the coordinator as its direct consumer and the existing domain, platform, storage and semantic owners as dependencies. Source reads establish the live mailbox and publication path. Reuse the same owners.

Profiled warm body request: 16.45s wall; initial fingerprint 2.50s; language indexing 5.25s; runtime work 4.14s; immutable handoff 1.95s; SQLite copy 0.57s; dependency carry 0.49s. These are nested spans, not additive independent totals. The actual private cache lacks `fingerprint-stat-cache.json`: that owner resolves the default cache without the explicit output/configured cache path. Investigate this before treating the private benchmark as representative of default-cache installations. Existing published warm timings remain valid for that measured configuration.

## Comparable mechanisms and ownership choices

- `platform/fingerprint-stat-cache.ts` already owns cross-process file hashes and validates device/inode/size/mtime/ctime. Fix cache routing through its existing owner; do not add a parallel cache or weaken identity checks. `project-snapshot-context.ts` demonstrates scoped asynchronous context if needed to carry the selected cache through existing readers.
- The requester already returns the compiler service duration per batch. Observe it to distinguish compiler work from transport, polling and repeated validations before changing the compiler.
- Runtime phase records validate actual source bytes and SQL results. Retain those proofs and full invalidation for changed inputs.
- Immutable publication already distinguishes unchanged SCIP companions and changed SQLite databases. Any copy reduction must keep prior readers and crash recovery correct; measure it before changing storage.
- Existing generated publication histories, fragment tests and fresh-compiler comparisons are the regression owners. Extend those rather than creating a second index path.

## Work list

- [x] Measure per-batch compiler versus requester time, fingerprint cache behavior and remaining publication costs.
- [x] Fix confirmed repeated work with the existing owners; record distinguishing regressions and retained limits.
- [x] Run focused tests, stable full suite, types/lint/API, review, fresh impact and architecture checks where needed.
- [x] Measure complete private edit histories on the frozen candidate and verify graph/source/SQLite results.
- [ ] Commit/push and update dev-agent if behavior changes, preserving the active watcher set; record final receipts.

Scratch: `/tmp/scip-warm-perf-20260911` locally and `/tmp/scip-query-fast-install-20260910-jWoJur/warm-profile-baseline` remotely. Baseline private watchers 59789 and 63530 stopped and source was restored by the runners. The instrumented five-edit history passed graph, source, and SQLite verification.


Confirmed per-batch profile: a warm body update makes 44 requests of at most 128 files. Its first service call takes 718ms; the remaining calls consume 2.70s in the service even though all their documents are retained. The generation validator decodes and projects the complete metadata inventory on every call. It now re-reads and hashes the exact bytes on every call but retains one decoded generation result for identical bytes. No protocol, batch bounds or generation checks changed. A regression detects same-size edits with restored timestamps, missing metadata and unsupported versions.

The fingerprint cache is now selected through the existing operation's output directory using scoped asynchronous context, following the project-snapshot context convention. Reindex, checkpoint recovery and runtime freshness use that scope; caches for overlapping operations remain separate. File identity checks and best-effort persistence are unchanged. Tests demonstrate persistence through the real reindex path and reload through runtime freshness, plus concurrent scope isolation.

55 focused tests pass; source review has no findings. Full stable-build suite and complete candidate measurements are running. Scope remains these two measured sources of repeated work; publication copying and unchanged runtime-proof validation are retained.

The first candidate measured 27.81s after worker restart, 12.39s warm body, 12.64s warm reference, 13.91s HTTP, and 15.43s restoration, with peak request/worker memory 4.97–5.12 GiB. Every original runtime object was preserved; the HTTP probe added exactly one observation, group, and frontier; restoration matched original file coverage/source bytes and passed SQLite checks.

The full suite caught eight freshness failures in one file: the new cache selection reinterpreted an already-resolved database path as project configuration. Freshness now passes its existing resolved cache/database directory through to fingerprinting. Existing tests were retained unchanged and the 16 focused freshness/publication tests pass. A final frozen package and complete suite are being rechecked after that correction.

The API-check npm wrapper triggered a redundant rebuild during the second suite run. Every one of the 466 packaged files was checked afterward against the frozen tarball and matched byte-for-byte. No source changed during either build. Record any test errors rather than attributing them to this overlap without evidence.

The second suite completed with 3,921/3,922 passing; its only failure was the absent executable during the redundant build. The complete 19-test indexing property file subsequently passed with the build held fixed.

Final LaunchPoint validation exposed a separate existing publication bug through the deployment preparation experiment: `publishSqliteAugmentation` stores uniquely named database/metadata artifacts, but `recoveryForGeneration` guessed `index.db` and `meta.json`. The next reindex therefore reported a missing recovery database and refused incremental operation. Recovery paths now come from the validated immutable manifest, the same authority as normal readers. Two regressions cover augmentation followed by ordinary or metadata-only publication, including recovery database contents and metadata. All 33 handoff tests pass. This is necessary for reliable runtime-only preparation; the package and final measurements are rebuilt after this fix.

Final source review reports no findings. Fresh impact covers 17 changed symbols and 15 affected files; six changed test/document paths are excluded from the symbol index and covered by source review/tests. Architecture has no cycles or forbidden production/test edges; its existing source-boundary file count (72 versus configured 67) is unchanged. Types, formatting, ESLint, the 66-path public API contract, consumer types, and skill links pass.

Frozen final package: SHA-256 `4063d6a1ec786f9838fda583733a53772c7ea45dc59f38781da755fb29fce44d`, 466 shipped files. Final private baseline is rebuilt from the compiler, then runtime-only publication and five incremental edits exercise the corrected recovery path. Deployment staging is `/tmp/scip-query-warm-final-deploy-20260911-G7E5sr`; no production watcher has been replaced yet.

Final stable-build suite: **426 files / 3,924 tests passed**, including generated indexer histories and process-death recovery. No build ran during this final suite.

Final measured edit times: 28.83s after worker restart, 12.64s body, 13.15s reference, 14.41s HTTP, 15.68s restoration. Warm requests improve about 20–22% over the previous published private configuration; peak memory remains 4.98–5.14 GiB. All five graph comparisons, exact source restoration, removed probe symbols, SQLite quick/FK checks and temporary-worker shutdown passed. Full details: `docs/benchmarks/runtime-indexing/2026-09-11-warm-update-latency.json`. The final test included the runtime-only augmentation path that exposed the recovery bug.
