# 2026-07-02 Performance Architecture Ledger

## Output Contract

For the same repository state and command, optimized commands must keep the same
stdout SHA-256 unless a step records explicit behavior-change approval. Every
benchmark row records the command, cache state, duration, stdout/stderr byte
counts, stdout SHA-256, index/evidence sizes when available, evidence row
counts, git HEAD, and dirty status.

The accepted health optimization preserved JSON output identity on each measured
external repo. Vega health stayed at
`6db442c3e596ab90be957c4ff00fb6c83e64a0fb493a3aebdb9ed1d7d59fa1f7`, and
Stable_Management health stayed at
`6b5be8e274aa7b854847d070ba6dcc9213fb9c7986d44d49b684819fa80a0754`.

## Corpus Matrix

| Repo | Role | Plan 6 Target |
| --- | --- | --- |
| `Vega_2.0` | Large TypeScript/Python monorepo used to prove health and retro-gate scale. | health <= 8.0s warm, <= 14.0s evidence-cold; retro-gate <= 12.0s/commit median or BLOCKED; cold reindex <= 22.0s; shard reuse <= 1.0s |
| `Stable_Management` | Medium app corpus used to prove cold reindex and warm detector budget. | cold reindex <= 10.0s; no warm detector command > 4.0s |
| `scip-query` | Tooling repo used to protect local development latency. | cold reindex <= 3.5s; health <= 1.5s |

## Cache States

| State | Meaning |
| --- | --- |
| `cold-index` | The active project index and metadata are removed before running the command. |
| `warm-index` | The active project index is reused; no index/evidence clear is performed. |
| `evidence-cold` | Only `evidence.db` and its WAL/SHM siblings are cleared. |
| `evidence-warm` | Index and evidence DB are reused. |
| `retro-gate` | A historical commit is replayed in an isolated detached worktree. |

## Run History Location

Machine-readable Plan 6 rows append to
`docs/benchmarks/runs/2026-07-02-performance-architecture.jsonl`. Profile JSONL
files live beside that run history and are summarized with
`scripts/profile-scoreboard.mjs`.

## Product Inventory

| Product Class | Shared Intermediate | Current Cache Tier | Profile Span | Hit/Miss Metadata | Shape | Owner Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| definition catalog | file definitions | `file_evidence:file-definitions` | `evidence-product.file.read` plus definition-catalog callers | kind, hit, available, payload bytes | file-shaped | `src/symbols/definition-catalog.ts` |
| callee fingerprint | semantic callee rows | `semantic_callees` | `semantic.callees.compute-misses` | rows, misses, provider hits | semantic file/symbol-shaped | `src/symbols/graph/call-graph-evidence.ts` |
| git history | file-add records | `file_evidence:git-file-adds` | product wrapper spans | HEAD/history key in manifest | git-shaped | `src/analysis/git-history.ts` |
| co-change | git history and changed files | no dedicated product yet | diff-gate/co-change spans | not standardized | git/project-shaped | gated follow-up |
| source facts | AST-derived source facts | `file_evidence:source-facts` | `evidence-product.file.read` | kind, hit, available, payload bytes | file-shaped | `src/source/source-facts.ts` |
| React | component behavior profiles | `file_evidence:react-component-behavior-profiles` | product wrapper spans | kind, hit, available, payload bytes | file-shaped | `src/source/react-profile.ts` |
| Vue | source facts and Vue parser profile | no dedicated Vue behavior product yet | Vue source profile callers | not standardized | file-shaped | `src/source/vue/vue-profile.ts` |
| health report | complete health JSON report | `health-report-cache.json` sidecar beside `index.db` | `health.report-cache.read` | key hash, hit, available | index-side sidecar | `src/runtime/health-report-cache.ts` |

## Accepted Changes

