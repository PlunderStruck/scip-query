# Plan 6 - Performance as architecture

Status: FULL PLAN - ready to execute after Plan 5 closes.

This plan expands the seed from 2026-07-02 into a measurement-first program for
caching, reuse, invalidation, and monorepo scale. It is written as a contract
for another agent: every implementation step names the current anchor, the exact
change, the validation command, the testability design, and why the step is safe
in that order.

## Goal

Performance-as-architecture means treating runtime improvement as a shared
program structure: repeatable measurement, reusable derived products, explicit
validity keys, invalidation tests, and scheduler choices that many commands
inherit. It is the alternative to isolated speedups whose correctness and reuse
rules live only inside one command.

Done means this command sequence succeeds on the final state:

```bash
npm run typecheck
npm test
npm run build
npm run bench:performance-architecture -- --repo . --quick
scip-query reindex
scip-query diff-gate --json
```

Done also means the Plan 6 scoreboard records before and after values for
Vega_2.0, Stable_Management, and scip-query itself; every accepted optimization
has byte-identical or deliberately approved output; every new cache tier has a
staleness witness; and every missed benchmark target is written with a specific
remaining bottleneck.

## Essential Concepts

A SCIP index is the compiler-derived map of a repository's files, symbols,
definitions, references, imports, calls, and dependencies. It differs from text
search by using language tooling evidence, so performance work must preserve the
meaning those tools found rather than merely preserve matched strings.

A derived product is a computed result made from source files, index rows, git
history, or semantic provider calls, such as source facts, definition catalogs,
callee fingerprints, import-resolution maps, or health phase summaries. Its
important trait is that it can be recomputed from more authoritative inputs, so
it can be cached if the cache key captures every input that can change the
answer.

A cache is storage for a derived product that can be rebuilt from authoritative
inputs. It is valid only when a key proves the relevant source content, index
identity, config, tool version, and product rules have not changed.

A validity key is the recorded evidence used to decide whether a cached value
still corresponds to its authoritative inputs. A content hash is a validity key
made from file bytes; a project fingerprint is a validity key made from
repository-wide indexing inputs and indexed language identity.

Invalidation is the act of making old derived products unavailable when their
authoritative inputs may have changed. A staleness witness is a test or probe
that first proves a stale cached answer can be constructed, then proves the
implemented key or invalidation rule rejects it.

A monorepo is one repository containing multiple packages, languages, or
workspaces that are developed together. The performance challenge is that a
small edit can be local, while a shared package or config edit can correctly
change many consumers.

A workspace package is a package inside a monorepo that other packages import by
package name, such as `@scope/shared`, rather than by a relative path. The
important fact for caching is that package `exports`, `tsconfig` aliases, and
source-to-`dist` mappings can make a consumer depend on files outside its own
directory.

Output identity is evidence that an optimization did not change a command's
observable answer. For this plan it means exit status, stdout byte count,
stdout SHA-256, and any intentionally nondeterministic fields are either equal
or explicitly normalized before comparison.

A profile span is one named timed unit of work inside a command, such as cache
read, cache fill, source parse, semantic reference lookup, phase worker, or
SQLite query. It is useful only when it carries enough counts to explain the
time: files, symbols, rows, bytes, hits, misses, workers, or candidates.

A run history is an append-only JSONL record of benchmark and profile runs. It
matters because performance claims rot quickly unless the corpus, command,
cache state, output identity, and commit are stored together.

A one-way door is a design choice that becomes expensive to undo after users or
other code start relying on it. Cross-checkout shared caches and per-file
incremental indexing are one-way doors here because a wrong key can silently
serve stale compiler evidence across branches or worktrees.

## Current Evidence Anchors

Source: `scip-query status --capabilities` and `scip-query stats --json` from
this repo on 2026-07-02.

- scip-query index was stale at plan-writing time after recent work, with 268
  indexed files, 15,961 symbols, and a 10.8 MB index.
- `scip-query bench --json --timeout-ms 600000` on this repo reported the
  default bench commands between 181 ms and 273 ms.
- `/usr/bin/time -p scip-query health --json` on this repo reported 6.51 s wall,
  11.69 s user, 2.05 s sys, and 10,790 stdout bytes.

Source: status/stats probes from external repos on 2026-07-02.

- Vega_2.0 exists locally, but its index was stale. The current index reported
  1,834 files, 112,289 symbols, 77.3 MB, and `health --json` took 35.88 s wall,
  170.81 s user, 10.49 s sys, with 17,125 stdout bytes.
- Stable_Management exists locally and its index was fresh, but its working tree
  had unrelated user changes. The index reported 1,625 files, 109,411 symbols,
  64.0 MB, and `health --json` took 14.57 s wall, 30.22 s user, 3.50 s sys,
  with 14,877 stdout bytes.

Source: the original Plan 6 seed.

- Vega_2.0 seed baseline: 7,495 files, 186k symbols, reindex 29.8 s cold,
  0.4-0.8 s shard reuse, `health` 26.5 s, retro-gate about 36 s per commit,
  122 MB index.
- Stable_Management seed baseline: 2,284 files, reindex 13.9 s, detector
  battery cheap.
- scip-query seed baseline: reindex 2.5-3 s, health about 1.2 s.

The seed and live probes disagree because the external repos and local indexes
changed between benchmark sessions. Phase 0 must refresh the baselines before
any production code change. Do not use the live values above as after-values.

Source: `scip-query code 'src/storage/evidence-cache.ts:23-147' -C 0`.

