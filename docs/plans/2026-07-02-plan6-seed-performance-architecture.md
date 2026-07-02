# Plan 6 - Performance as architecture

Date: 2026-07-02
Status: READY FOR EXECUTION
Executor: agent program, one step per commit, conductor closeout required
Inputs: this seed's measured 2026-07-02 baselines; June benchmark ledgers in
`docs/benchmarks/`; `scip-hyper-optimization` methodology; current evidence
cache/product code.

## Goal

Performance as architecture means the fast path must come from shared, named,
tested storage and invalidation contracts, not from isolated shortcuts inside
individual commands.

Done means all of these are true on the same built CLI and the same three
benchmark repos:

- `/Users/aydansalois/Documents/GitHub/Vega_2.0`:
  - `scip-query health --json` improves from the seed baseline of 26.5s to
    **<= 8.0s warm** and **<= 14.0s after clearing only `evidence.db`** with
    byte-identical JSON output for the same repo state.
  - retro-gate improves from about 36s/commit to **<= 12s/commit median over
    five replayed commits**, or the plan records a BLOCKED note proving the
    remaining cost is an upstream indexer boundary rather than a scip-query
    cache/invalidation bug.
  - cold `reindex` improves from 29.8s to **<= 22.0s**, and shard-reuse stays
    **<= 1.0s**.
- `/Users/aydansalois/Documents/GitHub/Stable_Management`: cold `reindex`
  improves from 13.9s to **<= 10.0s** with the detector battery still cheap
  enough that no command exceeds 4.0s warm.
- `/Users/aydansalois/Documents/GitHub/scip-query`: cold `reindex` stays
  **<= 3.5s**, `health --json` stays **<= 1.5s**, and the full repo gate stays
  green.
- Every accepted cache tier has a written invalidation key and at least one
  staleness test that first proves the old value can be planted, then proves
  the cache refuses it after the relevant input changes.
- Every optimized command keeps the same stdout SHA-256 for the same repo
  state unless the step has explicit user approval to change behavior.

## Concepts

A cache is a stored copy of a value computed from source text, configuration,
index rows, tool versions, or git state; what makes it a cache rather than
ordinary storage is that the read is correct only while a declared identity key
still describes the inputs that produced the value.

An evidence product is a rebuildable cache entry used by scip-query detectors
and graph queries; it is the kind of cache whose payload represents code
evidence and whose identity must be derived from the same source, index, config,
and tool facts the detector would otherwise recompute.

Invalidation is the rule that turns a previous cache entry into a miss; it is a
correctness rule over changing inputs, and its essential job is to prevent a
stored value from being used after the facts that made it true have changed.

A project fingerprint is a digest of the current indexed project identity; in
this repo it is the cache key component derived from reindex metadata and the
indexed language set, so it changes when the whole-project index facts a
project-shaped product depends on change.

A measurement harness is the repeatable set of commands, repo states, cache
states, output hashes, profiles, and run-history files used to decide whether
runtime changed without changing behavior.

A monorepo is a repository containing multiple packages, workspaces, or
languages whose code may depend across internal package boundaries; the
performance problem is harder there because a local edit can affect facts in a
different package even when the changed file count is small.

## Pre-registered baselines and targets

These values are pre-registered before Plan 6 implementation. If an executor
observes different current values, the executor must record both numbers in the
ledger before editing code and use the newer measured value as the comparison
baseline.

| Repo / workload | Seed before | Target |
| --- | ---: | ---: |
| Vega_2.0 cold `reindex` | 29.8s | <= 22.0s |
| Vega_2.0 shard-reuse `reindex` | 0.4s-0.8s | <= 1.0s, no regression |
| Vega_2.0 `health --json` | 26.5s | <= 8.0s warm, <= 14.0s evidence-cold |
| Vega_2.0 retro-gate replay | ~36s/commit | <= 12s/commit median over 5 commits |
| Stable_Management cold `reindex` | 13.9s | <= 10.0s |
| Stable_Management detector battery | cheap | no warm command > 4.0s |
| scip-query cold `reindex` | 2.5s-3.0s | <= 3.5s, no regression |
| scip-query `health --json` | ~1.2s | <= 1.5s, no regression |

Historical context, not the current Plan 6 acceptance baseline:
`docs/benchmarks/2026-06-28-vega-current-scoreboard.md` recorded a strong June
warm state where Vega commands were mostly sub-3s; this plan treats the
2026-07-02 seed values as the current larger-corpus problem and uses the June
ledgers to avoid rediscovering rejected approaches.

