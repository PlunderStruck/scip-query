# Push, installation, and LaunchPoint validation

Status: deployment and live command validation completed; one strict incremental-equivalence finding remains unresolved below. User authorized committing the verified architecture repairs, reviewing/pushing all pending main commits, replacing the dev-agent VM installation with this checkout build and validating LaunchPoint backend. No agent benchmarks.

## Known state and scope

The repair baseline is `a21c01de`; the previous run passed 3,416 tests / 392 files, build, lint, types and API compatibility. Source review and indexed architecture had zero findings in their stated scopes. At the start, `main` was 27 commits ahead of the fetched origin with no divergence. The unrelated untracked `docs/benchmarks/2026-09-06-launchpoint-backend-validation.md` was preserved.

SSH `dev-agent` logs into `launchpoint-agent`, UID 1002, whose npm prefix is `/home/launchpoint-agent/.local`. The canonical installation is `.local/lib/node_modules/scip-query`, with `.local/bin/scip-query` pointing to its CLI. Twelve Codex/Claude links target its six workflow skills. Use this installation, preserve pre-existing watcher ownership, and avoid creating a second active installation.

## Work

- [x] Commit only the verified repair files and this operational record (`7b500921`).
- [x] Review pending history/scope and fast-forward push main; verify remote identity (push advanced `a878d9a6` to `7b500921`, all 28 pending commits).
- [x] Package the validated checkout build and record file/skill hashes (455 package files, including 19 skill files; archive SHA-256 `f87b2270fe6ba9119de4b236b93d32e5e502d677e802b8c755a7821e38405925`).
- [x] Record VM installation, watcher state and LaunchPoint checkout state; preserve a rollback copy (`/tmp/scip-query-update-7b500921/`, six watchers, seven existing documentation changes; package backup `previous-package.tar`).
- [x] Replace the canonical user-level package, repair skill links, and verify hashes, ownership, executable resolution and watcher restoration (final deployed source `d4e18138`; all 455 package files / 19 skill files match, 12 links correct, six original watchers restored).
- [x] Run LaunchPoint status/freshness, current-source inventory/health, configured architecture and a real diff review.
- [x] Exercise an ordinary incremental change in an isolated LaunchPoint checkout or fixture without altering the user's active source; source restored and temporary resources cleaned up. Publication succeeded, but the strict baseline-equivalence assertion failed; see the finding below.
- [x] Record results, representative findings, coverage limitations and final remote/install identities; commit/push the receipt.

Use current-source and indexed reports for their distinct claims. A nonzero findings exit is not a tool failure. Investigate command errors and incomplete coverage explicitly. Do not suppress findings or invent architectural ownership for LaunchPoint just to produce a clean report. An installation backup is a rollback artifact, not a second executable installation.

## Validation findings to resolve

- [x] The existing LaunchPoint shadow telemetry is valid JSON with a passing comparison (8,859 predicted files, 2,133 actual changed files, zero missed files), but status rejects it as malformed. Its affected ratio is 1.0603231597845602 after project growth. Traced the incremental writer to the previous database's file count: additions can make this ratio exceed one. A producer-to-reader regression failed before the repair and passed afterward. The reader now accepts finite nonnegative affected ratios while keeping recall bounded to one. Added rejection cases for negative/nonfinite ratios and excessive recall. All 92 shadow/status tests, lint (including its build), and type checks passed. Reinstall and verify the real VM record before marking deployment complete.

The initial replacement at `7b500921` matched all 455 packaged files and 19 skill files, with zero stale dist/skill files or ownership mismatches. All 12 links target the canonical package and all six pre-existing watchers restarted. The login shell resolves only `.local/bin/scip-query`. A detached LaunchPoint validation worktree was prepared under the task directory and removed after testing; the primary checkout remained untouched.

The telemetry repair was committed and pushed as `d4e18138`. Its package contains 455 files (19 skill files), archive SHA-256 `a4d0d952f16db7eeed0c8c907f7658f7c963db3bfc1b758dd47159e97d3f9b36`. Scoped current-source review found no introduced findings. Indexed diff impact was run with its disclosed unindexed paths; it does not establish complete absence of consumers.

## LaunchPoint findings and coverage

Full machine reports are under `/tmp/scip-query-update-7b500921/` on the VM. The compact [validation result](2026-09-08-launchpoint-validation-results.json) preserves counts, examples, and coverage limitations without embedding the full source inventory.