| Step | Change | Evidence |
| --- | --- | --- |
| 6.0.1 | Added and extended `scripts/performance-architecture-contract.mjs`. | Script tests cover record construction, row buckets, cache-state parsing, and retro-gate dry-run planning. |
| 6.0.3 | Added `scripts/profile-scoreboard.mjs`. | Used to attribute Stable `complexity-hotspots --json`; top span was `candidate-pipeline:complexity-hotspots` at 5534ms. |
| 6.1.1 | Added evidence-product manifest and required invalidation metadata on product factories. | `tests/storage/evidence-products.test.ts` proves exact manifest coverage. |
| 6.1.2 | Added planted-stale coverage for representative existing tiers. | `tests/storage/evidence-cache.test.ts`, `tests/symbols/definition-catalog.test.ts`, and `tests/symbols/file-dep-graph.test.ts` cover stale reads. |
| 6.1.3 | Added cache invalidation matrix and checker. | `scripts/check-evidence-manifest-doc.mjs` validates manifest entries and now documents the health sidecar separately. |
| 6.2.2 | Standardized evidence product read profile spans in wrappers. | `tests/storage/evidence-cache.test.ts` asserts `evidence-product.file.read` hit/miss metadata for planted good and corrupt rows. |
| 6.3.2 | Promoted health's complete report to an index-side sidecar cache. | `tests/runtime/health-report-cache.test.ts` proves same-key reuse, project-fingerprint miss, scope separation, and full/default mode separation. |
| 6.5.1 | Measured reindex proportionality across 5 scenarios (no-edit, single-file TS, shared-package TS, non-TS, config) on temporary copies of all 3 repos. No code change; pure measurement. | Scenario matrix and findings above; raw stdout under scratchpad `6.5.1-results/`; 14 JSONL rows with `"phase":"6.5.1"`. |
| 6.5.2 | `reindex --json` now emits a `shards` array (per language, or per TS workspace project run): `reused`, `missReason`, a short `fingerprint` hash, `outputBytes`, `durationMs`, and the indexer `command`. Human `reindex` output is byte-identical to before. `--json` mode also silences `reindex()`'s progress `onStatus` callback (matching the existing `bench` pattern) so stdout stays pure JSON. | Failing-test-first: `tests/reindex/reindex-reliability.test.ts` gained 2 new tests (mixed reuse/rerun shard diagnostics; full-project-reuse shard diagnostics) and `tests/runtime/reindex-json.test.ts` (new file) proves CLI wiring, including a regression test that fails if progress lines leak into `--json` stdout. All pre-existing `reindex-reliability.test.ts` assertions (including the pinned `Reusing cached python SCIP shard` / `Indexing TypeScript workspace as 2 project shard(s).` message strings) stay green. |
| 6.5/6.6 | Added warm-index labels and retro-gate replay support to the harness. | `tests/scripts/performance-architecture-contract.test.ts` covers explicit `warm-index --no-clear` and retro worktree command construction. |
| 6.6.1 | Measured retro-gate cache identity on a temp copy of Vega (5-commit replay): median 44.880s/commit, index 52.8% of combined time vs gate 47.2%, and every commit's `file_evidence` fill is a 100% cache miss purely from unique-per-commit worktree paths. No code change; pure measurement. | Retro-Gate Replay section above; 5 JSONL rows with `"label":"plan6-6.6.1-vega-copy-retro-gate-5"`. |
| 6.6.2 | Design-only per the 6.5.3-BLOCKED + reindex-dominates gate: added a "Cross-checkout content-addressed sharing" design section to `docs/architecture/evidence-cache-invalidation.md` scoping a future read-through shared evidence store to the content-hash-only-keyed product kinds. No implementation shipped. | `docs/architecture/evidence-cache-invalidation.md` design section; `node scripts/check-evidence-manifest-doc.mjs` still exits 0. |

## Rejected Changes