## Working agreement

- Work directly on `main`.
- One commit per step, named `plan6.<step>: <short outcome>`.
- Do not start a later implementation step until the current step's focused
  probe, full phase gate, and ledger entry are complete.
- Never use `git checkout`, `git restore`, or `git stash` on a dirty tree.
  Revert temporary probes with targeted edits or deletion.
- Every benchmark run appends JSONL to `docs/benchmarks/runs/`.
- Every accepted optimization updates the relevant human ledger under
  `docs/benchmarks/`.
- If source contradicts an anchor, write a `BLOCKED:` note in this plan or the
  ledger and continue with the next independent step. Do not silently improvise.
- Full phase gate unless a step narrows it further:
  - `npm run typecheck`
  - `npm run lint`
  - `npm test`
  - `npm run build`
  - postcheck matching the touched code from `_shared/SKILL.md`
  - `node dist/cli.js reindex`
  - `node dist/cli.js diff-gate --json`

## Source anchors

- `src/storage/evidence-cache.ts`: `node dist/cli.js plan-context
  src/storage/evidence-cache.ts --json --full` shows `evidence.db` is opened as
  a sibling of `index.db`, creates `file_evidence`, `project_evidence`,
  `semantic_callees`, `semantic_references`, and `finding_outcome_ledger`, and
  exposes content-hash, project-fingerprint, semantic, and ledger helpers. The
  module has 14 reverse-dependent files and 42 external consumers, so storage
  changes are high-risk and must land behind tests.
- `src/storage/evidence-products.ts`: `node dist/cli.js plan-context
  src/storage/evidence-products.ts --json --full` shows
  `createFileEvidenceProduct()` and `createProjectEvidenceProduct()` wrap the
  storage helpers, have 10 reverse-dependent files, and expose no
  machine-readable invalidation manifest.
- `src/runtime/commands/command-handlers.ts`: `node dist/cli.js plan-context
  handleBench --json --full` shows `handleBench()` already measures cold/warm
  index runs, command runtimes, and profile output through `bench --profile`.
- `scripts/evidence-product-contract.mjs`: this script is not in the current
  SCIP index (`node dist/cli.js plan-context scripts/evidence-product-contract.mjs
  --json --full` returns no match), so the anchor is direct file inspection: it
  clears only `evidence.db`, runs five commands, appends JSONL with
  durations/output hashes/cache size, and profiles child commands. It is
  evidence-product-specific rather than a whole performance architecture
  harness.
- `src/queries/health/health.ts`: `node dist/cli.js plan-context healthPhases
  --json --full` shows `healthPhases()` shares in-process caches across phase
  runners by using `releaseCachesBetweenPhases: false`.
- `src/runtime/cli-support.ts`: `node dist/cli.js plan-context
  runIsolatedHealthReport --json --full` shows CLI health still runs phase tasks
  in isolated processes through `healthPhaseTasks()` and
  `runHealthPhaseTaskProcess()`, so cross-process reuse depends on persistent
  evidence products, not in-memory caches.
- `src/symbols/graph/file-dep-graph.ts`: `node dist/cli.js plan-context
  buildFileDepGraph --json --full` shows a project-level evidence product
  already exists for file dependency graphs, keyed by project fingerprint and a
  source-import fingerprint, with profile spans for source imports, product
  hit/miss, and SCIP edges.
- `src/storage/evidence-cache.ts`: `node dist/cli.js plan-context
  projectEvidenceFingerprint --json --full` shows the project fingerprint is
  derived from `meta.json` fingerprint plus sorted indexed languages.
- `src/symbols/graph/file-dep-graph.ts`: `node dist/cli.js plan-context
  sourceImportFingerprint --json --full` shows one existing dependent
  fingerprint pattern: sorted source import edges are hashed with the file list.

## Phase 6.0 - Baseline harness and ledgers

### 6.0.1 - Create the Plan 6 benchmark harness

- **File anchor and current behavior**: `src/runtime/commands/command-handlers.ts`
  already supports `bench --json --cold-index --include-heavy --profile`; source
  `node dist/cli.js plan-context handleBench --json --full`.