- `evidence.db` is the persistent cache file.
- `FileEvidenceKind` currently lists 11 file products:
  `source-facts`, `file-definitions`, `definition-exclusions`,
  `doc-path-tokens`, `doc-path-evidence`, `source-imports`,
  `source-reexports`, `source-fingerprints`, `consumer-file-usage`,
  `react-component-behavior-profiles`, and `git-file-adds`.
- `ProjectEvidenceKind` currently lists `file-dependency-graph`.
- `fileContentHash()` memoizes per-file SHA-256 by `(db, path)`.
- `projectEvidenceFingerprint()` hashes complete reindex metadata and sorted
  indexed languages.

Source: `scip-query code connectionFor -C 60`.

- `file_evidence` is keyed by `(kind, relative_path)` and hit-checked by
  `content_hash` and `version`.
- `project_evidence` is keyed by `(kind, cache_key)` and hit-checked by
  `project_fingerprint` and `version`.
- `semantic_callees` is keyed by `(relative_path, symbol)` and hit-checked by
  `content_hash`, `deps_digest`, and `version`.
- `semantic_references` is keyed by `(relative_path, symbol)` and hit-checked by
  `project_fingerprint` and `version`.
- Storage uses WAL, `busy_timeout = 5000`, and `synchronous = NORMAL` because
  the cache is rebuildable.

Source: `scip-query code 'src/storage/evidence-products.ts:1-69' -C 0`.

- `createFileEvidenceProduct()` and `createProjectEvidenceProduct()` are typed
  facades above raw evidence reads/writes.
- Deserialization errors return `null`, preserving rebuild-on-miss behavior.

Source: `scip-query code reuseExistingIndexIfPossible -C 24`,
`scip-query code runFreshReindex -C 30`, and
`scip-query code computeLanguageFingerprints -C 20`.

- Reindex first tries whole-index reuse through `meta.json`.
- Fresh reindex can reuse unchanged per-language SCIP shards and writes reused
  language status.
- Per-language fingerprints include language-relevant project files, marker
  files, common index inputs, TypeScript project mode, TypeScript project list,
  pnpm workspace mode, and Clojure config path where relevant.

Source: `scip-query code resolveCacheDir -C 40`.

- Default cache directories are keyed by the absolute project root path:
  `~/.cache/scip-query/projects/<sha256(projectRoot).slice(0, 12)>`.
- This gives worktrees and clones separate cold caches even when their content
  is identical.

Source: `scip-query code 'src/reindex/project-files.ts:1-186' -C 0`.

- `fingerprintProjectFiles()` hashes git-listed or filesystem-listed project
  files after filtering artifacts.
- Per-language fingerprints include all common index inputs such as
  `package.json`, lockfiles, `tsconfig.json`, language build files, and source
  extensions for the language.

Source: `scip-query code 'src/resolution/import-path-resolver.ts:191-433'`.

- JavaScript/TypeScript bare imports first try tsconfig path aliases and then
  workspace package resolution.
- Workspace package resolution reads package names and `exports`, maps `dist/`
  targets to `src/`, and falls back to conventional `src/<subpath>` candidates.

Source: `scip-query code 'src/queries/health/health.ts:36-76'`,
`scip-query code runHealthAnalyses -C 28`, and
`scip-query code healthBudget -C 24`.

- `HEALTH_PHASES` includes overview, cleanup detectors, frontend detectors,
  extract/wrapper/passthrough/stale/drift/complexity/git/suppression phases.
- Library `health()` runs phases through `runHealthAnalyses()`.
- Large-index bounded mode still exists, but current visible health is full by
  default.

Source: `scip-query code handleHealth -C 18`,
`scip-query code 'src/runtime/cli-support.ts:1-260' -C 0`, and
`scip-query code runHealthPhaseTaskProcess -C 24`.

- The visible CLI `health` handler passes `full: true`.
- `runIsolatedHealthReport()` computes applicability and overview in the parent,
  skips irrelevant React/Vue phases, groups related phases, and runs phase tasks
  in isolated worker processes.

Source: `scip-query code 'src/instrumentation/profile.ts:1-85' -C 0`,
`scip-query code benchCommandMatrix -C 28`, and
`scip-query code runBenchCommand -C 28`.

- Profiling already writes JSONL events when `SCIP_QUERY_PROFILE` is enabled.
- `bench` records default and optional heavy command durations, exit status,
  stdout/stderr bytes, cold index, warm index, and profile events.

Source: local test inventory from `rg --files tests` plus direct reads because
test files are not indexed by the current SCIP index.

- `tests/storage/evidence-cache.test.ts` already covers typed product
  round-trips, content-hash mismatch misses, corrupt payload misses,
  semantic-callee hash/digest invalidation, semantic-reference project
  fingerprint invalidation, and evidence DB open failure.
- `tests/reindex/reindex-reliability.test.ts` covers partial failure
  fail-closed behavior, temporary conversion, per-language shard reuse, TypeScript
  workspace project shard indexing, refresh provenance, and lock safety.
- `tests/resolution/workspace-package-import-resolver.test.ts` covers
  workspace package `exports` and `dist` to `src` resolution.
- `tests/runtime/bench-restore.test.ts` covers cold-index benchmark cache
  restore markers.

## Pre-Registered Benchmarks

These targets are intentionally registered before implementation. Refresh the
current column in Phase 0; do not silently change a target to fit a result.