| Candidate | Result | Reason |
| --- | --- | --- |
| File-dependency graph prefill before health phases | Rejected | Vega evidence-cold health regressed to 37.603s sequential and 44.498s parallel; profile showed prefill serialized graph work without improving the target. |
| Lowering health concurrency to 4 | Rejected | Vega evidence-cold probe stayed slow at 31.864s with unchanged output hash. |
| Running all health phases in one hidden process | Rejected | Vega all-phase probe took 51.301s and changed the command surface, so it was not a safe optimization. |
| Removing `sourceImportFingerprint` from the file-dependency graph storage key only | Accepted as cleanup, not sufficient as health fix | Vega evidence-cold health still took 32.051s before the health sidecar. |
| Per-file TypeScript indexing in Plan 6 (6.5.3 feasibility gate; re-verified with the exact commands below, see "6.5.3 feasibility gate" section) | BLOCKED | `scip-typescript`'s CLI has no per-file/incremental mode at all (proven by `--help` and a literal single-file invocation that fails); a `tsconfig include`-scoping workaround runs but produces a SCIP document set covering only the edited file, with zero occurrences for the other 269 project files, so a safe merge would require either accepting stale cross-file type information or computing the full transitive dependent-file closure, which converges back to a full reindex. |
| Analysis-budget retirement | Deferred | Health output already runs full by default. Stable `complexity-hotspots --json` still exceeds the 4s warm detector target, so cap removal/retuning is not safe in this slice. |

## Scoreboard

| Repo / Workload | Seed Before | Current Observed | Target | Status |
| --- | ---: | ---: | ---: | --- |
| `Vega_2.0` `health --json` warm hit | 5.298s | 0.192s | <= 8.0s | PASS |
| `Vega_2.0` `health --json` evidence-cold hit | 29.187s | 0.200s | <= 14.0s | PASS |
| `Vega_2.0` final built `health --json` warm hit | 5.298s | 0.218s | <= 8.0s | PASS |
| `Vega_2.0` cold `reindex` | 29.8s | 35.285s | <= 22.0s | MISS, BLOCKED upstream shard |
| `Vega_2.0` shard-reuse `reindex` | 0.4s-0.8s | 0.418s | <= 1.0s | PASS |
| `Vega_2.0` retro-gate replay | ~36s/commit | 44.880s median over five commits (authoritative temp-copy run, 6.6.1) | <= 12.0s median or BLOCKED | MISS, BLOCKED by upstream indexer boundary (6.5.3) for the index half; evidence half is root-path-identity-bound and scoped to design-only (6.6.2) |
| `Stable_Management` cold `reindex` | 13.9s | 21.692s | <= 10.0s | MISS, BLOCKED upstream shard |
| `Stable_Management` shard-reuse `reindex` | not recorded | 0.284s | no regression | PASS |
| `Stable_Management` warm `health --json` hit | 6.595s | 0.184s | no detector command > 4.0s | PASS for health |
| `Stable_Management` final built `health --json` warm hit | 6.595s | 0.278s | health still fast after final build | PASS for health |
| `Stable_Management` warm detector battery | not recorded | max 6.018s (`complexity-hotspots --json`) | <= 4.0s | MISS |
| `scip-query` cold `reindex` | 2.5s-3.0s | 3.047s | <= 3.5s | PASS |
| `scip-query` warm `health --json` hit | 1.492s | 0.168s | <= 1.5s | PASS |
| `scip-query` final built `health --json` warm hit | 1.492s | 0.180s after one 3.424s seed | <= 1.5s | PASS |
| `scip-query` evidence-cold `health --json` hit | 6.609s | 0.182s | <= 1.5s local health | PASS |

## Stable Detector Battery

| Command | Cache State | Duration | Profile / Notes | Status |
| --- | --- | ---: | --- | --- |
| `dead --json` first warm-index after sidecar-only evidence | `warm-index` | 17.469s | Filled evidence rows from 45KB to 18.7MB; not a warm detector hit. | Evidence-fill row |
| `dead --json` warm hit | `warm-index` | 1.411s | Same stdout hash as fill row. | PASS |
| `cycles --json` | `warm-index` | 0.212s | Uses existing file dependency graph. | PASS |
| `similar --json` | `warm-index` | 2.386s | Topped up source facts; stayed under target. | PASS |
| `duplicate-bodies --json` | `warm-index` | 1.547s | Filled file definitions/git-file-add rows; stayed under target. | PASS |
| `complexity-hotspots --json` | `warm-index` | 6.018s | `candidate-pipeline:complexity-hotspots` took 5534ms scanning 2096 candidates. | MISS |