- **Exact change**: add `scripts/performance-architecture-contract.mjs`. It must
  run from any target repo with `SCIP_QUERY_CLI=/absolute/path/to/dist/cli.js`
  or default to this repo's `dist/cli.js`. It must record repo path, git HEAD,
  dirty status, command, cache state (`cold-index`, `warm-index`,
  `evidence-cold`, `evidence-warm`, `retro-gate`), duration, exit code,
  stdout/stderr byte counts, stdout SHA-256, `index.db` size, `evidence.db`
  size, and profile path. It must append JSONL to
  `docs/benchmarks/runs/2026-07-02-performance-architecture.jsonl`.
- **Validation command and expected output**:
  `node scripts/performance-architecture-contract.mjs --repo . --command "health --json" --warm-iterations 1 --no-clear`
  exits 0 and appends one JSONL row with `command:
  "scip-query health --json"`, `stdoutSha256`, and `durationMs > 0`.
- **Testability design**: parse args and record construction as pure functions;
  inject `spawnSync`, filesystem, clock, and hashing in unit tests so tests do
  not need to run real benchmarks.
- **Why safe in this order**: the harness changes no production behavior and
  creates the evidence trail required before optimization.

### 6.0.2 - Write the Plan 6 ledger and rerun baselines

- **File anchor and current behavior**:
  `docs/benchmarks/2026-06-28-vega-current-scoreboard.md` is the prior human
  scoreboard; the seed has newer Plan 6 baselines but no run-history file.
- **Exact change**: create
  `docs/benchmarks/2026-07-02-performance-architecture-ledger.md` with Output
  Contract, Corpus Matrix, Cache States, Run History Location, Open Questions,
  Accepted Changes, Rejected Changes, and Scoreboard sections. Run the harness
  on scip-query, Stable_Management, and Vega_2.0 before any code optimization.
- **Validation command and expected output**:
  `rg -n "Vega_2.0|Stable_Management|Run History Location|Output Contract" docs/benchmarks/2026-07-02-performance-architecture-ledger.md`
  prints all four terms; the JSONL run file contains at least one `baseline`
  record for each repo.
- **Testability design**: the ledger is data, but the harness owns machine
  validation; run-history parsing should be tested in 6.0.1.
- **Why safe in this order**: this locks the before numbers and prevents later
  agents from accepting faster-but-different command output.

### 6.0.3 - Add benchmark profile aggregation

- **File anchor and current behavior**: `bench --profile` writes JSONL phase
  events, but the Plan 6 decision points require a ranked span view across
  commands; source `node dist/cli.js plan-context handleBench --json --full`.
- **Exact change**: add a small `scripts/profile-scoreboard.mjs` that reads
  profile JSONL and prints the top spans by total duration, grouped by command,
  span name, and cache state. The script must also emit JSON with
  `totalDurationMs`, `count`, and any numeric cardinality fields observed in
  span metadata.
- **Validation command and expected output**:
  `node scripts/profile-scoreboard.mjs --input <profile-jsonl> --top 10 --json`
  exits 0 and prints an array sorted by descending `totalDurationMs`.
- **Testability design**: feed a tiny fixture JSONL file; assert grouping and
  numeric metadata aggregation without spawning the CLI.
- **Why safe in this order**: optimization hypotheses must come from measured
  spans, not from reading code and guessing.

## Phase 6.1 - Invalidation contract before more caches

### 6.1.1 - Add an evidence-product manifest

- **File anchor and current behavior**: `src/storage/evidence-products.ts`
  defines file and project product factories, while
  `src/storage/evidence-cache.ts` defines the allowed kind unions; neither
  carries a structured reason for each invalidation key.
- **Exact change**: extend `FileEvidenceProductOptions` and
  `ProjectEvidenceProductOptions` with a required `invalidation` object:
  `scope`, `dependsOn`, `keyParts`, `stalenessTest`, and `owner`. Register every
  existing product in a central exported list. Existing products must declare
  whether they depend on content hash, direct-deps digest, project fingerprint,
  import-resolution fingerprint, git HEAD/history, config, tool version, or
  indexed language set.
- **Validation command and expected output**:
  `npm test -- tests/storage/evidence-cache.test.ts tests/storage/evidence-products.test.ts`
  passes and includes a new assertion that every `FileEvidenceKind` and
  `ProjectEvidenceKind` has exactly one manifest entry.
- **Testability design**: pure manifest validation function returns missing,
  duplicate, and unknown entries; the test can mutate an in-memory manifest to
  prove failures.
- **Why safe in this order**: this does not add new caching; it makes existing
  caching auditable before Plan 6 increases cache surface area.

