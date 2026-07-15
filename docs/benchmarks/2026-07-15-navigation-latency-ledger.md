# Navigation command latency optimization ledger

Date: 2026-07-15
Status: Three optimization passes implemented and verified

## Output contract

For the same project, index generation, source tree, command arguments, and
options, `code`, `outline`, and `refs` must preserve the outputs recorded in the
[baseline](./2026-07-15-navigation-latency-baseline.md). A faster path is rejected
if it drops semantic references, changes symbol choice, changes source ranges,
or changes outline ancestry.

## Current pipeline

1. The CLI loads only the requested direct-navigation descriptor and runs the
   global pre-action hook.
2. The hook resolves one project context, obtains five repository identity
   facts in one Git process, checks worktree status in a second, and reuses that
   context for shared-index and watch-service coordination.
3. Opening the database reuses the active project context and the exact index
   generation published by a compatible live, idle watcher.
4. `code` resolves a direct range or fuzzy symbol and reads its source range.
   The renderer resolves the query again to print ambiguity information.
5. `outline` resolves an indexed path, loads its definitions, builds a symbol
   map, and applies enclosing-symbol or geometric containment.
6. `refs` resolves a symbol, requests semantic references when enabled,
   materializes file/line sites, and resolves the symbol again for presentation.

## Measurements

The machine-readable runs are linked from the
[baseline](./2026-07-15-navigation-latency-baseline.md). The current decision
numbers are:

| State                        |         `code` |      `outline` |                  `refs` | Interpretation                                                              |
| ---------------------------- | -------------: | -------------: | ----------------------: | --------------------------------------------------------------------------- |
| Clean                        |     565-688 ms |         604 ms | 1,548-1,647 ms repeated | `refs` benchmark is semantic-local because the harness disables the service |
| Stable dirty                 | 1,068-1,197 ms | 1,068-1,098 ms |          2,149-2,305 ms | two project fingerprints dominate the extra cost                            |
| Clean, shared cache disabled |  499 ms median |  443 ms median |         1,387 ms median | shared-cache lifecycle costs about 120-190 ms even when clean               |
| Dirty, warmed direct CLI     |       1,420 ms |       1,260 ms |                1,280 ms | warm semantic reuse makes `refs` converge on the common startup floor       |

## Accepted optimization results

Three independent changes were kept:

1. Dirty worktrees now return from shared-generation publication before
   detecting languages or hashing project files.
2. A started or reused watch service owns repository-cache sweeping; the CLI
   retains the foreground sweep when service startup is skipped or fails.
3. Symbol resolution is cached for one read-only database object and exact
   query string, so query execution and presentation reuse one result.

The benchmark harness results are in
[`after dirty`](./runs/2026-07-15-navigation-latency-after-dirty.jsonl) and
[`after clean`](./runs/2026-07-15-navigation-latency-after-clean.jsonl). The
alternating warmed-service comparison and output hashes are in the
[`warm summary`](./runs/2026-07-15-navigation-latency-after-warm-summary.json).

| Stable dirty benchmark                     |   Before | After median | Change |
| ------------------------------------------ | -------: | -----------: | -----: |
| `code findFirstSymbolMatch`                | 1,197 ms |       853 ms |   -29% |
| `code` direct range                        | 1,068 ms |       872 ms |   -18% |
| `outline` small file                       | 1,068 ms |       900 ms |   -16% |
| `outline` large file                       | 1,098 ms |       898 ms |   -18% |
| `refs findFirstSymbolMatch`, cold semantic | 2,149 ms |     1,905 ms |   -11% |
| `refs ScipDatabase`, cold semantic         | 2,305 ms |     2,135 ms |    -7% |

The normal warmed-service comparison isolates the user-facing path where the
CLI can delegate maintenance and semantic work to the daemon:

