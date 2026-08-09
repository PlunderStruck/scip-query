---
name: scip-setup
description: Install, diagnose, index, watch, repair, or clean up scip-query for a repository. Use for setup, freshness, cache ownership, worktrees, watcher behavior, and operational failures—not ordinary code exploration.
---

# SCIP Setup

Use this skill when the exploration surface itself is unavailable, stale, slow, or consuming unexpected disk or CPU. An operational diagnosis identifies the concrete state transition that prevented a checkout-local index from becoming or remaining fresh; it does not infer failure from elapsed time alone.

1. Run `scip-query status` to inspect the active checkout, index generation, freshness, watcher, and cache ownership.
2. Run `scip-query doctor` when status reports an inconsistency or a command fails. Treat each reported repair as a separate action.
3. Run `scip-query setup` for first-time project installation or an explicitly requested repair. Setup establishes the index, generated agent guidance, skill links, and watcher lifecycle; quality analysis is a separate `scip-query health` operation.
4. Run `scip-query watch` only when the repository needs a long-lived incremental watcher and setup did not establish one.
5. Use the exact recovery command printed by status or doctor. Do not delete caches, force a full rebuild, or reinstall globally merely because an index is stale; first identify whether configuration, project membership, toolchain identity, or an ordinary changed file caused the transition.

Each worktree owns its mutable generation and may reuse an immutable baseline from a related checkout. A full rebuild is justified when configuration, toolchain identity, or project membership invalidates the prior compiler graph. Ordinary edits should use the incremental path. Cache cleanup must retain active checkout generations and remove only records whose owning roots are gone or whose retention window has expired.

After a repair, prove the requested outcome directly: status is fresh, an ordinary source edit updates incrementally, simultaneous worktrees remain isolated, deleted worktree caches age out, or repeated cleanup reaches a disk plateau. Do not run `health` as proof of index freshness and do not run exploration commands as a substitute for lifecycle diagnostics.