### 6.1.2 - Verify the verifier with planted stale rows

- **File anchor and current behavior**: `tests/storage/evidence-cache.test.ts`
  already covers evidence DB read/write behavior and failure fallback; source
  `node dist/cli.js plan-context src/storage/evidence-cache.ts --json --full`
  shows storage helpers return misses on key mismatch.
- **Exact change**: add staleness tests for representative tiers:
  `file_evidence` misses after source content changes, `project_evidence`
  misses after project fingerprint changes, `semantic_callees` misses after
  deps digest changes, `semantic_references` misses after project fingerprint
  changes, and git-history products miss after HEAD/history key changes. Each
  test must first plant a row that reads successfully, then mutate the key input
  and assert the stale row is not returned.
- **Validation command and expected output**:
  `npm test -- tests/storage/evidence-cache.test.ts tests/symbols/definition-catalog.test.ts tests/symbols/file-dep-graph.test.ts`
  passes and proves at least one planted stale read is rejected in each tier.
- **Testability design**: use temp dirs and synthetic metadata; avoid real git
  history except for the git product, where the git reader should be injected.
- **Why safe in this order**: conductor law 1 requires seeing the verifier fail
  before trusting green cache tests.

### 6.1.3 - Document the cache identity matrix

- **File anchor and current behavior**: the seed lists open questions about
  invalidation, workspace mode, and cross-checkout identity, but there is no
  durable matrix that executors can update.
- **Exact change**: add `docs/architecture/evidence-cache-invalidation.md`.
  For every product, record real-world referent, cache table, payload owner,
  key parts, invalidation trigger, staleness test path, benchmark command, and
  whether it is safe across branch switches, worktrees, clones, workspace mode,
  and multi-language indexes.
- **Validation command and expected output**:
  `node scripts/check-evidence-manifest-doc.mjs` exits 0 after verifying that
  every manifest entry appears in the doc with a staleness test path.
- **Testability design**: implement the checker as a pure markdown/table parser
  around the exported manifest JSON.
- **Why safe in this order**: later performance changes can update one manifest
  and one table instead of scattering cache rules through prose.

## Phase 6.2 - Derived-product inventory and hit/miss visibility

### 6.2.1 - Audit recomputed products

- **File anchor and current behavior**: `src/storage/evidence-cache.ts` lists
  current file/project/semantic evidence kinds, but the seed's candidate list
  says definition catalogs, callee fingerprints, git-history extracts,
  co-change maps, source facts, and React/Vue profiles may still be recomputed
  unevenly.
- **Exact change**: add an inventory section to the Plan 6 ledger. For each
  detector family, record its shared intermediate products, current cache tier
  if any, profile span name, cache hit/miss metadata, and whether the product is
  file-shaped, project-shaped, git-shaped, or workspace-shaped. Use
  `node dist/cli.js call-graph <entry>` and `node dist/cli.js code <hot-symbol>`
  to cite every product owner.
- **Validation command and expected output**:
  `rg -n "definition catalog|callee fingerprint|git history|co-change|source facts|React|Vue" docs/benchmarks/2026-07-02-performance-architecture-ledger.md`
  prints entries for every product class named in the seed.
- **Testability design**: no code unless gaps in profile metadata are found;
  the next step adds machine visibility.
- **Why safe in this order**: the team must decide which cache to promote from
  measured recomputation, not from the longest-looking source file.

### 6.2.2 - Standardize evidence hit/miss profile metadata

- **File anchor and current behavior**:
  `src/symbols/graph/file-dep-graph.ts` already emits `file-dep-graph.product`
  metadata including `available`, `hit`, and cardinality counts; source
  `node dist/cli.js plan-context buildFileDepGraph --json --full`.
- **Exact change**: require every persistent evidence product read path to emit
  a profile span or counter with at least `kind`, `hit`, `available`, and
  product-specific cardinality. Start by instrumenting product wrappers in
  `src/storage/evidence-products.ts`; add specialized metadata only where the
  wrapper lacks cardinality context.
- **Validation command and expected output**:
  `SCIP_QUERY_PROFILE=1 SCIP_QUERY_PROFILE_OUT=/tmp/plan6-profile.jsonl node dist/cli.js health --json`
  exits 0, and `node scripts/profile-scoreboard.mjs --input /tmp/plan6-profile.jsonl --json`
  shows evidence product spans with both hits and misses after one cold and one
  warm run.