- Current-source health and inventory captured all 5,949 eligible production TS/JS files and analyzed 60,474 functions with zero parse/resource/configuration problems. Default exclusions include 2,863 tests/fixtures, 17 reference files and 4,983 unsupported-language files. No unresolved production imports; nine explicitly excluded targets include CSS, JSON and test fixtures.
- Inventory contains 1,469 module groups and 7,628 group relationships. It includes 993 groups without findings. Most groups are provisional directory groups, not confirmed business owners.
- Health reports 2,341 complexity findings, 63 duplication candidates, and one four-file static value import cycle. `RunAdScreen` is the highest complexity example (cyclomatic 329, cognitive 323). The cycle connects client-access and clients through their index/re-export modules. Findings are evidence for review, not a single architecture grade.
- Four existing campaign-editor boundaries map only 28/5,949 production files (32/8,761 files in indexed architecture). Configured rules have zero forbidden edges, cycles, stale allowances, or size violations. Three fragile dependency candidates remain. The clean configured result says nothing about ownership quality in the other 5,921 production files; no rules were added or relaxed during validation.
- Source review against `HEAD^` (`86dbc1aa1`) detects two changed functions across two changed source files, with complexity deltas of zero and no introduced findings. Indexed diff impact reports four changed symbols and three consumer files; eight changed documentation/unindexed paths are explicitly disclosed. CRAP is unavailable because no source-matched test coverage artifact was supplied.

## Incremental validation result

The detached checkout at `/tmp/scip-query-update-7b500921/launchpoint-validation` uses LaunchPoint commit `3989b65ab`, its frozen pnpm lockfile, and no application environment files. No application server, build, database, queue or provider is invoked. The first reindex recovered an older shared baseline but required a watcher for the TypeScript service. Starting that watcher began the refresh automatically; a simultaneous manual retry correctly failed to acquire its lifecycle lock. Wait for the active refresh before the edit test rather than interrupting its publication.

The initial refresh completed in 303.5 seconds. The fresh isolated index contains 8,763 documents and 465,269 global symbols. It used the incremental publication path with conservative whole-project scope for added files, preserving the accepted index until publication. Both the primary checkout's pre-existing telemetry and the isolated checkout's growth telemetry now render as passing under `d4e18138` without rewriting either telemetry record.

Operational limit: that initial refresh accounted for about 2.4 GB of writes and exhausted the watcher's 1 GiB automatic write allowance. The watcher explicitly paused with the test edit pending. The edit test therefore uses normal explicit `reindex` calls with the watcher service available, without force, a whole-project fallback flag, or a resource-policy change. This validates incremental publication, not uninterrupted automatic refresh after a large cold start.

The explicit addition completed in 41.927 seconds, using an incremental update of five affected files and three changed document units. Restoring the source was later refreshed automatically after the budget pause expired. The exported test symbol appeared and disappeared as expected. All 8,763 document paths remained present; hashes for the 8,758 documents outside the affected set remained unchanged. The final index has zero dangling symbol references or definition-range references. The isolated checkout was clean after restoration.

### Open: strict cold-to-warm index equivalence

- [ ] Investigate the failed raw-identity round trip before claiming full incremental equivalence. The initial index contained 465,269 symbols; the addition contained 465,343; restoration contained 465,342. Between addition and restoration, two `TableNote` property descriptors changed from compiler-generated `typeLiteral29` identities to `typeLiteral24`, besides the expected removal of the test export. The restored catalog therefore differs by a net 73 symbols from the initial catalog. This is not yet proof of a lost source binding, and the successful publication status does not resolve it.
- [ ] Add a small real-compiler history fixture containing anonymous object types and the cold/warm query sequence. The existing history fixture compares complete symbol strings but does not currently cover this observed `typeLiteral` case.
- [ ] Retain the full initial compiler/database snapshot in that reproduction and compare definition/reference locations, grouping, and named identities against an independent compiler result. Determine whether the extra catalog entries are valid metadata, stale retained entries, or evidence of inconsistent bindings. Do not make the test pass by stripping identity numbers without establishing binding equivalence.
- [ ] Fix any demonstrated inconsistency and rerun the focused history test and LaunchPoint validation.

Evidence remains on the VM in `/tmp/scip-query-update-7b500921/incremental-validation.json`, `incremental-symbol-delta.json`, and `incremental-evidence/{addition-index.db,restored-index.db}`. The initial generation was collected before its full symbol delta was saved; its document/chunk hashes and symbol count/hash remain in `incremental-baseline-index.json`. This limits what the current run can conclude about the net 73-symbol increase. The initial checker also had to be corrected because SCIP document text and symbol display names are optional; it ultimately inspected the immutable published generations and full SCIP identities directly.

## Final installation and cleanup

The installed runtime and skills match source commit `d4e18138`. This final receipt changes documentation only, so another package replacement is unnecessary. Final verification rechecked all 455 package hashes, 12 skill links, and the exact six original watcher roots. The temporary watcher, worktree, and its owned cache were removed; diagnostic database copies and package rollback archives remain outside the active installation. LaunchPoint's original HEAD, Git status, and bytes for all seven pre-existing changed files match the initial snapshot. No LaunchPoint source changes were committed and no agent benchmarks were run.