| Benchmark                                   |                         Current value to refresh in Phase 0 |                                                              Target |
| ------------------------------------------- | ----------------------------------------------------------: | ------------------------------------------------------------------: |
| Vega_2.0 `health --json` wall time          |                       seed 26.5 s; live stale probe 35.88 s |                <= 15 s first accepted pass, <= 8 s warm-cache final |
| Stable_Management `health --json` wall time |                                    live fresh probe 14.57 s |                                                              <= 8 s |
| scip-query `health --json` wall time        |                                     live stale probe 6.51 s |                      <= 4 s or explained by local dirty/stale state |
| Vega_2.0 cold reindex                       |                                                 seed 29.8 s |              <= 20 s or unchanged with proof that indexer dominates |
| Vega_2.0 no-op/shard-reuse reindex          |                                              seed 0.4-0.8 s |                                                            <= 1.0 s |
| Stable_Management reindex                   |           seed 13.9 s; live metadata 26.7 s from 2026-06-28 |                     <= 12 s or explained by workspace/indexer shape |
| Retro-gate commit walk                      |                                  seed about 36 s per commit | <= 12 s per commit, or a rejected shared-cache design with evidence |
| Persistent cache contract coverage          | 11 file kinds, 1 project kind, 2 semantic tables identified |                    100% have a documented key and staleness witness |
| Profile event cardinality                   |     partial; spans exist but not all products report counts |   every touched product/span records hits, misses, rows/bytes/files |
| Output identity for optimized commands      |                                 not yet captured for Plan 6 |               exit, bytes, SHA-256 equal for every accepted speedup |

## Working Agreement

Work directly on `main` unless the user asks for a branch.

Commit protocol: commit after each phase that leaves the tree green. Stage only
the explicit files touched by that phase. Do not use `git add -A`.

Gate protocol: after each phase, run the focused tests for that phase, then run
the matching scip-query postcheck. After the whole program, run:

```bash
npm run typecheck
npm test
npm run build
scip-query co-change docs/plans/2026-07-02-plan6-seed-performance-architecture.md --json --full
scip-query doc-drift --json --full
scip-query reindex
scip-query diff-gate --json
```

Regeneration duties: update `docs/benchmarks/2026-07-02-performance-architecture-baseline.md`,
`docs/benchmarks/2026-07-02-performance-architecture-ledger.md`,
`docs/benchmarks/2026-07-02-performance-architecture-scoreboard.md`, and
`docs/benchmarks/runs/2026-07-02-performance-architecture.jsonl` whenever a
benchmark or profile is run. If command docs or config contracts change, run the
repo's documented generation command for that surface.

Deviation protocol: if source contradicts an anchor, write a `BLOCKED` or
`DEVIATION` note into the ledger with the command that proved it, then continue
only with steps that do not depend on the contradicted anchor. Never improvise a
cache key silently.

Verifier protocol: before trusting any new gate, plant one failure that it must
catch, remove the planted failure by targeted deletion, and rerun the gate. A
green check that has never been seen fail is not accepted.

## Phase 0 - Baseline Harness And Evidence Integrity

Phase 0 is blocking. No production performance change may start until this
phase writes the refreshed baseline and proves the harness can fail.

### 0.1 - Add the campaign benchmark runner

- **File anchor with current behavior**: `src/runtime/commands/command-handlers.ts`
  already implements `bench`: `handleBench()` builds reports; `runBenchCommand()`
  records duration, exit, timeout, and byte counts; `benchProfileEnv()` enables
  JSONL profiling. Source: `scip-query plan-context handleBench --json --limit
20`, `scip-query code runBenchCommand -C 28`, and
  `scip-query code benchProfileEnv -C 16`.
- **Exact change**: Add `scripts/performance-architecture-campaign.mjs` and
  `bench:performance-architecture` in `package.json`. The runner must accept
  `--repo`, `--quick`, `--include-heavy`, `--profile`, `--cold-index`,
  `--cold-evidence`, `--single-edit-probe`, `--jsonl`, and `--timeout-ms`.
  It must append JSONL records with repo path, commit, dirty status, index
  freshness, command, phase, cache state, duration, exit status, stdout bytes,
  stderr bytes, stdout SHA-256, profile path, Node version, CLI version, and
  index stats. It may call existing `scip-query bench` internally, but the
  run-history JSONL is the source of truth.
- **Validation command and expected output**:
  `npm run bench:performance-architecture -- --repo . --quick --jsonl /tmp/plan6-quick.jsonl`.
  Expected: exits 0, writes at least status, stats, `health --json`, default
  bench summary, and output-identity fields for every command row.
- **Testability design**: Put command-matrix construction, record normalization,
  stdout hashing, and dirty-status collection in pure functions. Inject
  `spawn`, `fs`, `clock`, and `env` so tests can simulate command failure,
  timeout, and output drift without invoking real repos.
- **Why safe in this order**: This creates the measurement harness before any
  speed change, so later improvements cannot choose their own evidence after
  the fact.

### 0.2 - Verify the verifier

- **File anchor with current behavior**: `tests/runtime/bench-restore.test.ts`
  already uses a fake filesystem to prove cold-index bench restore markers fail
  safe; the campaign runner does not yet exist. Source: direct read of
  `tests/runtime/bench-restore.test.ts`.
- **Exact change**: Add tests for the campaign runner that plant three failures:
  a changed stdout hash for a command that claims output identity, a command
  timeout that must make the run non-green, and a missing required JSONL field.
  Each failure must be caught before the normal green test is trusted.
- **Validation command and expected output**:
  `npm test -- tests/runtime/performance-architecture-campaign.test.ts
tests/runtime/bench-restore.test.ts`. Expected: all tests pass, including
  explicit assertions that planted failures are rejected.
- **Testability design**: Keep the runner shell-facing, but test the logic
  through injected process results and fake files. Do not mock the production
  hash function; use real SHA-256 for the output identity contract.
- **Why safe in this order**: The benchmark harness becomes a real gate instead
  of a reporting script that always goes green.

### 0.3 - Refresh the three-corpus baseline