- **Testability design**: wrapper tests inject a fake profile sink and assert
  corrupt payloads report misses without throwing.
- **Why safe in this order**: profiling metadata is needed before picking the
  next product to persist; it should not alter command outputs.

### 6.2.3 - Add cache-row and cache-size scoreboard output

- **File anchor and current behavior**:
  `scripts/evidence-product-contract.mjs` records evidence DB size, but not row
  counts by kind/table.
- **Exact change**: extend the Plan 6 harness to collect `evidence.db` row
  counts grouped by table and kind after each command. Record `file_evidence`
  kind counts, `project_evidence` kind counts, semantic callees/references row
  counts, and finding ledger row counts.
- **Validation command and expected output**:
  run one evidence-cold and one evidence-warm command; JSONL records include
  `evidenceRows.file_evidence["source-facts"]` or `0` and never omit the table
  object.
- **Testability design**: row counting is a pure SQLite read against a temp DB
  fixture with all tables.
- **Why safe in this order**: large-cache growth is a performance and disk
  liability; rows and bytes must move into the scoreboard before new products
  are added.

## Phase 6.3 - Health as the first architecture customer

### 6.3.1 - Split Vega health by phase and shared product

- **File anchor and current behavior**:
  `src/runtime/cli-support.ts` runs CLI health as isolated phase tasks, while
  `src/queries/health/health.ts` can share caches only inside one process;
  sources `node dist/cli.js plan-context runIsolatedHealthReport --json --full`
  and `node dist/cli.js plan-context healthPhases --json --full`.
- **Exact change**: use the Plan 6 harness to run `health --json`,
  `health --json --full`, and every `__health-phase <phase> --json` on
  Vega_2.0 in evidence-cold and evidence-warm states. Update the ledger with a
  phase-by-phase table showing duration, output hash, dominant spans, evidence
  rows read/written, and whether the cost is in persistent miss fill,
  cross-process repeated setup, or pure detector scoring.
- **Validation command and expected output**:
  `rg -n "__health-phase|dominant spans|evidence-cold|evidence-warm" docs/benchmarks/2026-07-02-performance-architecture-ledger.md`
  shows a completed health table; every phase has an output hash.
- **Testability design**: no code change required unless a phase command lacks
  machine-readable output; any missing output gets a BLOCKED note and a small
  CLI output-shape fix step.
- **Why safe in this order**: health is the seed's slowest command on the large
  corpus; phase attribution prevents broad rewrites.

### 6.3.2 - Promote the highest repeated health product

- **File anchor and current behavior**: the exact file is chosen by 6.3.1.
  Candidate anchors likely include `src/symbols/definition-catalog.ts`,
  `src/queries/cleanup/similar.ts`, `src/analysis/git-history.ts`,
  `src/source/react-profile.ts`, Vue source-profile modules, or
  `src/queries/internal/consumer-evidence.ts`; the current anchor must be
  cited with `node dist/cli.js plan-context <chosen-symbol> --json --full`
  before editing.
- **Exact change**: persist exactly one derived product that 6.3.1 proves is
  recomputed across health phases or child processes. The product must use the
  existing evidence product factory unless its shape cannot fit file/project
  products, in which case add a narrowly named factory with the same manifest
  and staleness-test requirements.
- **Validation command and expected output**:
  focused tests for the product pass; Vega health output SHA-256 is unchanged;
  the product's warm profile shows `hit: true`; `health --json` moves toward
  the <= 8.0s target or the ledger records why this product was accepted as an
  architectural prerequisite rather than an immediate wall-time win.
- **Testability design**: pure serialize/deserialize and key-composition
  helpers; storage effects injected through product wrappers; one planted-stale
  test for each key component.
- **Why safe in this order**: this is the first real optimization only after
  baseline, manifest, stale tests, and health attribution exist.

### 6.3.3 - Repeat only while the next product clears the threshold

- **File anchor and current behavior**: 6.3.1 ranks health products; the ledger
  must show the next candidate still owns at least 15% of Vega health wall time
  or at least 2.0s evidence-cold wall time.
- **Exact change**: repeat 6.3.2 for the next product only if it clears that
  threshold. Stop after the health target is met or after two consecutive
  accepted products move health by less than 10%.
- **Validation command and expected output**:
  the Plan 6 ledger's Scoreboard shows before/current/target for health after
  each accepted product and explicitly lists rejected product candidates.
