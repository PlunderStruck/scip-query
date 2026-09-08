# Push, installation, and LaunchPoint validation

Status: in progress. User authorized committing the verified architecture repairs, reviewing/pushing all pending main commits, replacing the dev-agent VM installation with this checkout build and validating LaunchPoint backend. No agent benchmarks.

## Known state and scope

The repair baseline is `a21c01de`; the previous run passed 3,416 tests / 392 files, build, lint, types and API compatibility. Source review and indexed architecture have zero findings in their stated scopes. `main` is 27 commits ahead of the fetched origin with no divergence. Preserve the unrelated untracked `docs/benchmarks/2026-09-06-launchpoint-backend-validation.md`.

SSH `dev-agent` logs into `launchpoint-agent`, UID 1002, whose npm prefix is `/home/launchpoint-agent/.local`. The canonical installation is `.local/lib/node_modules/scip-query`, with `.local/bin/scip-query` pointing to its CLI. Twelve Codex/Claude links target its six workflow skills. Use this installation, preserve pre-existing watcher ownership, and avoid creating a second active installation.

## Work

- [ ] Commit only the verified repair files and this operational record.
- [ ] Review pending history/scope and fast-forward push main; verify remote identity.
- [ ] Package the validated checkout build and record file/skill hashes.
- [ ] Record VM installation, watcher state and LaunchPoint checkout state; preserve a rollback copy.
- [ ] Replace the canonical user-level package, repair skill links, and verify hashes, ownership, executable resolution and watcher restoration.
- [ ] Run LaunchPoint status/freshness, current-source inventory/health, configured architecture and a real diff review.
- [ ] Exercise an ordinary incremental change in an isolated LaunchPoint checkout or fixture without altering the user's active source; restore/clean owned test resources.
- [ ] Record results, representative findings, coverage limitations and final remote/install identities; commit/push the receipt.

Use current-source and indexed reports for their distinct claims. A nonzero findings exit is not a tool failure. Investigate command errors and incomplete coverage explicitly. Do not suppress findings or invent architectural ownership for LaunchPoint just to produce a clean report. An installation backup is a rollback artifact, not a second executable installation.
