# Maintenance build revalidation on dev-agent

Validated runtime commit: `9ce8a0de` (including `da158d30`). The separate `2026-09-06-launchpoint-backend-validation.md` was pre-existing work and was not edited.

## Local validation

- 3,058 tests passed across 347 files.
- Build, TypeScript, changed-file lint, public consumer fixture, skill links, and public API contract passed.
- Source reviews for the two final watcher batches were accounted with no blocking findings. The broader maintenance inventory remains open; this is not a complete codebase audit.

## Global replacement

Account `launchpoint-agent`, accessed with `ssh dev-agent`. Replaced the existing npm installation at `/home/launchpoint-agent/.local/lib/node_modules/scip-query`; retained its `.local/bin/scip-query` executable. Interactive `type -a` finds one executable and npm lists one installed package in that prefix. Noninteractive SSH lacks `.local/bin` in PATH, so validation used the absolute executable.

Compared all 452 packaged files with the installed bytes: zero differences. Package shasum: `65d379fd68b0b69919f86ed726ab88433c0137c6`. Saved the previous installed package under `/tmp` for rollback. All four existing idle watchers were stopped and restarted, including LaunchPoint main and its three t3 worktrees. Main now uses PID875597 and reports a fresh index, idle watcher, and no last error.

## LaunchPoint source trial

`health --full` and `system --source --full` completed with accounted coverage:

| Observation | Count |
| --- | ---: |
| Eligible/analyzed TS/JS files | 5,652 / 5,652 |
| Implemented functions | 58,723 |
| Static value-import cycle components | 1 |
| Duplication candidates | 77 |
| Complexity candidates | 2,275 |
| Module groups | 1,386 |
| Module dependency relationships | 7,256 |
| Groups without findings | 915 |
| Files covered by declared architecture boundaries | 28 / 5,652 |

There were no missing or ambiguous internal imports within the covered resolution scope. Nine imports were explicitly excluded (including non-code assets); language, test, reference and generated-file exclusions remain material limits. Four declared boundaries cover only a small portion of this repository. Directory groups describe source organization, not verified business ownership. No source-matched test coverage artifact was supplied, so CRAP measurements cannot be claimed.

The default human report separates dependency, complexity and duplication shortlists, shows policy coverage, discloses 231 unmatched suppressions, and links to module evidence. Its full text was 6,717 characters; it did not require a continuation cursor.

## Checked examples

The cycle's four imports/reexports were verified against exact current source:

`client-access/index.ts:52` → `client-access/operations/campaign-workspace-location.ts:6` → `clients/index.ts:1` → `clients/queries.ts:14` → `client-access/index.ts`.

This establishes a static import cycle, not proof of a runtime failure.

The scanner reports seven copies of `collectFlag`. Exact complete bodies in `src/scripts/apply-crosswire-mopup.ts:94` and `src/scripts/backfill-post-text.ts:72` match. Their free `argv` dependency must be made explicit before consolidating them. Only these two bodies were manually checked; the remaining five are scanner candidates.

Large complexity candidates include `RunAdScreen` (329 cyclomatic /323 cognitive), `ManagedAdPublicationSettings` (188/161), and `validatePostTrigger.run` (145/213). These are measurements under the tool's published counting rules, not confirmed design defects. Their behavior has not been manually audited in this trial.

No LaunchPoint application source or architecture configuration was changed. This trial establishes useful inventory and checked findings on a large real repository; it does not establish that every command is accurate or that agents using the tool produce better changes.

## Artifacts on dev-agent

- `/tmp/scip-maintenance-upgrade-verification.json`
- `/tmp/scip-maintenance-watcher-restarts.json`
- `/tmp/scip-maintenance-launchpoint-health.json`
- `/tmp/scip-maintenance-launchpoint-modules.json`
- `/tmp/scip-maintenance-launchpoint-finding-source.json`
- `/tmp/scip-maintenance-launchpoint-health-human.txt`
- `/tmp/scip-maintenance-launchpoint-status-after.json`