- **Testability design**: same as 6.3.2 per product.
- **Why safe in this order**: this prevents turning Plan 6 into unbounded cache
  accumulation when the measured bottleneck has moved elsewhere.

## Phase 6.4 - Monorepo correctness and workspace invalidation

### 6.4.1 - Build workspace cache-staleness fixtures

- **File anchor and current behavior**:
  `tests/reindex/reindex-reliability.test.ts` covers per-language shard reuse
  and TypeScript workspace shards; `tests/resolution/workspace-package-import-resolver.test.ts`
  covers workspace package import resolution. Current project-fingerprint use
  is anchored by `node dist/cli.js plan-context projectEvidenceFingerprint
  --json --full`.
- **Exact change**: add fixtures where `apps/app` depends on
  `packages/shared`, then mutate `packages/shared` and prove dependent cached
  products miss or recompute when their evidence depends on cross-package facts.
  Cover at least definition catalogs, file dependency graph, semantic
  references, and any product added in 6.3.
- **Validation command and expected output**:
  `npm test -- tests/reindex/reindex-reliability.test.ts tests/resolution/workspace-package-import-resolver.test.ts tests/storage/evidence-cache.test.ts`
  passes with new tests that fail if shared-package edits leave dependent
  evidence hot.
- **Testability design**: temp monorepo fixture; product reads use planted rows
  and controlled metadata, not real benchmark repos.
- **Why safe in this order**: before making caches faster across checkouts or
  commits, prove they are correct across workspace dependency boundaries.

### 6.4.2 - Add workspace/package identity to project-shaped products where needed

- **File anchor and current behavior**:
  `projectEvidenceFingerprint()` currently hashes reindex metadata fingerprint
  plus sorted indexed languages; source `node dist/cli.js plan-context
  projectEvidenceFingerprint --json --full`.
- **Exact change**: only if 6.4.1 finds a miss, extend the relevant key
  composition with workspace/package dependency identity, not a blanket global
  version bump. Update the manifest and invalidation doc for every changed
  product.
- **Validation command and expected output**:
  the failing 6.4.1 fixture turns green, existing evidence-product tests still
  pass, and a benchmark run shows no measurable regression on scip-query.
- **Testability design**: key-composition helper takes metadata and workspace
  package facts as plain objects; fixtures assert equality and inequality.
- **Why safe in this order**: this step is gated by a demonstrated correctness
  hole; avoiding a blanket fingerprint expansion protects existing warm paths.

## Phase 6.5 - Reindex proportionality

### 6.5.1 - Measure what `reindex` is proportional to

- **File anchor and current behavior**:
  `handleBench()` can measure cold and warm index runs; source `node dist/cli.js
  plan-context handleBench --json --full`. The seed states shard reuse is
  already 0.4s-0.8s on Vega, but cold `reindex` remains 29.8s.
- **Exact change**: extend the Plan 6 harness with single-file edit scenarios:
  edit one TypeScript file in one workspace package, edit one shared package
  file, edit one Python/non-TS file, edit config, and edit nothing. Record
  changed file count, indexed language shards rerun, child indexer commands,
  duration, and output index metadata fingerprint.
- **Validation command and expected output**:
  the ledger contains a `Reindex proportionality` table for all three repos
  with at least five scenarios and exact shard reuse/rerun labels.
- **Testability design**: harness scenario construction is pure; real repo
  edits must use temporary copies or targeted generated files that are deleted,
  never dirty benchmark repos silently.
- **Why safe in this order**: per-file indexing cannot be designed until the
  current proportionality boundary is known.

### 6.5.2 - Add shard-reuse diagnostics

- **File anchor and current behavior**:
  `tests/reindex/reindex-reliability.test.ts` expects messages like
  `Reusing cached python SCIP shard` and TypeScript workspace shard indexing.
- **Exact change**: add structured `--json` diagnostics to `reindex` or the
  benchmark index records showing each language/workspace shard, whether it was
  reused, why it missed, input fingerprint, output size, duration, and indexer
  command. Keep human output compatible.
- **Validation command and expected output**:
  `node dist/cli.js reindex --json` exits 0 and includes a `shards` array; the
  existing human `node dist/cli.js reindex` smoke still prints readable status.
- **Testability design**: indexer runner returns shard diagnostics as data;
  tests use fake indexers where possible.
- **Why safe in this order**: diagnostics are a prerequisite for any per-file
  unlock and are useful even if per-file indexing is rejected.

### 6.5.3 - Per-file TypeScript indexing feasibility gate