- **File anchor with current behavior**: The seed contains old measurements, and
  plan-writing probes show live mismatch: Vega_2.0 stale 112,289-symbol index,
  Stable_Management fresh 109,411-symbol index with unrelated user edits, and
  scip-query stale 15,961-symbol index. Source: status/stats/health probes
  recorded above.
- **Exact change**: Write
  `docs/benchmarks/2026-07-02-performance-architecture-baseline.md` and append
  to `docs/benchmarks/runs/2026-07-02-performance-architecture.jsonl`. The
  baseline must include all three repos, clean/dirty state, index freshness,
  stats, `health --json`, default `bench`, heavy `bench --include-heavy`, cold
  evidence runs, no-op reindex, and cold-index runs where allowed by time. If an
  external repo is dirty, record the dirty paths and either use a scratch clone
  or mark the result "dirty-context, not comparable".
- **Validation command and expected output**:
  `npm run bench:performance-architecture -- --repo .
--repo /Users/aydansalois/Documents/GitHub/Vega_2.0
--repo /Users/aydansalois/Documents/GitHub/Stable_Management --include-heavy
--profile --timeout-ms 600000`. Expected: JSONL rows exist for all runnable
  commands; timed-out or dirty-context rows are explicit; the baseline document
  has no "TBD" in the current-value column.
- **Testability design**: The runner writes raw JSONL first; the Markdown
  summary is generated from JSONL so hand-edited tables cannot drift from
  machine evidence.
- **Why safe in this order**: All later phases inherit one measurement surface
  and one set of current values.

## Phase 1 - Cache And Invalidation Contract

Phase 1 turns existing cache knowledge into executable coverage. This must land
before adding new cache products.

### 1.1 - Add a persistent evidence product manifest

- **File anchor with current behavior**: `FileEvidenceKind` and
  `ProjectEvidenceKind` name the persistent products, while
  `createFileEvidenceProduct()` and `createProjectEvidenceProduct()` provide
  typed read/write wrappers. Source:
  `scip-query code 'src/storage/evidence-cache.ts:23-147' -C 0` and
  `scip-query code 'src/storage/evidence-products.ts:1-69' -C 0`.
- **Exact change**: Add `src/storage/evidence-product-contracts.ts` exporting a
  manifest for every persistent cache tier: all file evidence kinds, project
  evidence kinds, `semantic_callees`, `semantic_references`, and the
  finding-outcome ledger as a non-performance ledger. Each entry must state the
  authoritative inputs, validity key fields, storage table, primary key,
  version field, expected invalidation trigger, and required staleness witness.
- **Validation command and expected output**:
  `npm test -- tests/storage/evidence-product-contracts.test.ts
tests/storage/evidence-cache.test.ts`. Expected: tests fail if any
  `FileEvidenceKind` or `ProjectEvidenceKind` is absent from the manifest; tests
  pass with 11 file products and 1 project product covered.
- **Testability design**: Export readonly arrays and pure validators. Avoid
  reaching into SQLite for the manifest; storage behavior remains tested by the
  existing evidence-cache fixtures.
- **Why safe in this order**: The manifest defines the vocabulary and coverage
  gate that new products must satisfy.

### 1.2 - Expand staleness witnesses by key shape

- **File anchor with current behavior**: `tests/storage/evidence-cache.test.ts`
  already proves content-hash mismatch, corrupt payload miss, semantic callee
  hash/digest mismatch, semantic reference project-fingerprint mismatch, and
  evidence DB open failure. Source: direct read of
  `tests/storage/evidence-cache.test.ts`; production anchors are
  `readCachedFileEvidence()`, `writeCachedFileEvidence()`,
  `readCachedSemanticCallees()`, and `readCachedSemanticReferences()` in
  `src/storage/evidence-cache.ts`.
- **Exact change**: Add a table-driven witness suite that covers each manifest
  key shape: content hash, content hash plus product guard, project fingerprint,
  dependency digest, import-resolution fingerprint, tool/config version, and
  corrupt payload. For products that cannot yet be witnessed directly, add a
  `witnessStatus: "missing"` row and fail the coverage test until the witness
  exists.
- **Validation command and expected output**:
  `npm test -- tests/storage/evidence-cache.test.ts
tests/storage/evidence-product-contracts.test.ts
tests/resolution/workspace-package-import-resolver.test.ts`. Expected: stale
  planted rows are misses, fresh rows are hits, and workspace package export
  changes are not hidden behind stale import-resolution evidence.
- **Testability design**: Use small fixture databases and planted rows. Tests
  should not depend on real Vega or Stable data.
- **Why safe in this order**: Stale-cache failure modes are proven before the
  plan asks developers to trust new cache hits.

### 1.3 - Cover in-process cache invalidation groups

- **File anchor with current behavior**: `src/storage/cache-registry.ts` defines
  `whole-project`, `source-file`, `semantic-provider`, and
  `definition-catalog` clear groups; `clearWholeProjectEvidenceCaches()` and
  `clearSourceFileEvidenceCaches()` are the named invalidation choke points.
  Source: `scip-query code src/storage/cache-registry.ts -C 80` and
  `scip-query code clearWholeProjectEvidenceCaches -C 24`.
- **Exact change**: Add a test-only registry inspection helper or a pure
  registration list that proves every factory-created in-process cache declares
  either explicit groups or `clearGroups: []`. Add tests that a source-file
  clear drops only a path-keyed cache for that file, while a whole-project clear
  drops every whole-project member.
- **Validation command and expected output**:
  `npm test -- tests/storage/cache-registry.test.ts
tests/storage/evidence-product-contracts.test.ts`. Expected: a planted
  unregistered cache or wrong group fails the test.