| Checkout     | Command                     | Before median | After median | Change |
| ------------ | --------------------------- | ------------: | -----------: | -----: |
| Clean        | `code findFirstSymbolMatch` |        612 ms |       519 ms |   -15% |
| Clean        | `outline` large file        |        557 ms |       463 ms |   -17% |
| Clean        | `refs findFirstSymbolMatch` |        620 ms |       541 ms |   -13% |
| Stable dirty | `code findFirstSymbolMatch` |      1,230 ms |       789 ms |   -36% |
| Stable dirty | `outline` large file        |      1,184 ms |       772 ms |   -35% |
| Stable dirty | `refs findFirstSymbolMatch` |      1,267 ms |       828 ms |   -35% |

All six representative stdout/stderr comparisons were byte-identical between
the installed pre-change CLI and locally built post-change CLI. Exit codes,
stdout byte counts, and semantic-reference rows were also identical.

The second pass then reused one Git/project context throughout an invocation,
trusted an exact watcher-issued generation only while the compatible watcher
was live, idle, and error-free, and loaded one direct descriptor instead of the
full command catalog. Its controlled dirty-worktree medians were 271 ms for
`code`, 256 ms for `outline`, and 300 ms for `refs`.

The third pass tested two bundle-boundary candidates and rejected both after
they failed their declared runtime thresholds. A process trace then found six
synchronous Git launches per real command. Combining the five `rev-parse`
lookups reduced the normal path to two launches. A fifteen-run alternating A/B
comparison in the same build measured:

| Command                                     | Batched Git | Legacy Git | Median saved | Paired median saved |
| ------------------------------------------- | ----------: | ---------: | -----------: | ------------------: |
| `code findFirstSymbolMatch`                 |      243 ms |     281 ms |        38 ms |               28 ms |
| `outline src/symbols/definition-catalog.ts` |      287 ms |     414 ms |       127 ms |              107 ms |
| `refs findFirstSymbolMatch`                 |      279 ms |     339 ms |        60 ms |               67 ms |

All three output hashes remained identical. The machine-readable Phase 3
baseline, rejected candidates, accepted result, process counts, and controlled
A/B summary are in
[`Phase 3 runs`](./runs/2026-07-15-navigation-latency-phase-3.jsonl).

## Bottleneck candidates, ranked

### 1. Repeated project fingerprinting on dirty worktrees

A project-input fingerprint is the ordered record of project file paths, sizes,
and content hashes used to decide whether an index still describes the current
source tree. It is a freshness proof whose essential cost is reading and hashing
every included file.

`prepareWorktreeIndex` first gets freshness, which builds the fingerprint. When
fresh, it calls `publishFreshLocalGenerationForProject`, which builds the same
fingerprint before discovering that the worktree is dirty and cannot be shared.
This is the largest verified avoidable cost.

Candidate change: return or pass the already-computed fingerprint and resolved
Git context through the preparation pipeline. Check `context.clean` before any
publication-only hashing. Preserve one freshness proof whenever the watcher
cannot provide a verified current-generation token.

### 2. Repeated Git context resolution

A Git worktree context is the command-local record of repository identity, HEAD,
tree identity, common Git directory, and cleanliness. Its defining function is
to bind cache ownership and validity to the exact checkout being queried.

The current CLI reconstructs it independently for the lease, cache sweep,
shared evidence path, and watch-service identity. Candidate change: resolve it
once per command and pass it as immutable command context. Do not add a global
long-lived cache because watch processes must observe later Git changes.

The watch server already sweeps the repository cache every 60 seconds. Skip the
CLI sweep when a compatible watcher is live; retain a throttled fallback when it
is not.

### 3. Duplicate symbol resolution

Symbol resolution is the selection of the indexed definition that best matches
a user query, including exact, file-line, path-qualified, and fuzzy candidates.
Its causal purpose is to turn ambiguous human input into one compiler identity.

`code` and `refs` perform it for the result and again for notices/JSON. Candidate
change: carry one `SymbolResolution` through query and rendering, or add a cache
whose lifetime is one database/command. Verify ambiguous queries as well as
unique ones.