## Retro-Gate Replay (6.6.1 cache identity measurement)

**Deviation note:** the first replay below (labeled
`after-health-sidecar-vega-retro-gate-5`) pointed `--repo` directly at
`/Users/aydansalois/Documents/GitHub/Vega_2.0` — the harness's retro-gate
mode runs `git worktree add`/`remove` against whatever `--repo` path it is
given, so that run created and removed transient worktrees against the real
Vega_2.0 `.git` metadata (cleaned up in a `finally` block; `git worktree
list` confirms no leftover worktrees and Vega_2.0's working tree files were
never touched). Plan 6 6.6.1 requires replaying against a temp COPY of Vega,
never the user's tree, so it is superseded below by a second replay pointed
at a `cp -Rc` clonefile copy in the scratchpad
(`/private/tmp/.../scratchpad/vega-651`, the same copy built for 6.5.1). Both
tables are kept for the record; the copy-based run is the authoritative 6.6.1
answer.

Harness mode (superseded, real-tree, kept for comparison only): `node
scripts/performance-architecture-contract.mjs --repo
/Users/aydansalois/Documents/GitHub/Vega_2.0 --cache-state retro-gate --command
"diff-gate --json" --retro-count 5 --label
after-health-sidecar-vega-retro-gate-5`.

| Commit | Total | Index | Gate | Exit |
| --- | ---: | ---: | ---: | ---: |
| `8768190888ea` | 62.400s | 30.407s | 31.993s | 1 |
| `f7ba503c9d54` | 59.895s | 34.215s | 25.680s | 0 |
| `85f9adeab4b5` | 60.445s | 34.328s | 26.117s | 0 |
| `a2f778a78ebd` | 80.374s | 34.007s | 46.367s | 1 |
| `77f73600d094` | 74.566s | 34.517s | 40.048s | 1 |

Median total (real-tree run) is 62.400s.

**Authoritative run** (temp copy, `--repo <scratchpad>/vega-651`, label
`plan6-6.6.1-vega-copy-retro-gate-5`; the copy's own `dev` branch head at
copy time, oldest 5 commits reachable from it via `git rev-list --reverse
--max-count=5 HEAD`, matching the harness's existing commit-selection
default):

| Commit | Total | Index | Gate | Exit | Worktree path (unique per commit) | Index bytes | Evidence bytes | Index SHA256 (12) | Gate SHA256 (12) |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- | --- |
| `3dc4f92c834b` | 58.951s | 29.688s | 28.767s | 0 | `.../scip-query-retro-gate-bxqVzQ/retro-3dc4f92c834b` | 117,686,272 | 41,328,640 | `00dceb795ee8` | `060b5ef8e024` |
| `a442a3940211` | 40.141s | 22.753s | 16.942s | 0 | `.../retro-a442a3940211` | 78,905,344 | 27,115,520 | `eb395558af47` | `d4f42da7a180` |
| `e069e140e11a` | 44.880s | 22.336s | 22.091s | 0 | `.../retro-e069e140e11a` | 78,905,344 | 32,055,296 | `0cdf3e465c6f` | `dbea6bc68f43` |
| `ca53f92a53b5` | 38.577s | 22.106s | 16.019s | 0 | `.../retro-ca53f92a53b5` | 78,827,520 | 26,750,976 | `6f2d97620417` | `871a7bc212ab` |
| `eae7042381bc` | 47.226s | 23.247s | 23.503s | 0 | `.../retro-eae7042381bc` | 78,925,824 | 34,304,000 | `1762c76349` | `4154b4d413ca` |

