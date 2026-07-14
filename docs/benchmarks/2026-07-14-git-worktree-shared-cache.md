# Git worktree shared-cache acceptance

**Date:** 2026-07-14

## Scope

This acceptance run verifies the new repository-scoped cache on real temporary
Git worktrees with the installed `scip-typescript` and `scip` binaries. It is a
functional and relative-performance check, not a large-repository throughput
claim.

## Command

```bash
npm test -- tests/reindex/shared-worktree-cache.integration.test.ts
```

## Result

The three compiler-backed scenarios passed in 3.33 seconds total on the local
development machine:

| Scenario                                               | Wall time reported by Vitest | Acceptance                                                                                                                                                               |
| ------------------------------------------------------ | ---------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Two simultaneous cold worktrees at one `HEAD`          |                      0.903 s | One result built, one result reused after waiting, and exactly one shared-generation publication was observed.                                                           |
| Clean publish, linked-worktree attach, then dirty edit |                      1.504 s | Attach reused without a language indexer; normalized document paths matched; the dirty refresh changed only the local cache and left the shared database hash unchanged. |
| Peer bootstrap after primary files became dirty        |                      0.923 s | The stable primary cache seeded the clean linked worktree because its stored fingerprint matched, while current dirty primary files were not read into the generation.   |

The focused cleanup acceptance also passed: removing a Git worktree deleted its
managed local cache on the next forced sweep, retained its newly unreferenced
shared generation, and deleted that generation at the fake one-hour boundary.

## Correctness oracle

Raw SCIP and SQLite hashes are used only to prove that an immutable shared file
did not change. Cross-worktree semantic parity is checked through normalized
document rows and freshness results because independently produced SCIP or
SQLite files may be byte-different while representing the same facts.

## Rollback and exclusions

`SCIP_QUERY_SHARED_CACHE=0` restores worktree-local-only operation. Explicit
cache/database overrides bypass sharing and cleanup. Dirty and partial indexes
remain local, and shared-cache failures retain the existing local reindex path.
