# Install the TypeScript breadth repair build on dev-agent

Status: installation, skills, selected checkout refresh and watcher restart verified.

## Scope and artifact

Install the current checkout's tested distribution through SSH alias `dev-agent`, which connects as `launchpoint-agent` on `wnx0019585`. Preserve watcher state: restart only the live watcher selected immediately before replacement, and skip it if its process identity changes or its checkout disappears. Do not start other worktrees.

- Canonical package: `/home/launchpoint-agent/.local/lib/node_modules/scip-query`.
- Login-profile executable: `/home/launchpoint-agent/.local/bin/scip-query`.
- Package version: `0.25.0`; the archive/file digests identify this working-tree build more precisely than the unchanged version number.
- Archive SHA-256: `65d8fc1f44cb8d228ec9d5308a411999f4f65afb4eb47675ef6c354e301a087f`.
- Tested source and distribution match the [breadth repair receipt](../benchmarks/typescript-accuracy-audit/2026-09-09-breadth-repairs.json).
- Remote receipts and rollback: `/tmp/scip-query-breadth-install-20260909-EHDXbZ/`.

## Completed checks

- [x] Package the exact tested distribution and six skills; verify archive hash after transfer.
- [x] Confirm one login-profile executable and the canonical account-local npm prefix.
- [x] Compare dependency and Node engine declarations with the previous installation; preserve compatible Linux dependencies in an independent staged copy.
- [x] Verify the staged CLI and Linux SQLite native binding before replacement.
- [x] Snapshot and revalidate the one live watcher: PID `3228635`, root `/home/launchpoint-agent/.t3/worktrees/launchpoint-backend/t3code-66bd3d33`.
- [x] Stop that watcher through its normal control, replace the canonical package, and retain the previous package outside PATH.
- [x] Verify all 458 shipped file hashes and run `install-skills`: all 12 Codex/Claude links already point to the six updated workflows, with none skipped.
- [x] Run a real TypeScript fixture on Linux: indexing, call graph, complexity, source scanner, augmentation and status; compare runtime and query results with explicit expectations.
- [x] Refresh the selected checkout for the installed build, restart only its watcher, and verify final freshness and publication state.
- [x] Recheck installed hashes, skill links and executable resolution; save the final receipt.

The fixture returns `3` and `1` when executed by Node. Its indexed entry function has cyclomatic complexity `2`, one exact helper callee and zero candidate callees; call-graph selects that helper. The scanner covers both functions in the only source file. Standalone augmentation leaves a fresh, current generation with a passing SQLite `quick_check`. Fixture watching is disabled throughout.

The selected LaunchPoint checkout was fresh under the previous installation and stale under the new build. The prescribed refresh completed with permission for a full fallback, without changing its persistent resource or watcher settings. The command took 904.9 seconds wall time; its recorded reindex phase took 888.2 seconds. This installation check records that cost without claiming to have diagnosed or improved it.

The final index contains 9,221 documents and 485,167 symbols. Status reports fresh source inputs, a current immutable generation, a current SCIP companion and passed publication validation. SQLite `quick_check` passed on the stable database. The accepted generation is `42bb07135cd23e5dde202d81b49c8f4411744cf03a86a03f14ecad7c15fc9a2b`.

Only the selected watcher was restarted: old PID `3228635`, new PID `3714299`. Final process inspection found that single watcher running the canonical installed script, and status reports it idle on the new generation. No previously stopped worktree watcher was started. All 458 shipped file hashes and all 12 skill links were rechecked after the refresh and restart.

The [final machine receipt](../benchmarks/typescript-accuracy-audit/2026-09-09-breadth-vm-install.json) contains the installed artifact identity, smoke assertions, index/publication status and watcher identities. The previous package remains outside PATH for rollback; the login profile resolves one global executable. This installation used the tested working-tree build and did not create or push a commit.