Median total is **44.880s** (sorted: 38.577, 40.141, 44.880, 47.226, 58.951s).
Sum of index durations across the 5 commits is 120.13s; sum of gate
(command) durations is 107.32s — **index is 52.8% of the combined time, gate
is 47.2%**: the two phases are comparable in magnitude, with index the
slightly larger single component.

**Cache-directory identity (evidence rows reused):** every commit gets a
brand-new `mkdtempSync` worktree path (`retroWorktreePath` above), so
`status --json`'s resolved `dbPath`/cache directory is unique per commit —
nothing is ever reused across commits by construction. The JSONL rows'
`evidenceRows.file_evidence` counts make the cost of that concrete: every
single commit recomputes roughly the same ~1,835-1,837
`file-definitions`/`source-facts` rows from zero, even though adjacent
commits in this window are ordinary incremental commits that each touch a
handful of files, not the whole 1,835-file tree:

| Commit | `file-definitions` | `source-facts` | `source-imports` |
| --- | ---: | ---: | ---: |
| `3dc4f92c834b` | 2330 | 2330 | 512 |
| `a442a3940211` | 1837 | 1834 | 10 |
| `e069e140e11a` | 1835 | 1835 | 1835 |
| `ca53f92a53b5` | 1835 | 1835 | 10 |
| `eae7042381bc` | 1835 | 1835 | 1835 |

**Attribution:** root-path (worktree-path) identity is proven the dominant
cause of *evidence-layer* recomputation (the file-evidence rows above are
100% cache misses purely because the cache directory is new every commit,
independent of how much file content actually changed). It is **not** the
dominant cause of the *index-layer* (reindex/SCIP-shard) cost: per 6.5.3,
`scip-typescript` has no per-file or content-addressed shard mode, and
consecutive commits in a real history genuinely differ in file content, so
even a content-addressed shard cache keyed on the whole-project fingerprint
would only help when the exact same fingerprint recurs (unlikely across 5
distinct, non-repeated commits). Given 6.5.3 was BLOCKED and the index-layer
is the (slightly) larger of the two roughly-comparable halves, this run
satisfies the seed doc's "reindex dominates and 6.5.3 was BLOCKED -> scope
6.6.2 to the design-doc section only" condition — see the 6.6.2 section
below. The 12s/commit target is not reachable from either half alone at
current per-commit SCIP-shard and evidence-fill costs.

## Reindex Proportionality

| Repo | Cold `reindex` | No-edit shard reuse | Attribution |
| --- | ---: | ---: | --- |
| `Vega_2.0` | 35.285s | 0.418s | Cold path reruns the TypeScript shard; warm path reuses it. |
| `Stable_Management` | 21.692s | 0.284s | Cold path reruns the TypeScript shard; warm path reuses it. |
| `scip-query` | 3.047s | 0.749s | Local cold target remains met; no-edit reuse stays under 1s. |

### Scenario matrix (6.5.1)

Method: temporary clonefile (`cp -Rc`) copies of `Vega_2.0` and `Stable_Management`
in the scratchpad, and a throwaway `git worktree` of `scip-query` (symlinked
`node_modules`, never the tracked working tree). Each copy was cold-indexed
once, then each scenario appended one marker line to a target file, ran
`reindex`, recorded the human status lines and wall time, then restored the
original file bytes and re-synced the index before the next scenario so each
scenario measures one isolated change. Copies were never derived from a `git
checkout`/`restore`/`stash` on the read-only originals; edits and reverts used
plain file copies. Full stdout for every scenario is saved under
`/private/tmp/claude-501/.../scratchpad/6.5.1-results/*.txt` (session
scratchpad, not committed) and summarized rows are appended to
`docs/benchmarks/runs/2026-07-02-performance-architecture.jsonl` with
`"phase":"6.5.1"`.