- **Testability design**: Keep clear behavior testable through fake caches and
  temporary `ScipDatabase` handles. The production registry should not expose
  mutable internals outside test-only helpers.
- **Why safe in this order**: Composite analyses such as health clear caches
  between phases; the clear policy must be complete before new derived products
  depend on it.

## Phase 2 - Profiling And Derived Product Opportunity Map

Phase 2 answers "what is recomputed?" with measurements, not guesses.

### 2.1 - Add low-overhead cache hit/miss profile events

- **File anchor with current behavior**: `profileSpan()` and
  `writeProfileEvent()` already write JSONL events when profiling is enabled;
  evidence cache reads and writes do not uniformly emit hit/miss/cardinality
  events. Source: `scip-query code 'src/instrumentation/profile.ts:1-85' -C 0`
  and `scip-query code readCachedFileEvidence -C 24`.
- **Exact change**: Add profile events, guarded by `profileEnabled()`, for
  persistent evidence reads/writes and semantic cache batch writes. Each event
  must include product kind or table, hit/miss/stale/corrupt outcome, payload
  byte count when known, row count for batch writes, and no payload content.
- **Validation command and expected output**:
  `SCIP_QUERY_PROFILE=1 SCIP_QUERY_PROFILE_OUT=/tmp/plan6-profile.jsonl
scip-query health --json >/tmp/plan6-health.json`; then
  `node scripts/assert-profile-events.mjs /tmp/plan6-profile.jsonl cache`.
  Expected: profile rows include cache events; running without
  `SCIP_QUERY_PROFILE` produces no profile rows and no measurable output drift.
- **Testability design**: Unit-test event construction as pure data; integration
  test only checks that profile mode writes expected event types.
- **Why safe in this order**: Observability lands before optimization, and the
  disabled path remains the current runtime path.

### 2.2 - Produce the derived product opportunity map

- **File anchor with current behavior**: Existing June ledgers show many
  accepted products and rejected variants, including source facts, re-exports,
  git file-adds, definition catalogs, semantic callees, semantic references,
  and health scheduler work. Source:
  `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`,
  `docs/benchmarks/2026-06-28-health-ledger.md`, and the Phase 0 run history.
- **Exact change**: Write
  `docs/benchmarks/2026-07-02-performance-architecture-ledger.md` with one row
  per derived product candidate. For each row record command(s), current cache
  state, cold cost, warm cost, duplicate computation count, output identity,
  candidate key, staleness witness status, and decision: `accept`, `reject`,
  `defer`, or `needs-profile`.
- **Validation command and expected output**:
  `npm run bench:performance-architecture -- --repo . --include-heavy
--profile --cold-evidence --jsonl /tmp/plan6-map.jsonl`. Expected: the ledger
  cites the JSONL run id and has no accepted product without a key and witness.
- **Testability design**: Generate the candidate summary from JSONL profile
  events where possible. Human notes may explain decisions but must not replace
  machine rows.
- **Why safe in this order**: It keeps the plan from recaching products that
  were already handled, and it records rejected ideas so they do not repeat.

### 2.3 - Convert only products that clear the acceptance filter

- **File anchor with current behavior**: `src/storage/evidence-products.ts` is
  the existing facade for file and project products, and
  `src/storage/evidence-cache.ts` already has separate semantic tables. Source:
  `scip-query plan-context src/storage/evidence-products.ts --json --limit 20`
  and `scip-query plan-context src/storage/evidence-cache.ts --json --limit 20`.
- **Exact change**: For each ledger row marked `accept`, add or extend the
  smallest product at the existing storage layer. Prefer file evidence for
  file-content-derived products, project evidence for whole-index products, and
  semantic tables only for compiler-provider-derived symbol facts. Do not add a
  bespoke command-local cache unless the ledger proves the product cannot share
  a validity model with existing tiers.
- **Validation command and expected output**: For each accepted product, run its
  focused stale witness test, its command hash comparison, and
  `npm run bench:performance-architecture -- --repo . --command "<affected command>" --cold-evidence --profile`.
  Expected: stale rows miss, corrupt rows rebuild, output identity holds, and
  the profile shows the accepted product moved a pre-registered number.
- **Testability design**: Each product exposes pure serialize/deserialize
  functions and keeps source loading, content hashing, and project fingerprint
  calculation outside the storage facade.
- **Why safe in this order**: The manifest, witnesses, and profiling are already
  in place, so every product lands with its validity proof.

## Phase 3 - Health As A Shared Pipeline

Health is the main proving workload because it composes many detectors and makes
cache mistakes visible across user-facing output.

### 3.1 - Profile health workers and phase groups

- **File anchor with current behavior**: `runIsolatedHealthReport()` filters
  runnable phases, groups related phases, and runs phase tasks through isolated
  child processes; `healthPhases()` disables cache release between grouped
  phases. Source: `scip-query code 'src/runtime/cli-support.ts:134-236' -C 0`
  and `scip-query code withHealthRun -C 24`.
- **Exact change**: Add profile events around health task scheduling, worker
  start/finish, phase group duration, worker stdout bytes, and per-phase result
  assembly. Include phase names, applicability skip count, concurrency, and
  whether `full` mode was true.
- **Validation command and expected output**:
  `SCIP_QUERY_PROFILE=1 SCIP_QUERY_PROFILE_OUT=/tmp/plan6-health-profile.jsonl
scip-query health --json >/tmp/plan6-health.json`. Expected: health output
  hash matches an unprofiled control; profile JSONL contains parent scheduling
  events and child phase events.
- **Testability design**: Use injected task runners for scheduler tests. Avoid
  adding timing assertions to unit tests; assert event shape and phase grouping.
