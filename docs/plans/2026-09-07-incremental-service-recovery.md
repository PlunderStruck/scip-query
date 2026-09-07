# Incremental TypeScript service recovery

Baseline: `67823638`. Continue the prior cleanup by resolving its recorded incremental-service availability gap. Preserve the unrelated untracked LaunchPoint report. No agent benchmarks.

An incremental refresh updates the stored code index using the affected source documents instead of rebuilding every document. In the current implementation, the requesting reindex process sends document requests to a TypeScript compiler worker owned by the checkout's watcher service.

## Evidence and existing flow

`status` reports a fresh full-rebuild index and a stopped watcher; `doctor` reports no artifact inconsistency. This checkout has `watch.enabled: true` and `watch.autoStart: false`. `ensureWatchServiceForCommand` respects that explicit setting. `emitTypeScriptMaterializationBatches` creates a `TypeScriptIndexRequester` with `requireService: true`, so a missing service causes a refusal to load the compiler in the reindex process. The accepted index remains intact.

The existing owners are CLI preparation → watcher lifecycle → TypeScript index mailbox → compiler worker → document materialization → atomic generation publication. Preserve this path, its process isolation, configuration controls, and published-generation checks. Do not create another compiler implementation or enable automatic watching by editing configuration.

## Work list

- [x] Inspect current status, doctor, service admission, and incremental requester behavior.
- [x] Start the existing service explicitly and inspect its actual readiness or startup failure.
- [x] Exercise a reversible ordinary source edit and its restoration; verify incremental document publication and fresh status without a full rebuild.
- [x] Correct any demonstrated failure and make missing-service recovery actionable without weakening memory/full-rebuild guards.
- [x] Add regression coverage for the demonstrated failure/recovery contract.
- [x] Run relevant tests, types/build/API checks, and diff review; record outcomes and commit.

The initial evidence supports a stopped-service configuration explanation, not a compiler crash or proof of a broken incremental algorithm. Revise that assessment if explicit startup or a real edit exposes a different failure.

## Observed recovery

`watch --daemon` explicitly started the existing service with unchanged checkout configuration. A temporary function appended to `src/platform/write-bytes.ts` was emitted into the compiler index and shown by `outline`. Ordinary `reindex` emitted 53 affected documents in two bounded batches across two projects, patched those SQLite documents, and carried 490 unaffected reference-document records forward. It reused Rust/Python shards, deferred the whole SCIP companion, and completed in 7.9 seconds; compiler request time was 3.215 seconds on the cold service.

Restoring the file's exact original bytes followed by ordinary `reindex` again emitted 53 affected documents and patched SQLite without a whole-project rebuild. It reused the warm service (1.641 seconds of compiler requests, 5.6 seconds overall). `outline` then showed only the original function, proving the temporary compiler symbol was removed. The temporary probe is not part of the change.

The demonstrated issue was recovery guidance for a stopped service, not a broken incremental algorithm. The requester error now names `watch --status`, explicit `watch --daemon`, and retrying `reindex`. It still refuses to load the compiler in the requesting process; the existing regression test checks both the recovery instruction and zero local compiler calls. Automatic-start configuration and full-rebuild policy remain unchanged.

The service was stopped before rebuilding this checkout's CLI so that no background refresh could read a partially written `dist`. It will be restarted explicitly with the final build and checked again.

## Final verification

- Rebuilt the CLI and explicitly restarted its service. Final `status` reports fresh, a running daemon, and an incremental generation (12 affected documents, three changed documents). The final unchanged `reindex` reused that generation in 0.3 seconds.
- 51 tests passed across TypeScript index mailbox, watcher lifecycle, and real per-worktree watcher integration suites. No full-suite rerun was needed for this error-guidance-only code change; the preceding cleanup's 3,286-test result remains recorded separately.
- Type checks, changed-file ESLint/Prettier, build, public API check (`b74137d6c422ca9c`, 66 paths), public API consumer compilation, and diff whitespace checks passed.
- `review --base 67823638` reports no findings with 568/568 eligible source files accounted for. The changed method remains cyclomatic 3/cognitive 2. No matched coverage receipt was supplied, so CRAP remains unavailable.
- Fresh `diff-impact` identifies one changed indexed source file, two changed symbols, and two affected files. The excluded test/document paths are disclosed; the unrelated LaunchPoint report is excluded from this commit.

The service is running explicitly under the existing 15-minute idle timeout. `watch.autoStart` remains false, so after a clean idle exit a future incremental refresh can require `watch --daemon` again. The corrected diagnostic exposes that recovery instead of leaving an agent to infer that a full rebuild is required.