### 4. Semantic reference materialization

Semantic reference materialization is producing an exact file/position set from
the live TypeScript program and binding it to a published index generation. It
supplies occurrences that the current SCIP documents omit.

Candidate changes, in order:

1. Add a watch-cold/watch-warm benchmark mode; the present harness forces local
   fallback and overstates warmed user latency.
2. Cache successful reference responses in the semantic service by generation
   and definition identity.
3. Avoid the separate availability round trip before a references request; let
   the request succeed or trigger the existing direct-provider fallback.
4. Evaluate storing semantic-only reference deltas during incremental indexing.
   Query-time SCIP rows plus the delta were 1.5-23.6 ms on the probe corpus and
   can preserve the semantic result if invalidated with the generation.

### 5. Persistent navigation queries

A persistent query service is a process that keeps the validated database,
parsed index data, and semantic sessions alive across command invocations. Its
essential advantage is eliminating repeated process-local setup while retaining
the same query functions.

Alternative design: extend the existing watch-service mailbox with read-only
navigation requests, and make eligible CLI commands thin clients with a direct
fallback. This is the only track likely to push all three commands below 150 ms,
but it has a larger protocol and correctness surface than the first three fixes.

## Remaining implementation order

1. Make clean/dirty and watch-cold/watch-warm scenarios first-class benchmark
   harness options; the campaign currently records them as separate runs.
2. Investigate whether a watcher-issued exact generation can safely avoid the
   remaining dirty-status Git process without weakening cache ownership.
3. Benchmark and implement generation-keyed semantic reference caching.
4. Decide from the new floor whether the persistent navigation mailbox is worth
   its protocol complexity.

Each step is independently revertible and must record before/after timing plus
output identity in the run history.

## Decision log

- Accepted diagnosis: startup and freshness work dominate `code` and `outline`;
  their query algorithms are not the first target.
- Accepted diagnosis: dirty worktrees pay for the same full fingerprint twice.
- Accepted diagnosis: Git worktree state is reconstructed at several command
  boundaries instead of once.
- Accepted diagnosis: presentation causes a second symbol resolution.
- Rejected: optimize `outline`'s quadratic fallback first; measured large-file
  latency was identical to the small-file case.
- Rejected: make `refs` SCIP-only; the probe lost one reference for two of four
  representative symbols.
- Accepted: early dirty-publication rejection, watcher-owned routine sweeping,
  and per-database symbol-resolution reuse. Outputs remained identical.
- Accepted: invocation-scoped Git/project reuse, exact watcher-generation
  trust, and one-descriptor direct loading. Outputs remained identical.
- Rejected: relocating command policy solely to split the runtime bundle; the
  52% static-byte reduction did not meet the help or two-command thresholds.
- Rejected: dynamically importing profile-only evidence code; the ordinary
  static graph grew and opposing timing movements had no causal profile path.
- Accepted: batch five repository metadata facts into one `rev-parse` call,
  reducing the normal direct path from six Git processes to two. All three
  controlled command comparisons cleared the 25 ms threshold.
- Deferred: persistent navigation service, pending the lower-risk fixes and a
  benchmark mode that measures its true warm path.

## Verification record

- Focused navigation, symbol-resolution, shared-generation, and watch-service
  suites passed.
- Full suite passed: 197 test files and 1,394 tests.
- Typecheck, build, lint, format, and skill-link checks passed.
- `unused-params`, `recent-duplicates`, and `wrapper-candidates` returned no
  findings.
- `incomplete-migration` found no partial migration, `cleanup-plan --verify`
  found no deletion batches, the changed Git-context file had no co-change
  findings, and the benchmark ledger had no doc-drift finding.
- `scip-query reindex` reused the fresh, unchanged TypeScript/Rust index in 0.4
  seconds.
- `scip-query diff-gate --json --full` passed with zero blocking or advisory
  findings across 42 changed symbols and all eight applicable checks.