- **Why safe in this order**: Scheduler observability must exist before changing
  phase grouping or shared products.

### 3.2 - Collapse repeated setup only when the profile proves it

- **File anchor with current behavior**: Health currently clears whole-project
  evidence caches after each phase unless phases are grouped, and clears semantic
  provider caches after the full run. Source:
  `scip-query code healthBudget -C 24`, `scip-query code runHealthPhase -C 24`,
  and `scip-query code clearWholeProjectEvidenceCaches -C 24`.
- **Exact change**: If Phase 3.1 shows repeated setup dominates, apply one of
  these in order: group phases that share reusable source facts and already
  return independent phase payloads; move a repeated stable intermediate to an
  evidence product; or add a narrow in-process cache group with an explicit clear
  point. Do not reduce report completeness, do not switch visible health to
  bounded mode, and do not hide findings.
- **Validation command and expected output**:
  Compare profiled and unprofiled `health --json` on scip-query, Vega_2.0, and
  Stable_Management. Expected: byte-identical output hashes and movement toward
  the pre-registered health targets. If a target is missed, the ledger names the
  remaining top span and why it is not fixed in this phase.
- **Testability design**: Phase grouping must be tested with synthetic phase
  results so aggregation order and skip behavior remain stable. Evidence-product
  additions follow Phase 2 staleness witnesses.
- **Why safe in this order**: It changes sharing only after the cost and output
  contract are visible.

### 3.3 - Keep health completeness as the invariant

- **File anchor with current behavior**: The visible CLI `health` handler passes
  `full: true`; `--full` is a compatibility flag. Source:
  `scip-query code handleHealth -C 18` and
  `src/runtime/commands/command-descriptors.ts:99` from `rg`.
- **Exact change**: Add a regression test or CLI contract assertion that visible
  `health` remains full by default after performance changes. If any phase adds
  a budget, it must be explicit in a separate option or internal debug path, not
  in the default health report.
- **Validation command and expected output**:
  `npm test -- tests/runtime/cli-contract.test.ts
tests/queries/health/health-full.test.ts`. Expected: visible health still
  invokes full mode, while bounded behavior remains available only through
  explicit internal options.
- **Testability design**: Keep the default-policy test independent from large
  external repos by asserting handler behavior and fixture counts.
- **Why safe in this order**: It prevents performance pressure from undoing the
  correctness policy established before Plan 6.

## Phase 4 - Reindex Proportionality And Incremental Feasibility

This phase is GATED. It may decide that per-file indexing is unsafe or not worth
implementing. A rejected feasibility study is a valid completion if the evidence
is written down.

### 4.1 - Add a reindex proportionality probe

- **File anchor with current behavior**: `reindex()` computes a whole-project
  fingerprint, tries whole-index reuse, then runs fresh indexers with reusable
  per-language outputs where possible. Source:
  `scip-query code 'src/reindex/index.ts:138-214' -C 0`,
  `scip-query code reuseExistingIndexIfPossible -C 24`, and
  `scip-query code runFreshReindex -C 30`.
- **Exact change**: Extend the campaign runner or add
  `scripts/reindex-proportionality-probe.mjs`. The probe must operate on
  scratch copies or disposable worktrees, apply controlled edits, run `reindex`,
  and record which indexers or shards rebuilt. Required edit cases: no-op,
  leaf TypeScript file, shared workspace package source file, package `exports`
  change, tsconfig path alias change, non-TypeScript language file, docs-only
  file, and lockfile change.
- **Validation command and expected output**:
  `node scripts/reindex-proportionality-probe.mjs --repo . --quick
--jsonl /tmp/plan6-reindex.jsonl`. Expected: no user working-tree changes,
  no scratch dirs left behind, and rows record changed files, expected invalidated
  tiers, actual reused/rebuilt tiers, and duration.
- **Testability design**: Put edit-case definitions and expected invalidation
  rules in pure data. Inject filesystem and reindex command runner for unit
  tests; integration tests use temporary fixtures.
- **Why safe in this order**: It measures proportionality and correctness before
  proposing a finer-grained index cache.

### 4.2 - Prove workspace dependency invalidation before finer reuse

- **File anchor with current behavior**: Workspace package imports resolve
  through package `exports`, `dist` to `src` mapping, and fallback
  `src/<subpath>` candidates; tests already cover unbuilt pnpm-style workspace
  packages. Source: `scip-query code
'src/resolution/import-path-resolver.ts:191-433'` and direct read of
  `tests/resolution/workspace-package-import-resolver.test.ts`.
- **Exact change**: Add reindex/invalidation tests that simulate
  `packages/shared` changing under a workspace consumer. Tests must prove that a
  shared-package source edit, package `exports` edit, and tsconfig alias edit
  invalidate any cached product or shard that could affect dependent packages.
  If the current fingerprint already invalidates conservatively, record that and
  do not add a narrower cache yet.
- **Validation command and expected output**:
  `npm test -- tests/reindex/reindex-reliability.test.ts
tests/reindex/typescript-projects.test.ts
tests/resolution/workspace-package-import-resolver.test.ts`. Expected:
  controlled shared edits cannot produce stale consumer evidence.
- **Testability design**: Use temporary monorepo fixtures with two packages and
  one shared package. Assert invalidation through observable reindex metadata and
  command output, not through implementation-private flags alone.
- **Why safe in this order**: It blocks the main monorepo correctness failure:
  treating a shared edit as local because it was small.

### 4.3 - GATED per-project or per-file index reuse

- **File anchor with current behavior**: TypeScript workspace mode already runs
  project shards and publishes one TypeScript language output; tests assert
  project arguments. Source: direct read of
  `tests/reindex/reindex-reliability.test.ts` and
  `tests/reindex/typescript-projects.test.ts`.
