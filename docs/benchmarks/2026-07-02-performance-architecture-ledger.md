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

## Rejected Changes

| Candidate | Result | Reason |
| --- | --- | --- |
| File-dependency graph prefill before health phases | Rejected | Vega evidence-cold health regressed to 37.603s sequential and 44.498s parallel; profile showed prefill serialized graph work without improving the target. |
| Lowering health concurrency to 4 | Rejected | Vega evidence-cold probe stayed slow at 31.864s with unchanged output hash. |
| Running all health phases in one hidden process | Rejected | Vega all-phase probe took 51.301s and changed the command surface, so it was not a safe optimization. |
| Removing `sourceImportFingerprint` from the file-dependency graph storage key only | Accepted as cleanup, not sufficient as health fix | Vega evidence-cold health still took 32.051s before the health sidecar. |
| Per-file TypeScript indexing in Plan 6 | BLOCKED | Cold `reindex` is dominated by the upstream `scip-typescript` shard. Vega cold reindex is 35.285s and Stable cold reindex is 21.692s, while no-edit shard reuse is 418ms and 284ms respectively. |
| Analysis-budget retirement | Deferred | Health output already runs full by default. Stable `complexity-hotspots --json` still exceeds the 4s warm detector target, so cap removal/retuning is not safe in this slice. |

## Scoreboard

| Repo / Workload | Seed Before | Current Observed | Target | Status |
| --- | ---: | ---: | ---: | --- |
| `Vega_2.0` `health --json` warm hit | 5.298s | 0.192s | <= 8.0s | PASS |
| `Vega_2.0` `health --json` evidence-cold hit | 29.187s | 0.200s | <= 14.0s | PASS |
| `Vega_2.0` final built `health --json` warm hit | 5.298s | 0.218s | <= 8.0s | PASS |
| `Vega_2.0` cold `reindex` | 29.8s | 35.285s | <= 22.0s | MISS, BLOCKED upstream shard |
| `Vega_2.0` shard-reuse `reindex` | 0.4s-0.8s | 0.418s | <= 1.0s | PASS |
| `Vega_2.0` retro-gate replay | ~36s/commit | 62.400s median over five commits | <= 12.0s median or BLOCKED | MISS, BLOCKED by cold index floor |
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

## Retro-Gate Replay

Harness mode: `node scripts/performance-architecture-contract.mjs --repo
/Users/aydansalois/Documents/GitHub/Vega_2.0 --cache-state retro-gate --command
"diff-gate --json" --retro-count 5 --label
after-health-sidecar-vega-retro-gate-5`.

The replay uses detached temporary worktrees, disables hooks only for
`git worktree add/remove` with `core.hooksPath=/dev/null`, runs `reindex`, then
runs `diff-gate --json --base <commit>^`.

| Commit | Total | Index | Gate | Exit |
| --- | ---: | ---: | ---: | ---: |
| `8768190888ea` | 62.400s | 30.407s | 31.993s | 1 |
| `f7ba503c9d54` | 59.895s | 34.215s | 25.680s | 0 |
| `85f9adeab4b5` | 60.445s | 34.328s | 26.117s | 0 |
| `a2f778a78ebd` | 80.374s | 34.007s | 46.367s | 1 |
| `77f73600d094` | 74.566s | 34.517s | 40.048s | 1 |

Median total is 62.400s. Because the cold index phase alone is 30.407s-34.517s,
the 12s/commit target is impossible without cross-checkout shard reuse or an
upstream TypeScript indexing change, even if the gate phase were free.

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

## Handoff Probes

| Area | Probe | Observed Result |
| --- | --- | --- |
| Harness/report changes | `npm test -- tests/scripts/performance-architecture-contract.test.ts` | 6 tests passed. |
| Manifest/invalidation | `npm test -- tests/storage/evidence-cache.test.ts tests/storage/evidence-products.test.ts tests/symbols/file-dep-graph.test.ts` | Passed in focused runs during this slice. |
| Evidence product profile metadata | Profiled health/product reads and added wrapper assertions. | `evidence-product.file.read` reports hit/miss metadata. |
| Health sidecar | Seed then hit health on Vega, Stable, and scip-query. | Output hashes stayed identical; hits were 168ms-200ms. |
| Reindex | Cold and warm-index harness rows on all three repos. | scip-query passes cold target; Vega and Stable miss cold target but pass shard reuse. |
| Retro-gate | Five detached Vega worktrees. | Median 62.400s; cold index floor proves target BLOCKED in this plan. |

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