- **File anchor and current behavior**: the exact reindex TypeScript worker
  files must be anchored with `node dist/cli.js plan-context <symbol> --json
  --full` after 6.5.2 shows which shard dominates.
- **Exact change**: run a feasibility experiment in a throwaway branch or
  temporary patch only: can scip-typescript or the current augmentation path
  update a single file while preserving cross-file references and symbol IDs?
  Do not ship a partial implementation. The deliverable is either a small
  accepted implementation with output identity proof or a BLOCKED note with
  commands proving the upstream boundary.
- **Validation command and expected output**:
  on a single-file edit in Vega workspace mode, either `reindex` reaches the
  cold target while `refs`/`dead`/`diff-gate` output identities are preserved,
  or the ledger records the exact upstream constraint and the plan moves to
  cross-checkout cache sharing instead.
- **Testability design**: if implemented, isolate file-delta planning as a pure
  module and run compiler/indexer effects through injected runners.
- **Why safe in this order**: this is a possible one-way-door architecture
  change; it is gated until diagnostics prove the target and feasibility.

## Phase 6.6 - Cross-checkout and retro-gate reuse

### 6.6.1 - Measure retro-gate cache identity

- **File anchor and current behavior**: the seed says retro-gate is about
  36s/commit because reindex-per-commit dominates and cache dirs key on project
  root path. Current storage opens `evidence.db` next to `index.db`; source
  `node dist/cli.js plan-context src/storage/evidence-cache.ts --json --full`.
- **Exact change**: add a retro-gate replay mode to the Plan 6 harness that
  checks out or copies five commits without using destructive commands on the
  user's tree. Record which cache directory was used, cold/warm index time,
  evidence rows reused, command output hash, and per-commit wall time.
- **Validation command and expected output**:
  the ledger contains five retro-gate rows with per-commit timing and a clear
  attribution of index time versus command time.
- **Testability design**: dry-run mode emits the sequence of worktree paths and
  commands without executing them.
- **Why safe in this order**: cross-checkout sharing is risky; measure the
  workload before changing cache location or identity.

### 6.6.2 - Design content-addressed cache sharing as a gated step

- **File anchor and current behavior**:
  `evidence.db` currently lives beside the active project's `index.db`; source
  `node dist/cli.js plan-context src/storage/evidence-cache.ts --json --full`.
- **Exact change**: if 6.6.1 proves root-path identity is the retro-gate cost,
  add a design doc section and gated implementation plan for a shared
  content-addressed evidence store. The first shipped step, if any, must be
  read-through only: current project evidence DB remains authoritative, shared
  store can satisfy reads only when content/project/git keys match exactly, and
  writes still populate the local DB.
- **Validation command and expected output**:
  planted-stale tests prove branch/worktree/clone mismatches miss; retro-gate
  median improves toward <= 12s/commit; disabling the shared store with an env
  var restores the old path.
- **Testability design**: shared-store path resolver and key matching are pure;
  SQLite effects injected; no global state outside a configured cache dir.
- **Why safe in this order**: read-through sharing is reversible and preserves
  the existing local evidence DB as the migration path.

## Phase 6.7 - Analysis-budget retirement check

### 6.7.1 - Identify caps that now hide avoidable work

- **File anchor and current behavior**:
  `src/runtime/cli-support.ts` exposes `commandAnalysisBudget()` and
  downstream command handlers print `analysisBudget`; source
  `node dist/cli.js plan-context runIsolatedHealthReport --json --full` shows
  health has its own CLI path, and `rg` shows `analysisBudget` consumers across
  runtime query commands.
- **Exact change**: add a ledger table listing every command that emits
  `analysisBudget` on large indexes, the cap applied, whether Plan 6 caches
  make the cap unnecessary, and the output/timing difference between capped and
  `--full` modes.
- **Validation command and expected output**:
  on Vega_2.0, each listed command has capped and full timings plus output hash
  or documented expected output difference.
- **Testability design**: ledger-only unless a command lacks disclosure; any
  disclosure fix gets a focused CLI contract test.
- **Why safe in this order**: budget removal changes user-visible work volume;
  it must be driven by evidence after cache improvements, not optimism.

### 6.7.2 - Remove or retune only caps proven obsolete

- **File anchor and current behavior**: exact command handler anchors are chosen
  from 6.7.1 using `node dist/cli.js plan-context <handler> --json --full`.
