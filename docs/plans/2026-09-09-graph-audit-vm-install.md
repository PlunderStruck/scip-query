# Graph audit commit and VM installation

Status: installation verified. The graph-audit build and current skills are installed under the `dev-agent` SSH profile. The surviving selected checkout has a fresh index and a running watcher; the other selected checkout disappeared during its rebuild and was not recreated. The unrelated LaunchPoint benchmark document remains uncommitted. Git publication is checked against remote `main` after committing this receipt.

## Required facts and completion checks

1. [x] Confirm all 1,671 source/test/build hashes match the build validated by 3,555 passing tests.
2. [x] Confirm main and its origin; SSH resolves to `launchpoint-agent`, canonical prefix `/home/launchpoint-agent/.local`, one login-profile CLI.
3. [x] Package exact build and skills, verify dependencies and archive/file hashes, retain rollback outside PATH.
4. [x] Snapshot currently running watchers, revalidate their process identities before stopping them, and never start a stopped checkout.
5. [x] Replace the canonical package, verify global resolution, and reinstall/verify six skills.
6. [x] Exercise the installed build against a real compiler fixture with independent expected graph results.
7. [x] Upgrade the surviving selected checkout from producer 3 to producer 4, restart its watcher, and verify final lifecycle/index state without changing resource budgets. Record the missing checkout separately.
8. [x] Commit all audit-owned source, tests and documentation on `main`; preserve the unrelated benchmark document. Save the final push/local-remote hash comparison in the deployment receipts after committing this record.

The initial read-only process check found two active watchers: `/home/launchpoint-agent/projects/launchpoint-next-read-latency` and `/home/launchpoint-agent/.t3/worktrees/launchpoint-backend/t3code-b92f0666`. Recheck actual live processes immediately before replacement rather than relying on this historical list.

## Installed artifact and verification

- Archive SHA-256: `61a41a94b029a1ac6dd1ae3e58492944b718cb6585c13e7e602612525da68fdb`; 460 package files, including 19 skill files.
- Replaced `/home/launchpoint-agent/.local/lib/node_modules/scip-query`; verified every shipped file hash. Dependency declarations and Node engine requirements match the earlier installation; retained compatible Linux dependencies through an independent copy. Login PATH resolves one CLI at `/home/launchpoint-agent/.local/bin/scip-query`.
- Verified 12 Codex/Claude links to the six current workflows.
- Revalidated and stopped only the two live watcher PIDs, 2844742 (b92f0666) and 2636982 (next-read-latency). No stopped checkout was selected.
- The installed Linux build passed six real-index regression groups: same-line return ownership for first/second/outer, nested and arrow callers, Unicode call positions, stored function references excluded as calls, explicit superclass constructor calls, and reassigned callable exclusion. The fixture has watching disabled and started no watcher. The initial probe assertions were corrected to compare canonical compiler identities (including escaped constructor descriptors), rather than display labels; no production code change was needed.
- VM receipts and rollback: `/tmp/scip-query-graph-install-20260909-uscubt4f/`.

## Checkout refresh and watcher outcome

- `t3code-b92f0666`: rebuilt in 310.1 seconds; publication validation passed. All 9,015 SQLite documents report UTF-16 positions. Both the repository and TypeScript fingerprints report symbol identity version 4. Final status is fresh, with watcher PID 3050905 running and idle on the installed canonical script.
- `launchpoint-next-read-latency`: compiled 9,025 TypeScript inputs, but the checkout path disappeared during the rebuild. Publication stopped with `ENOENT` for the checkout root. A subsequent filesystem check confirmed the directory no longer exists. Its watcher was not restarted, and no replacement checkout was selected.
- Final process verification found exactly one watcher: the surviving member of the original two-process snapshot. No previously stopped checkout was started. Watcher resource settings were not changed.
- Reverified all 460 shipped file hashes, all 12 skill links, and the single login-profile CLI after the refresh and restart. The standard suite validated this unchanged runtime build with 3,555 passing tests across 407 files; the installed Linux fixture passed six graph regression groups.
- `final-verification.json`, `producer-verification.json`, `smoke-receipt.json`, and `watchers-skipped.json` retain the deployment evidence. The previous package remains outside PATH for rollback.
