# Incremental Performance and Setup Closure

Date: 2026-07-11
Status: Complete

## Goal

Close the remaining user-visible and computational gaps in automatic
incremental indexing. A terminal user running `scip-query setup` must receive
an interactive, arrow-key-driven review before expensive work begins; selected
projects must actually enable the demand-started service; TypeScript incremental
publication must reuse exact file-owned reference fragments and work across
multiple project roots; and the Rust SCIP producer boundary must either ship a
parity-proven affected-document route or retain a measured, explicit upstream
fallback decision.

Done is falsifiable:

- an interactive PTY test proves arrow navigation, toggling, confirmation, and
  terminal restoration;
- non-interactive and JSON setup remain deterministic and never wait for input;
- Vega_2.0 reports automatic indexing enabled and can use affected-document
  publication without changing its existing unrelated dirty files;
- TypeScript document and reference-fragment generations change atomically and
  match clean compiler oracles;
- a multi-project fixture updates one owned project without rebuilding an
  unrelated project and falls back on ambiguous/cross-project changes;
- Rust feasibility is decided by an executable probe against the installed
  rust-analyzer boundary, with output parity and end-to-end timing required for
  acceptance; and
- focused tests, full tests, typecheck, lint, build, reindex, diff-gate, package
  smoke, and benchmark histories are green.

## Current State

- `scip-query status --capabilities` reports a fresh local index. Its latest
  generation is already incremental: one changed file produced 36 affected
  documents, then a mini conversion and atomic SQLite patch. The sub-shard
  mechanism exists and is not being designed from scratch.
- Vega_2.0 originally had `watch.enabled: false`; the verified setup pass now
  persists `watch.enabled: true` and `watch.autoRefresh: true` while retaining
  its four-project TypeScript workspace (`apps/api`, `apps/web`,
  `packages/shared`, `packages/companion`). Setup started the demand-driven
  service and a no-op refresh reused both cached language shards.
- `scip-query plan-context handleSetup --json` resolves the setup entry to
  `src/runtime/commands/command-handlers.ts`. `handleSetup()` only invokes the
  guided path when `--guided` is explicitly supplied. The current guided path
  is sequential text `Y/n`, while ordinary setup begins indexing and health
  work without rendering progress.
- `scip-query plan-context tryMaterializeTypeScriptIncrementalIndex --json`
  resolves the single consumer in `runLanguageIndexersForFreshReindex()` and
  identifies `typescript-incremental-index.ts` as a medium-risk publication
  boundary.
- `planTypeScriptIncrementalUpdate()` explicitly rejects workspace mode unless
  the only project root is `.`. This is why Vega_2.0 cannot use the file-level
  producer despite having project-shard reuse.
- Exact TypeScript reference fragments are already authoritative for caller
  maps and have file-owned identities, but the document mailbox returns only
  SCIP document bytes. A later semantic query recomputes missing fragments.
- The installed rust-analyzer SCIP route constructs one complete `StaticIndex`;
  prior package inspection found no CLI or LSP affected-document output.
  Durable rust-analyzer semantics are a separate product and do not satisfy an
  incremental SCIP claim.

## Pre-Registered Measurements

| Workload                                        |                                                    Baseline | Acceptance                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local affected-document generation              |             latest status: 511 ms producer for 36 documents | no regression over 10% on the same fixture; exact parity                                                                                           |
| Local complete incremental publication          |        latest status: 376 ms mini conversion + 239 ms patch | remains below the accepted 2 s edit-to-fresh gate                                                                                                  |
| Vega exact TypeScript caller fragments          |                  13.81 s cold / 4.16 s warm, 6,297 findings | unchanged output; incremental emission avoids a later changed-file recomputation                                                                   |
| OpenCode multi-project warm document production | 2.325 s median / 2.803 s p95 in the accepted Phase 4 corpus | one-project edits reuse unrelated projects and meet the existing 5 s large-corpus gate                                                             |
| Rust affected-document output                   |                  unavailable at installed upstream boundary | accept only if a probe proves exact normalized parity and an end-to-end win; otherwise record the upstream boundary and retain full-shard fallback |
| tsserver comparison                             |                       previously slower with 110 mismatches | no migration unless a renewed profile proves parity and a material speed win                                                                       |

Machine measurements are appended to
`docs/benchmarks/runs/2026-07-11-incremental-performance-closure.jsonl`.

## Reuse Audit

- Extend `planGuidedProjectSetup()` and `runProjectSetup()`; do not create a
  second setup workflow.
- Add one small terminal checklist module because no prompt dependency exists
  and setup needs a directly testable key/state boundary. Reuse Node readline
  keypress decoding and inject terminal I/O for tests.
- Extend the existing TypeScript index mailbox protocol, document emitter,
  fragment evidence product, and generation coordinator. Do not create another
  compiler session or reference resolver.
- Extend `discoverTypeScriptProjectRoots()`, existing project-shard ownership,
  and `planAffectedFiles()` for multi-project partitioning. Preserve current
  whole-project fallback whenever ownership is ambiguous.