- **Exact change**: for each obsolete cap, either raise/remove the cap or keep
  it and update docs with the reason. Each command is a separate commit.
- **Validation command and expected output**:
  capped/default command output change is either absent or explicitly approved;
  full command timing stays within the Plan 6 target envelope.
- **Testability design**: CLI contract tests assert the disclosure field and
  option behavior.
- **Why safe in this order**: this is intentionally late because it changes the
  amount of analysis users see by default.

## One-way doors and migration paths

- Per-file TypeScript indexing is a one-way door if it changes index assembly.
  Migration path: keep current shard-level indexing as the default and guard any
  file-level mode behind an opt-in config until it proves output identity across
  Vega and Stable_Management.
- Cross-checkout shared caches are a one-way door if they change default cache
  location. Migration path: ship as read-through/off-by-env first; keep local
  `evidence.db` authoritative; only promote writes after stale-row tests cover
  branch, worktree, clone, workspace, language-set, config, and git-history
  mismatches.
- Removing analysis caps changes default user-visible output. Migration path:
  one command at a time, with explicit output contract and release note.

## DEFER list

- Do not optimize `similar` sibling-helper saturation here; it is an accuracy
  follow-up, not primarily a performance architecture item.
- Do not implement hub-file doc-reference damping here; it is volume/UX policy.
- Do not rewrite health into a single long-lived daemon unless all persistent
  evidence-product paths are exhausted and a separate user-approved plan exists.
- Do not replace scip-typescript or fork upstream indexers in this plan.
- Do not add bespoke command-local caches when an evidence product can express
  the same identity.

## Handoff probes

For every implementation handoff, the conductor must reproduce the worker's
claim with the smallest discriminating probe:

- Harness/report changes: run one local command and inspect the appended JSONL
  row.
- Manifest/invalidation changes: run the planted-stale test that would fail if
  a stale row were accepted.
- Evidence-product promotion: clear only the relevant evidence rows, run the
  target command once cold and once warm, compare stdout hashes, and confirm
  profile hit/miss metadata.
- Reindex changes: run no-edit, single-file edit, shared-package edit, and
  config-edit scenarios; confirm shard diagnostics explain every rerun.
- Retro-gate changes: replay at least five commits and report median plus each
  per-commit row; do not accept an average alone.
- Analysis-budget changes: compare default and `--full` outputs and timings on
  Vega before changing defaults.

## Final verification

The program closes only after all accepted steps have ledger entries and these
commands pass from this repo:

```bash
npm run typecheck
npm run lint
npm test
npm run build
node dist/cli.js reindex
node dist/cli.js diff-gate --json
```

Then rerun the Plan 6 harness on all three benchmark repos and update the
Scoreboard with before/current/target values, output hashes, cache-row deltas,
and accepted/rejected changes.

## Self-report for this written plan

- Conductor law 1: verifier design is explicit. The plan requires planted-stale
  cache rows before trusting invalidation, and each implementation handoff has
  a discriminating probe. Observed while writing: `node dist/cli.js
  status --capabilities` reported the local index exists but is stale, so final
  verification must reindex after this doc edit.
- Conductor law 2: each step includes file anchor/current behavior, exact
  change, validation command with expected output, testability design, and why
  the step is safe in order.
- Conductor law 3: open decisions are ledgered as gated steps or DEFER items;
  no cache sharing, per-file indexing, or cap removal is silent.
- Pre-registered benchmarks: seed before values are recorded in the benchmark
  table; after values are intentionally `not run` because Plan 6 implementation
  has not started.
- Handoff probes observed while writing: read `conductor` and
  `scip-hyper-optimization` skills; inspected seed plan; ran scip-query
  plan-context probes for `evidence-cache.ts`, `handleBench`, `healthPhases`,
  `runIsolatedHealthReport`, `buildFileDepGraph`,
  `projectEvidenceFingerprint`, and `sourceImportFingerprint`.
- Deviation ledger: `definitionCatalog` was an imprecise symbol lookup during
  plan writing and returned suggestions instead of a resolved symbol; the
  `.mjs` evidence-contract script is also not indexed. The plan therefore
  requires executors to re-anchor exact product owners with
  `plan-context <chosen-symbol>` before editing and labels the script anchor as
  direct file inspection.
- DEFER list: present above.
- Learnings folded back: the seed's open questions are now executable phases
  with acceptance targets, invalidation tests, cache identity documentation,
  monorepo fixtures, reindex proportionality diagnostics, and retro-gate probes.