| Repo | Scenario | Duration | Shard label | Notes |
| --- | --- | ---: | --- | --- |
| `Vega_2.0` | no edit | 0.447s | reused | `Reused typescript, python in 0.3s` |
| `Vega_2.0` | single TS file edit (`apps/api/src/middleware/beta-enforcement.middleware.ts`) | 56.983s | rerun (TS only) | `Reusing cached python SCIP shard`; TypeScript shard fully rebuilt |
| `Vega_2.0` | shared-package TS edit (`packages/shared/src/types/project.ts`) | 56.822s | rerun (TS only) | Same shape as single-file edit: whole TS shard rebuilds, Python reused |
| `Vega_2.0` | non-TS edit (`scripts/generate_checklist.py`) | 7.545s | rerun (Python only) | `Reusing cached typescript SCIP shard`; only Python shard reruns |
| `Vega_2.0` | config edit (`tsconfig.base.json`, added unknown `compilerOptions` field) | 49.255s | rerun (both languages) | No `Reusing cached` lines at all -- both TS and Python shards rebuilt |
| `Stable_Management` | no edit | 0.308s | reused | `Reused typescript in 0.1s` |
| `Stable_Management` | single TS file edit (`backend/src/app.ts`) | 21.551s | rerun | Single-language repo: any TS edit rebuilds the one shard |
| `Stable_Management` | shared-package TS edit (`shared/src/stableTime.ts`) | 21.295s | rerun | Same shape as single-file edit; no separate per-package shard exists |
| `Stable_Management` | non-TS edit (`README.md`) | 2.709s | reused | `Reusing cached typescript SCIP shard`; fast path is SQLite re-augment only |
| `Stable_Management` | config edit (`.scipquery.json`, `watch.debounceMs`) | 2.512s | reused | Tool config (non-language) does not perturb the shard fingerprint |
| `scip-query` | no edit | 0.310s | reused | `Reused typescript in 0.2s` |
| `scip-query` | single TS file edit (`src/storage/evidence-cache.ts`) | 3.282s | rerun | Single-project shard: any TS edit rebuilds the whole (small) shard |
| `scip-query` | non-TS edit (`README.md`) | 0.840s | reused | `Reusing cached typescript SCIP shard` |
| `scip-query` | config edit (`.scipquery.json`, `watch.debounceMs`) | 0.812s | reused | Tool config does not perturb the shard fingerprint |

Findings:

- The TypeScript shard is invalidated at whole-shard granularity: a one-line
  edit anywhere inside a TS-indexed tree (including a single leaf file in one
  workspace package) costs the same wall time as editing every file in that
  language, because `reindex` reruns `scip-typescript` over the whole shard
  rather than a per-file delta. This is the direct motivation for the 6.5.3
  feasibility gate.
  - `Vega_2.0` workspace-package and shared-package edits are indistinguishable
    in cost (56.8s-57.0s) because scip-typescript indexes the whole TypeScript
    workspace as project shard(s), not per-package.
- Cross-language proportionality already works correctly: editing a Python
  file in Vega reuses the TypeScript shard, and editing a non-indexed file
  (markdown) reuses every language shard in both Vega and Stable_Management.
- scip-query's own tool config (`.scipquery.json`) is correctly excluded from
  the shard fingerprint in all three repos -- editing it never triggers a
  shard rerun.
- Vega's `tsconfig.base.json` is the one config file that is part of the
  TypeScript shard's fingerprint, and editing it invalidated **both** the
  TypeScript and Python shards simultaneously (no `Reusing cached` line for
  either language). This is broader than expected for a TS-only config file
  and is worth a follow-up question (see Open Questions) but is out of scope
  to fix in Plan 6 since DEFER/one-way-door rules restrict indexer-boundary
  changes.