- Probe rust-analyzer's installed SCIP/library boundary before proposing a new
  producer. Durable semantic caches and the TypeScript emitter are not valid
  substitutes for Rust compiler-produced SCIP documents.
- Keep ts-morph and TypeScript implementations unless the existing profiler
  establishes a concrete isolated span for a native replacement.

## Testability Design

| Behavior                    | Test seam                                  | Dependencies to inject                           | Pure core                                       | Side-effect shell               | Contract                                                            |
| --------------------------- | ------------------------------------------ | ------------------------------------------------ | ----------------------------------------------- | ------------------------------- | ------------------------------------------------------------------- |
| Setup selection             | terminal checklist state reducer           | key stream, writer, raw-mode controller          | cursor/toggle/confirm transition                | TTY keypress loop               | defaults visible; Enter confirms; Ctrl-C restores terminal          |
| Setup execution             | `runProjectSetup()` options                | readiness, config writer, reindex, health runner | selected option mapping                         | files/processes/service         | deselected health/indexers/hooks perform no work                    |
| Reference emission          | document emitter advance result            | compiler runtime and source files                | occurrence-to-file-owned-fragment projection    | compiler program/FileIndexer    | exact fragment for every affected file, including empty replacement |
| Atomic fragment publication | mailbox/requester + evidence product batch | mailbox and generation store                     | response validation and identity mapping        | atomic JSON/cache writes        | documents and semantic fragments bind to one generation or neither  |
| Multi-project update        | project ownership/partition planner        | project roots, snapshots, dependency graph       | changed-project partition and fallback decision | one emitter session per project | unrelated project reused; ambiguity widens/falls back               |
| Rust feasibility            | installed-boundary probe                   | rust-analyzer binary/library and fixture         | normalized document/fact parity                 | child process/compiler          | no partial route accepted without exact parity                      |

## Design Phases

### 1. Make setup an interactive wizard by default

- [x] **Files:** `src/runtime/setup-wizard.ts`,
      `src/runtime/commands/command-handlers.ts`,
      `src/runtime/commands/command-descriptors.ts`,
      `src/runtime/project-setup.ts`, focused runtime/CLI tests and command docs.
- **Source:** `scip-query plan-context handleSetup --json` and
  `scip-query change-surface src/runtime/commands/command-handlers.ts --json --full`.
- **Change:** In a human TTY, default `setup` to a single arrow-key checklist
  covering detected language/indexer support, automatic refresh, hooks, agent
  guidance, user skills/indexer remediation, and optional initial health.
  `--yes` explicitly accepts recommended defaults; `--guided` remains a
  compatibility alias; `--json` and non-TTY execution never prompt. Stream
  progress before reindex and health so setup cannot appear hung.
- **Validation:** PTY/key reducer tests must first prove a planted incorrect
  default fails; CLI contract/help tests; `setup --json` non-interactive smoke.
- **Why:** Correct incremental machinery is irrelevant when onboarding silently
  preserves a disabled service and hides long work behind a blank terminal.

### 2. Enable and verify Vega_2.0 automatic indexing

- [x] **Files:** Vega_2.0 `.scipquery.json` only; checkout-local hook files only
      if selected. Preserve every unrelated dirty path.
- **Source:** `scip-query status --capabilities` in Vega_2.0 and guided setup
  plan output.
- **Change:** Run the new deterministic recommended setup path with health
  skipped for the enablement pass, then verify service idle/wake and config.
- **Validation:** status reports enabled/running-or-clean-idle, config validates,
  one no-op refresh reuses artifacts, and no unrelated Vega file changes.
- **Why:** This is the user's concrete broken repository and the first real
  onboarding acceptance test.

### 3. Return exact reference fragments with affected TypeScript documents

- [x] **Files:** TypeScript document emitter, index protocol/service/requester,
      reference-fragment product, incremental coordinator, and focused tests.
- **Source:** `scip-query plan-context tryMaterializeTypeScriptIncrementalIndex
--json` and `scip-query code referenceFragmentsFromDefinitionMap`.
- **Change:** Derive file-owned reference fragments from the same compiler
  program/SCIP occurrences used for affected document emission, version the
  mailbox response, validate a fragment entry for every affected file, and
  atomically write them using the next semantic identity after publication.
  Empty files replace prior rows with an empty fragment.
- **Validation:** clean precise-provider parity, edited/deleted reference
  fixture, malformed/omitted response rejection, and changed-file cache-hit
  proof on the next semantic query.
- **Why:** The compiler already resolved these references during document
  emission; recomputing them afterward repeats the expensive work.

### 4. Extend affected-file publication to multi-project TypeScript workspaces

- [x] **Files:** `src/reindex/typescript-incremental-index.ts`, project-root and
      shard helpers, protocol/service session ownership, and multi-project tests.
- **Source:** `scip-query plan-context planTypeScriptIncrementalUpdate --json`.
- **Change:** Assign indexed/source files to discovered project roots, partition
  the manifest and dependency closure by project, update only changed project
  emitters, reuse untouched project generations, and combine affected
  documents into the existing atomic SQLite publication. Config changes,
  add/delete, overlapping ownership, and cross-project ambiguity fall back to
  existing project/whole-language rebuilds.
