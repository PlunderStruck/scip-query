# Cache-lifecycle plateau soak

## Claim

The repository cache is bounded across repeated disposable Git worktrees while preserving the active checkout, and an eligible TypeScript edit uses the incremental index service rather than a whole-project rebuild.

## Method

`npm run soak:cache-lifecycle` builds scip-query, creates one private canonical repository and cache root, and runs eight worktree generations. Each generation:

1. creates a detached disposable worktree from the canonical committed `HEAD`;
2. attaches the repository-shared baseline generation;
3. starts the real watch daemon through the built CLI;
4. commits one TypeScript source edit and requests reindexing;
5. requires an incremental SQLite document patch with no fallback message;
6. requires two retained local SQLite generations and one TypeScript fragment generation;
7. stops the daemon and removes the worktree;
8. runs lifecycle collection before and at the injected grace-period boundary; and
9. requires the disposable cache and shared generation to disappear while the active baseline survives and managed bytes return exactly to the warm baseline.

The start and stop operations use separate CLI processes, matching normal daemon ownership. Starting and synchronously stopping the detached daemon from the soak process itself would prevent Node's event loop from reaping its own child while the synchronous stop controller polls it.

## Result

The eight-cycle run passed on 2026-08-09.

- Baseline managed bytes: `403330`
- Final managed bytes: `403330`
- Incremental publications: `8/8`
- Incremental patch size: one SQLite document in every cycle
- Incremental patch time: `7-9 ms`
- End-to-end changed-tree reindex time: `732-926 ms`
- Local SQLite generations after every update: `2`
- TypeScript fragment generations after every update: `1`
- Removed worktree caches collected: `8/8`
- Aged shared generations collected: `8/8`
- Active canonical cache and baseline generation survived: `8/8`

The associated integration test repeats the same retention and grace-period assertions with a deterministic clock. The standalone soak adds the real daemon and incremental service path. A direct `reindex()` call without that service intentionally reports that incremental TypeScript indexing is unavailable and falls back to the whole-project indexer; the passing soak proves the production service route rather than misclassifying that fallback as incremental behavior.

## Reproduction

```sh
npm run soak:cache-lifecycle
npx vitest run tests/reindex/shared-worktree-cache.integration.test.ts tests/runtime/repository-cache-lifecycle.test.ts
```

The soak owns a private temporary repository and `XDG_CACHE_HOME` and removes both in a `finally` block. It does not retain benchmark worktrees or caches after success or failure.
