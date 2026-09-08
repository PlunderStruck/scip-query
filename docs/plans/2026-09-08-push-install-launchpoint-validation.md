# Push, installation, and LaunchPoint validation

Status: in progress. User authorized committing the verified architecture repairs, reviewing/pushing all pending main commits, replacing the dev-agent VM installation with this checkout build and validating LaunchPoint backend. No agent benchmarks.

## Known state and scope

The repair baseline is `a21c01de`; the previous run passed 3,416 tests / 392 files, build, lint, types and API compatibility. Source review and indexed architecture have zero findings in their stated scopes. `main` is 27 commits ahead of the fetched origin with no divergence. Preserve the unrelated untracked `docs/benchmarks/2026-09-06-launchpoint-backend-validation.md`.

SSH `dev-agent` logs into `launchpoint-agent`, UID 1002, whose npm prefix is `/home/launchpoint-agent/.local`. The canonical installation is `.local/lib/node_modules/scip-query`, with `.local/bin/scip-query` pointing to its CLI. Twelve Codex/Claude links target its six workflow skills. Use this installation, preserve pre-existing watcher ownership, and avoid creating a second active installation.

## Work

- [x] Commit only the verified repair files and this operational record (`7b500921`).
- [x] Review pending history/scope and fast-forward push main; verify remote identity (push advanced `a878d9a6` to `7b500921`, all 28 pending commits).
- [x] Package the validated checkout build and record file/skill hashes (455 package files, including 19 skill files; archive SHA-256 `f87b2270fe6ba9119de4b236b93d32e5e502d677e802b8c755a7821e38405925`).
- [x] Record VM installation, watcher state and LaunchPoint checkout state; preserve a rollback copy (`/tmp/scip-query-update-7b500921/`, six watchers, seven existing documentation changes; package backup `previous-package.tar`).
- [ ] Replace the canonical user-level package, repair skill links, and verify hashes, ownership, executable resolution and watcher restoration.
- [ ] Run LaunchPoint status/freshness, current-source inventory/health, configured architecture and a real diff review.
- [ ] Exercise an ordinary incremental change in an isolated LaunchPoint checkout or fixture without altering the user's active source; restore/clean owned test resources.
- [ ] Record results, representative findings, coverage limitations and final remote/install identities; commit/push the receipt.

Use current-source and indexed reports for their distinct claims. A nonzero findings exit is not a tool failure. Investigate command errors and incomplete coverage explicitly. Do not suppress findings or invent architectural ownership for LaunchPoint just to produce a clean report. An installation backup is a rollback artifact, not a second executable installation.

## Validation findings to resolve

- [x] The existing LaunchPoint shadow telemetry is valid JSON with a passing comparison (8,859 predicted files, 2,133 actual changed files, zero missed files), but status rejects it as malformed. Its affected ratio is 1.0603231597845602 after project growth. Traced the incremental writer to the previous database's file count: additions can make this ratio exceed one. A producer-to-reader regression failed before the repair and passed afterward. The reader now accepts finite nonnegative affected ratios while keeping recall bounded to one. Added rejection cases for negative/nonfinite ratios and excessive recall. All 92 shadow/status tests, lint (including its build), and type checks passed. Reinstall and verify the real VM record before marking deployment complete.

The initial replacement at `7b500921` matched all 455 packaged files and 19 skill files, with zero stale dist/skill files or ownership mismatches. All 12 links target the canonical package and all six pre-existing watchers restarted. The login shell resolves only `.local/bin/scip-query`. A detached LaunchPoint validation worktree is being prepared under the task directory; the primary checkout remains untouched.