- **Exact change**: Only if 4.1 and 4.2 prove a safe key, add a narrower reuse
  tier. Prefer per-project TypeScript shard reuse before per-file reuse. Key it
  by resolved tsconfig, compiler/indexer version, project file set, package
  `exports` and lockfile inputs that can affect resolution, and all upstream
  workspace packages the project imports. Do not implement per-file TypeScript
  reuse unless the plan proves compiler-resolved references stay correct for
  edits to exported symbols, type-only imports, project references, and alias
  paths.
- **Validation command and expected output**:
  Run the reindex proportionality probe on all three repos. Expected: leaf edits
  rebuild only the owning safe tier; shared-package and config edits invalidate
  dependents; no output hash drift in representative commands after reindex.
- **Testability design**: Keep fingerprint computation pure and separately
  tested. Integration tests must plant a stale shard and prove the key rejects
  it.
- **Why safe in this order**: The accepted change is a one-way door. It starts
  with a conservative tier and does not proceed unless the invalidation proof is
  stronger than the speed claim.

## Phase 5 - Cross-Checkout Cache Identity And Retro-Gate

This phase is also GATED. The current root-path cache identity is safe but
expensive across worktrees; shared cache identity is only acceptable if stale
cross-branch reuse is impossible under the key.

### 5.1 - Measure cross-checkout duplication

- **File anchor with current behavior**: `resolveCacheDir()` hashes the absolute
  project root, so two clones or worktrees of the same content use different
  cache directories. Source: `scip-query code resolveCacheDir -C 40`.
- **Exact change**: Add `scripts/retro-gate-cache-probe.mjs` or a campaign-runner
  mode that creates two disposable worktrees or copies at the same commit,
  measures cold reindex/evidence fill in the first, then measures the second
  with and without any proposed shared-cache setting. Also measure a commit walk
  that changes one file per commit and records per-commit reindex cost.
- **Validation command and expected output**:
  `node scripts/retro-gate-cache-probe.mjs --repo . --commits 3
--jsonl /tmp/plan6-retro.jsonl`. Expected: no source tree mutation, all
  worktrees removed, rows show root path, content fingerprint, cache dir, reuse
  outcome, and per-commit duration.
- **Testability design**: Unit-test key construction and worktree cleanup with a
  fake command runner. Integration tests use a tiny temporary git repo.
- **Why safe in this order**: It proves the motivating retro-gate number before
  changing cache identity.

### 5.2 - GATED shared content-addressed cache

- **File anchor with current behavior**: Whole-index and per-language shard reuse
  already depend on reindex fingerprints, but their artifacts live under a
  project-root-specific cache directory. Source:
  `scip-query code computeReindexFingerprint -C 24`,
  `scip-query code computeLanguageFingerprints -C 20`, and
  `scip-query code languageShardPath -C 18`.
- **Exact change**: If 5.1 shows material duplicate work and 4.2's invalidation
  proof holds, add an opt-in shared cache directory, such as
  `SCIP_QUERY_SHARED_CACHE_DIR` or config. Store immutable artifacts under
  content-addressed keys derived from reindex fingerprint, indexed languages,
  tool versions, product versions, and platform-sensitive inputs. Copy artifacts
  atomically into the project-root cache; never run directly from a mutable
  shared artifact. Default remains off until the shared-cache test matrix is
  green on all three repos.
- **Validation command and expected output**:
  Two worktrees at the same commit share the artifact; branch switch or
  config/source edit misses; corrupt shared artifact falls back to rebuild;
  output hashes match non-shared controls. `npm test -- tests/reindex/*shared*`
  plus the retro-gate probe must pass.
- **Testability design**: Key construction is pure. Artifact publish/copy uses
  injected filesystem primitives and targeted corruption tests.
- **Why safe in this order**: Root-path cache isolation remains the default
  fallback. The shared tier is introduced only after proving identity, invalidation,
  corruption, and rollback.

## Phase 6 - Scoreboard, Gates, And Closure

### 6.1 - Update the durable performance record

- **File anchor with current behavior**: June performance work records ledgers
  and scoreboards under `docs/benchmarks/`, and the evidence-product contract
  already writes JSONL under `docs/benchmarks/runs/`. Source:
  `ls docs/benchmarks`, `ls docs/benchmarks/runs`, and
  `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`.
- **Exact change**: Add or update
  `docs/benchmarks/2026-07-02-performance-architecture-scoreboard.md` with
  starting value, current value, delta, corpus, commit/version, cache state,
  output identity, accepted changes, rejected ideas, and remaining bottlenecks.
  Link every row to the JSONL run id.
- **Validation command and expected output**:
  `node scripts/render-performance-scoreboard.mjs
docs/benchmarks/runs/2026-07-02-performance-architecture.jsonl
--check docs/benchmarks/2026-07-02-performance-architecture-scoreboard.md`.
  Expected: generated or checked Markdown matches run history.
- **Testability design**: Scoreboard rendering is deterministic from JSONL; no
  hand-calculated deltas.
- **Why safe in this order**: It prevents knowledge from staying only in the
  conversation or transient terminal output.

### 6.2 - Run structural postchecks for touched surfaces

- **File anchor with current behavior**: The shared scip-query postcheck table
  requires targeted checks based on the type of change. Source:
  `/Users/aydansalois/Documents/GitHub/scip-query/skills/_shared/SKILL.md`.
- **Exact change**: For each phase, run the matching postchecks:
  `recent-duplicates` for new helpers, `unused-params` for new options,
  `wrapper-candidates` and `passthrough-candidates` for new facades,
  `stale-abstractions` for new interfaces, `co-change` and `doc-drift` for docs
  and config, and `cleanup-plan --verify` if code is deleted.