- **Validation:** two-project edits, cross-project consumer changes, overlapping
  configs, add/delete/config fallback, crash rollback, and OpenCode/Vega parity
  benchmarks.
- **Why:** This unlocks the already-built sub-shard producer for Vega_2.0's
  actual four-project configuration.

### 5. Decide and implement the Rust SCIP boundary

- [x] **Files:** feasibility probe and benchmark records first; production Rust
      code only if the probe passes.
- **Source:** installed rust-analyzer package/binary inspection plus
  `scip-query plan-context src/reindex/indexers.ts --json`.
- **Change:** Test whether the installed compiler/library exposes a stable
  per-file `StaticIndex`/SCIP document boundary. If yes, wrap it behind the
  existing one-writer generation coordinator with full-shard fallback. If no,
  record the upstream API requirement and close the item as an evidence-backed
  product limitation rather than simulating incremental output from LSP facts.
- **Validation:** edited Rust fixture normalized against a clean full SCIP
  oracle, add/delete/config fallback, package matrix, and timing. No production
  route lands without exact parity.
- **Why:** A false incremental claim is worse than an honest whole-shard
  fallback; the compiler output boundary decides feasibility.

### 6. Renew tsserver and native-kernel decisions

- [x] **Files:** benchmark JSONL/ledger; production code only for an accepted
      candidate.
- **Source:** current profiler/work-audit and prior mismatch records in the
  indexing-analysis ledger.
- **Change:** Profile the post-Phase-4 system. Re-run tsserver parity only if
  TypeScript project/reference work remains dominant. Profile native consumer
  classification only if its isolated CPU span can exceed process/serialization
  overhead. Keep or reject each candidate with measurements.
- **Validation:** alternating-order cold/warm runs and normalized output hashes.
- **Why:** These are conditional optimization ideas, not roadmap obligations to
  add another runtime.

### 7. Close and publish the program evidence

- [x] **Files:** this plan, incremental roadmap, exact-reference follow-up,
      benchmark ledger/JSONL, and required repository records.
- **Source:** final status, benchmark, change-surface, reindex, and diff-gate
  outputs.
- **Change:** Mark shipped, rejected, and externally blocked items explicitly;
  remove obsolete “pending” claims from living roadmaps.
- **Validation:** full suite, typecheck, lint/format, build/declarations, package
  dry-run and packed-install smoke, reindex, diff-gate, and clean worktree.
- **Why:** The result must survive conversation compaction and future setup
  runs without resurrecting closed work.

## Stress and Rollback Rules

- Interactive input is allowed only when both stdin and stdout are TTYs.
  Programmatic setup must never block.
- Terminal raw mode and cursor visibility are restored on success, error,
  interrupt, and end-of-input.
- Setup must show the selected repository/checkout/user scopes before mutation.
- Existing explicit config is preserved except for choices the user selected.
- Incremental publication never mutates the accepted generation in place.
- Every semantic/document response is generation-, producer-, project-, and
  protocol-bound.
- Multi-project uncertainty widens to a project or full rebuild; it never
  guesses ownership.
- Vega_2.0's unrelated dirty files are immutable for this campaign.
- One commit per completed numbered phase; if phase count and commit count
  differ, stop before beginning the next phase.

## Explicit Deferrals

- Public leaderboard work and health-score normalization remain outside this
  performance/setup program.
- A whole-CLI Rust rewrite remains rejected absent a measured boundary.
- Concurrent SQLite writers remain rejected; one generation coordinator owns
  publication.
- Dropping full-shard fallbacks or legacy evidence reads is not part of this
  program.

## Execution Order

1. Ship and commit the setup wizard.
2. Enable and verify Vega_2.0 without touching unrelated work.
3. Ship exact reference-fragment emission.
4. Ship multi-project TypeScript affected-file updates.
5. Run the Rust feasibility gate and implement only a passing boundary.
6. Renew conditional alternatives from the new profile.
7. Reconcile roadmaps, run the full closure gate, and write the conductor
   self-report with before/after measurements, discriminating probes,
   deviations, and deferrals.

## Closure Report

All seven phases are complete. The setup wizard and Vega enablement shipped;
exact TypeScript reference fragments now travel with protocol-v2 affected
documents; single-owned projects in a multi-project workspace publish only
their affected documents; and the Rust affected-document route was rejected
because the installed compiler exposes only a whole-project SCIP output.

The decisive warm Vega edit emitted two `apps/api` documents with 125ms of
compiler-service work, 26ms of conversion, and a 659ms SQLite patch. The local
settled exact-reference read hit 327/327 fragments in 148ms with byte-identical
detector output. Post-change work-audit found zero measured avoidable
milliseconds, so tsserver and another native process remain rejected.

Final verification passed 1,324 tests in 189 files, typecheck, lint/format,
build/declarations, package dry-run, packed installation (`0.15.0`), reindex,
and diff-gate with zero blocking findings. The one advisory cites
`docs/architecture/evidence-cache-invalidation.md`; its statement that
cross-worktree shard-key reuse is out of scope remains accurate because this
program changed neither that key nor that claim.