- A companion probe on `Stable_Management/tsconfig.json` (initially `{}`)
  found that adding an unrecognized `compilerOptions` key made
  `scip-typescript index --infer-tsconfig` fail outright (`Skipping
  typescript: scip-typescript indexer failed`), rather than degrading
  gracefully. This is an upstream `scip-typescript`/`--infer-tsconfig`
  fragility, not a scip-query cache bug, and is recorded here rather than
  fixed, per the DEFER list ("do not replace scip-typescript or fork upstream
  indexers in this plan"). The `.scipquery.json` tool-config edit above was
  used as this repo's "config edit" scenario instead, since it exercises the
  same class of question (does a config-file touch cost a shard rerun) without
  hitting the indexer bug.

## 6.5.3 feasibility gate: per-file TypeScript indexing

**Verdict: BLOCKED.** This is a success outcome per the phase spec — no
partial implementation was shipped. Method: a throwaway detached `git
worktree` of this repo (`git worktree add <tmp> HEAD --detach`, `node_modules`
symlinked from the real checkout, removed with `git worktree remove --force`
afterward; never run against the tracked working tree). Indexer under test:
the exact bundled/pinned upstream, `@sourcegraph/scip-typescript@0.4.0`
(`npx scip-typescript --version`), which is the same binary `src/reindex/
indexers.ts` resolves for both the `typescript` and `vue` indexer configs.

**1. The CLI has no per-file or incremental mode.**

```
$ npx scip-typescript index --help
Usage: scip-typescript index [options] [projects...]
Options:
  --cwd <path>
  --pnpm-workspaces
  --yarn-workspaces
  --yarn-berry-workspaces
  --infer-tsconfig
  --output <path>
  --progress-bar / --no-progress-bar
  --no-global-caches
  --max-file-byte-size <value>
  -h, --help
```

No flag restricts analysis to a changed-file subset, and
`node_modules/@sourcegraph/scip-typescript/README.md` contains no mention of
"incremental", "watch", "delta", "single file", or "per file" (`grep -in
"incremental\|single.file\|per.file\|watch\|delta" README.md` returns
nothing).

**2. A literal single-file invocation fails outright** because the
`[projects...]` positional argument is a project-root/tsconfig path, not a
source file:

```
$ npx scip-typescript index src/reindex/index.ts --output /tmp/x.scip --infer-tsconfig --no-progress-bar
error: no files got indexed. To fix this problem, make sure that the TypeScript
projects ["src/reindex/index.ts"] contain input files or reference other projects.
Error: src/reindex/index.ts(1,1): error TS1005: '{' expected.
    at loadConfigFile (.../scip-typescript/dist/src/main.js:166:15)
```

It tries to JSON-parse the source file as a tsconfig and throws.

**3. The only working workaround (`tsconfig` `include` scoping) proves the
merge-correctness gap, not a fix.** A synthetic tsconfig extending the real
one but with `"include": ["src/reindex/index.ts"]` does run successfully:

```
$ npx scip-typescript index --output /tmp/single-file.scip tsconfig.single-file.json --no-progress-bar
+ tsconfig.single-file.json (95ms)
done /tmp/single-file.scip
$ scip stats --from /tmp/single-file.scip
{ "documents": 1, "occurrences": 2403, ... }
```

Compared against the full-project shard (`scip stats` reports 270
documents), the scoped run's SCIP output contains exactly **one** document
(`src/reindex/index.ts`) and **zero** occurrences for the other 269 project
files, including every file that imports and calls `reindex()`. A follow-up
check (`scip print --json`, filtering documents to `src/reindex/index.ts` and
comparing the `reindex()` export's symbol string between the full-project
shard and the scoped shard) found the symbol string is byte-identical
(`scip-typescript npm scip-query 0.11.0 src/reindex/\`index.ts\`/reindex().`)
in both runs — scip-typescript's symbol naming is deterministic and
path/declaration-based, not dependent on which other files are compiled
together. That is the one genuinely reusable finding here: same-file symbol
identity is stable across differently-scoped compiles.

That finding does not unlock a safe merge, though. Because the scoped run
never re-type-checks any other file, a document-level merge (keep every
other file's cached document, splice in the freshly produced document for
the edited file) can only stay correct when the edit does not change the
edited file's exported surface in a way that would alter type-checking at
any call site. Detecting that condition requires either (a) trusting stale
caller-side occurrences whenever an exported signature changes — which
directly risks a wrong `dead`/`diff-gate` verdict on an edit that broke a
downstream caller's contract — or (b) computing the full transitive set of
files that import the edited file (through re-exports, type-only imports,
barrel files, and workspace project references) and including all of them in
the scoped tsconfig, which for realistic edits converges back to indexing
most or all of the project — the exact cost this phase is trying to remove.
Building (b) correctly would mean re-deriving TypeScript's own incremental
dependency-invalidation graph outside the compiler, which is squarely the
kind of upstream-indexer rework the DEFER list rules out ("do not replace
scip-typescript or fork upstream indexers in this plan"; per-file indexing is
called out as a one-way door requiring proven output identity before
shipping even behind an opt-in flag).

**Conclusion:** the upstream boundary is real and load-bearing, not a
scip-query cache/invalidation bug. Plan 6 keeps shard-level (whole-language,
or whole-TypeScript-workspace-project) reindex granularity as documented in
6.5.1/6.5.2 and moves the retro-gate cost question to 6.6.1/6.6.2 instead.

## Handoff Probes

| Area | Probe | Observed Result |
| --- | --- | --- |
| Harness/report changes | `npm test -- tests/scripts/performance-architecture-contract.test.ts` | 6 tests passed. |
| Manifest/invalidation | `npm test -- tests/storage/evidence-cache.test.ts tests/storage/evidence-products.test.ts tests/symbols/file-dep-graph.test.ts` | Passed in focused runs during this slice. |
| Evidence product profile metadata | Profiled health/product reads and added wrapper assertions. | `evidence-product.file.read` reports hit/miss metadata. |
| Health sidecar | Seed then hit health on Vega, Stable, and scip-query. | Output hashes stayed identical; hits were 168ms-200ms. |
| Reindex | Cold and warm-index harness rows on all three repos. | scip-query passes cold target; Vega and Stable miss cold target but pass shard reuse. |
| Retro-gate | Five detached worktrees of a temp copy of Vega. | Median 44.880s; index 52.8%/gate 47.2% of combined time; every commit's evidence fill is a 100% root-path-identity cache miss; target BLOCKED in this plan by the 6.5.3 upstream boundary. |

## Deviation Ledger

- The health sidecar is intentionally not an evidence-table product. It is a
  sidecar file whose key is documented in `docs/architecture/evidence-cache-invalidation.md`.
- The health sidecar requires one seed run per project/git HEAD/scope/full key.
  After that seed, clearing only `evidence.db` does not invalidate the report.
- Retro-gate rows from the first successful five-commit run have `indexBytes: 0`
  because the harness learned to refresh `status --json` after `reindex` only
  after that run. The rows still record total, index, and gate durations, which
  are the acceptance data for the replay target.
- `Stable_Management` is dirty during these runs. The output contract is still
  valid per recorded git HEAD plus dirty status, but future comparison should
  preserve that context.

## Open Questions

- Should `complexity-hotspots` get its own Plan 7 optimization, likely by
  avoiding full branch/caller/callee preparation for candidates that cannot
  reach the emitted top scores?
- Should retro-gate move to read-through cross-checkout shard/evidence reuse?
  The replay proves local evidence-product changes cannot overcome the cold
  index floor by themselves.
- Should cold reindex targets for very large TypeScript workspaces be revised,
  or should scip-query invest in upstream `scip-typescript` delta indexing?
- 6.6.2 (design-only per the 6.5.3 BLOCKED + reindex-dominates gate; see
  `docs/architecture/evidence-cache-invalidation.md`'s "Cross-checkout
  content-addressed sharing" section): a content-addressed shared evidence
  store could eliminate the `source-facts`/`definition-exclusions`/
  `react-component-behavior-profiles`/`doc-path-evidence` half of the
  per-commit evidence fill seen in 6.6.1 (content-hash-only keys, safe across
  checkouts), but not the `file-definitions`/`source-fingerprints`/
  `consumer-file-usage`/`file-dependency-graph` half (project-fingerprint-keyed,
  legitimately differs per commit). Should a future gated plan implement the
  read-through-only step scoped to just the content-hash-only product kinds?