- **Validation command and expected output**:
  The phase PR or commit message lists each postcheck and its result. Expected:
  zero blocking findings, or each finding is fixed or ledgered with a reason.
- **Testability design**: Postchecks are command-level probes; do not replace
  unit tests with them.
- **Why safe in this order**: It catches architectural cleanup regressions after
  focused correctness and performance tests have passed.

### 6.3 - Final gate and self-report

- **File anchor with current behavior**: Project guidance requires
  `scip-query reindex && scip-query diff-gate` before declaring work done.
  Source: `AGENTS.md` project instructions.
- **Exact change**: Run the full gate list, update the self-report at the end of
  this plan or a result document, and record every deviation, accepted miss, and
  deferred item.
- **Validation command and expected output**:
  `npm run typecheck && npm test && npm run build && scip-query reindex &&
scip-query diff-gate --json`. Expected: all pass, or any nonzero diff-gate
  result is fixed or recorded with a specific acceptance reason.
- **Testability design**: The final report must cite command outputs and JSONL
  run ids, not memory.
- **Why safe in this order**: Closure happens only after implementation,
  verification, and durable reporting agree.

## Delegation Map

Concurrent agents may be used only with disjoint write scopes.

| Agent | Write scope                                                                          | Brief                                                             | Handoff probe conductor must reproduce                     |
| ----- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| A     | `scripts/performance-architecture-campaign.mjs`, runner tests, `package.json` script | Build Phase 0 harness and verifier-failure tests                  | Plant output hash drift; runner must fail                  |
| B     | `src/storage/evidence-product-contracts.ts`, storage tests                           | Build Phase 1 manifest and witnesses                              | Delete one manifest row; coverage test must fail           |
| C     | health profiling files and health tests                                              | Add Phase 3 profile events and any accepted health sharing change | Compare profiled and unprofiled `health --json` hash       |
| D     | reindex probe script and reindex tests                                               | Build Phase 4 proportionality probes and any safe shard reuse     | Shared package edit must invalidate dependent evidence     |
| E     | retro-gate probe script and optional shared-cache files                              | Build Phase 5 probes and opt-in shared cache only if gated        | Two worktrees same commit hit; branch/config change misses |

If scopes collide, stop parallel work, apply one patch atomically, run the
focused probe, then resequence to a single writer.

## One-Way Doors

- **Per-file TypeScript index reuse**: Do not implement until exported-symbol
  edits, type-only imports, project references, path aliases, and shared package
  consumers all have stale-witness coverage. Migration path if accepted: keep
  the whole-language shard as fallback, guard per-file reuse behind a config/env
  flag, and add a command to purge the fine-grained cache.
- **Cross-checkout shared cache**: Do not enable by default in this plan.
  Migration path if accepted: opt-in env/config, immutable content-addressed
  blobs, atomic copy into project cache, corruption fallback, and a documented
  purge path.
- **Changing visible health completeness**: Not allowed in Plan 6 without user
  approval. Migration path would require a new explicit fast-preview command or
  option, not a silent default change.
- **Changing evidence.db schema incompatibly**: Avoid unless a product cannot be
  represented in existing tables. Migration path: new version, legacy read path,
  rebuild-on-miss, and a size/corruption test.

## DEFER List

- Remote or distributed shared cache service.
- Always-on daemon as the primary performance answer.
- Public command output changes not required for performance evidence.
- Automatic suppression or downranking of health findings.
- Cache eviction beyond bounded local cleanup needed for correctness tests.
- Per-file TypeScript reuse if Phase 4 cannot prove compiler-resolved
  correctness.
- Optimizing external repos while their working trees are dirty, unless the run
  is explicitly marked dirty-context and excluded from comparable scoreboards.

## Initial Deviation Ledger

- The seed's external repo sizes and live plan-writing status probes differ.
  Phase 0 must refresh baselines before implementation.
- Vega_2.0's local index was stale during plan writing, so its 35.88 s health
  probe is a motivation number, not a comparable baseline.
- Stable_Management had unrelated user edits during plan writing. Treat its
  14.57 s health probe as dirty-context until a clean scratch run is captured.
- Tests are not present in the current SCIP index. Test-file evidence in this
  plan uses direct file reads and names that limitation.
- The current scip-query index was stale before this document edit. The final
  plan-writing verification must reindex before diff-gate.

## Plan-Writing Self-Report

- [x] Three laws applied: this plan requires verifier-failure probes, writes
      each implementation step as an executor contract, and records deviation and
      defer ledgers.
- [x] Pre-registered benchmarks recorded: health, reindex, retro-gate,
      persistent cache coverage, profile cardinality, and output identity have
      current values or Phase 0 refresh obligations plus targets.
- [x] File anchors cited: evidence storage, evidence products, reindex reuse,
      project fingerprints, cache directories, workspace package resolution, health
      scheduling, profiling, bench, and relevant tests are anchored to commands or
      direct test reads where indexing is unavailable.
- [x] Handoff probes specified: every delegated scope has one minimal probe the
      conductor must reproduce.
- [x] Deviation ledger started: stale indexes, dirty external repo state,
      mismatched seed/live baselines, and unindexed test files are recorded.
- [x] DEFER list written: remote cache service, daemon-first design, output
      changes, automatic finding suppression, broad eviction, unproven per-file
      TypeScript reuse, and dirty-context optimization are out of scope.
- [x] Learnings folded back: the plan updates the seed to reflect current full
      health default behavior, existing typed evidence products, existing cache
      registry, current root-path cache identity, and required staleness witnesses.
