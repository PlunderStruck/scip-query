# Structural Optimization Inventory

An architectural optimization is a performance improvement built into a shared
program structure so every command that needs the same fact, traversal, cache, or
pruning rule benefits. It differs from a command-local optimization by making the
fast path a reusable part of the evidence system rather than a clever branch in
one analyzer.

This inventory separates the current optimization work into three groups:

- **Promote now:** repeated enough, stable enough, and already measured.
- **Promote after one more benchmark:** promising, but the shared contract needs
  a focused proof.
- **Keep local:** product-specific policy or a deliberately narrow shortcut.

## Current Structural Primitives

These already count as architectural optimization:

| Primitive | Current home | What it standardizes | Gap |
| --- | --- | --- | --- |
| Persistent evidence cache | `src/storage/evidence-cache.ts` | Content-hash, project-fingerprint, and dependency-digest keyed derived evidence | Payloads are still declared as a union of ad hoc kinds rather than registered evidence products. |
| Per-DB caches | `src/storage/per-db-cache.ts` | Process-local reuse by DB, source text, or single project value | Cache names/invalidation groups are standardized, but cache observability is limited. |
| Cache registry | `src/storage/cache-registry.ts` | `whole-project`, `source-file`, `semantic-provider`, and `definition-catalog` invalidation | Invalidation membership is structural; cache dependency declarations are still informal. |
| Candidate analysis runner | `src/queries/internal/candidate-scan.ts` | Candidate load, scan limit, bulk prepare, evaluate, sort, limit | Missing built-in evidence-product loading, counters, and output-contract profiling. |
| Pairwise profile runner | `src/queries/internal/pairwise-profiles.ts` | Focus-file pair pruning and bounded pairwise comparison | Only covers frontend profile pairwise detectors; similar/source-shape has parallel concepts. |
| Project read model | `src/core/project-index.ts` | Definitions, call maps, caller maps, file deps, source references | Should become the primary consumer of registered evidence products, not bespoke evidence calls. |
| Semantic shared primitives | `src/semantic/shared-primitives.ts` | TypeScript semantic callers/callees/references with batch and persistent cache paths | TypeScript-specific today; other languages need capability-shaped slots even when unavailable. |

## Promote Now

### 1. Evidence Product Registry

Current pattern:

- `source-facts`, `file-definitions`, `definition-exclusions`,
  `doc-path-evidence`, `source-imports`, `source-reexports`,
  `source-fingerprints`, `consumer-file-usage`,
  `react-component-behavior-profiles`, `git-file-adds`, `semantic_callees`,
  and `semantic_references` all repeat the same lifecycle: compute, validate,
  cache, profile, and fall back on bad payloads.

Architectural conversion:

- Add an `EvidenceProduct` registration layer with:
  - name
  - scope: file, symbol, project, git HEAD, project fingerprint
  - persistent key strategy
  - payload validator
  - in-process cache policy
  - invalidation groups
  - batch fill API
  - profile counters
  - capability requirements

Why it should be structural:

- The core invariant is the same everywhere: derived evidence is rebuildable and
  must never make a query fail. The current code relies on each caller remembering
  that contract.

Likely first conversions:

- `source-facts`
- `source-imports`
- `source-reexports`
- `file-definitions`
- `definition-exclusions`
- `doc-path-evidence`

### 2. Source Evidence Facade

Current pattern:

- Source-backed commands repeatedly need source text, AST, identifiers, imports,
  reexports, source facts, source fingerprints, and source-file sets.
- These are individually cached, but command code still chooses the order and
  shape of the reads.

Architectural conversion:

- Introduce a `SourceEvidence` facade that can load per-file source evidence in
  one call and can batch for a set of files.

Possible shape:

```ts
sourceEvidence(db).forFile(file, {
  text: true,
  ast: true,
  imports: true,
  reexports: true,
  identifiers: true,
  facts: true,
  fingerprints: true,
});
```

Why it should be structural:

- The same work shows up in dead code, stale abstractions, wrappers, drift,
  similar/source-shape, doc drift, and diff-gate echo.

### 3. Consumer Evidence Product

Current pattern:

- `definitionConsumerFileMap()`, `partitionDefinitionConsumers()`,
  `consumer-file-usage`, caller maps, source fallback callers, import-only
  consumers, and barrel/reexport filtering are used by stale abstractions,
  wrappers, dead code, locality, complexity, and health phases.

Architectural conversion:

- Promote "consumer evidence" to a reusable product:
  - raw SCIP callers
  - semantic callers when available
  - source fallback callers
  - import-only consumer classification
  - reexport-only/barrel classification
  - provenance per consumer

Why it should be structural:

- Most cleanup detectors ask the same question: "what real files use this
  definition?" They should not each compose caller evidence differently.

### 4. Similarity Fingerprint Products

Current pattern:

- `similar`, `recent-duplicates`, `diff-gate` echo, and incomplete migration all
  rely on callee fingerprints, source fingerprints, candidate indexes, IDF
  weights, and target/focus pruning.

Architectural conversion:

- Create shared products for:
  - callee fingerprint corpus
  - callee fingerprint index
  - source fingerprint corpus
  - source fingerprint index
  - target-specific candidate pruning
  - weighted magnitude caching

Why it should be structural:

- The benchmark ledgers show this area had some of the largest wins, including
  semantic callee caching, stable evidence versions, focus-file pruning, and
  source fingerprint persistence.

### 5. Semantic Evidence Product

Current pattern:

- TypeScript semantic callers/callees/import usage already have shared
  primitives, provider batching, persistent rows, and project fingerprints.

Architectural conversion:

- Treat semantic facts as registered evidence products with explicit capability
  slots:
  - semantic references
  - semantic callers
  - semantic callees
  - semantic import usage
  - semantic signatures

Why it should be structural:

- It would make "semantic unavailable" a normal product state instead of a
  per-command option branch. This matters as non-TypeScript semantic helpers
  arrive.

### 6. Git Evidence Product

Current pattern:

- `git-file-adds`, co-change history, doc drift, recent duplicates, health git
  evidence, and diff-gate co-change all need Git data with different filters.

Architectural conversion:

- Create a `GitEvidence` product family:
  - file add records by HEAD
  - file change timestamps
  - changed-file commit windows
  - co-change pairs for target files
  - tracked/ever-seen file sets

Why it should be structural:

- Git child processes are expensive and the same repository history is parsed
  across several commands.

### 7. Frontend Behavior Profile Products

Current pattern:

- React and Vue profile builders already cache per-file behavior facts, and
  frontend duplicate/composable/large-view checks reuse these shapes.

Architectural conversion:

- Register frontend behavior profiles as evidence products:
  - React component behavior profile
  - Vue component behavior profile
  - Vue template facts
  - Vue script facts

Why it should be structural:

- The profile payloads are pure source-derived evidence. They are useful beyond
  the current frontend duplicate commands and should share validation/caching
  conventions with other file evidence.

## Promote After One More Benchmark

### 8. Candidate Pipeline Contracts

Current pattern:

- `runCandidateAnalysis()` exists, but many commands still hand-roll candidate
  ordering, scan limits, cheap filters, bulk evidence preparation, exact
  refinement, and result shaping.

Architectural conversion:

- Extend the candidate runner into a pipeline:
  - load candidates
  - apply cheap SQL/source filters
  - load evidence products in bulk
  - refine survivors
  - emit standardized profile counters

Why it needs another benchmark:

- The runner must stay small enough not to become a framework tax. Prior
  "bulk-load shared catalog" experiments preserved output but slowed shared
  commands, so this needs proof per detector family.

### 9. Pairwise Comparison Kernel

Current pattern:

- `pairwise-profiles` handles frontend profile pairs. Similarity code has its
  own fingerprint indexes and candidate pruning. Recent duplicates adds
  focus-file pruning on top.

Architectural conversion:

- Generalize a pairwise kernel with:
  - focus files
  - overrun factor
  - candidate index
  - exact scorer
  - output hash checks in benchmark fixtures

Why it needs another benchmark:

- The "iterate smaller set" trial was mathematically equivalent but slower.
  Pairwise structure should be generalized only around measured hot paths, not
  around generic set theory.

### 10. File Dependency Evidence

Current pattern:

- File dependency graphs mix SCIP symbol edges with source import fallback, and
  commands reuse `ProjectIndex.fileDependencyGraph()`.

Architectural conversion:

- Promote file dependency graph to a persistent or semi-persistent evidence
  product keyed by project fingerprint plus source import fingerprints.

Why it needs another benchmark:

- Current in-process caching may be enough for many commands. Persisting it
  would widen cache invalidation and payload size; measure cold/warm impact
  first.

### 11. Health Phase Scheduler

Current pattern:

- Health has budgets, concurrency, isolated phase execution, cache clearing,
  parent-process overview scheduling, and phase grouping.

Architectural conversion:

- Extract a generic `AnalysisScheduler` for composite commands:
  - phase dependencies
  - cache sharing policy
  - process isolation policy
  - concurrency cap
  - task grouping

Why it needs another benchmark:

- Some health scheduling variants were rejected despite preserved output. This
  should not become a general scheduler until another composite command needs it.

### 12. Vue Index Augmentation

Current pattern:

- Vue is not indexed by a standalone `scip-vue` route. `augment-vue` inserts
  `.vue` documents, synthetic component symbols, and Volar-resolved mentions into
  SQLite.

Architectural conversion:

- Treat framework augmentation as a post-index evidence/index augmentation
  stage:
  - discover auxiliary documents
  - create synthetic symbols
  - map generated-language positions back to source
  - insert mentions/ranges/chunks
  - fingerprint DB and source inputs

Why it needs another benchmark:

- This is indexer-like work, and some of it may belong upstream in an indexer.
  The architectural move should first define the boundary between "SCIP indexer
  fact" and "scip-query post-index augmentation."

## Keep Local For Now

### 13. Detector-Specific Policy Knobs

Examples:

- `includePatternDeviations` for health drift.
- Recent duplicate echo/twin orientation.
- Wrapper-specific consumer pruning.
- Dead-code skip rules for framework/test/generated shapes.

Why keep local:

- These are product policy decisions, not reusable evidence. They may use shared
  evidence products, but their thresholds and actions should remain near the
  detector that owns the claim.

### 14. Narrow Text Guards

Examples:

- Cheap substring guards before JS/TS framework exclusion regexes.
- Target-bound source fallback in diff-gate echo.
- Source prefilters that only apply to a specific output contract.

Why keep local:

- These are safe because of local output contracts. Generalizing them too early
  risks weakening other analyzers.

### 15. Rejected Micro-optimizations

Examples:

- Smaller-set iteration in `intersection()` / `jaccard()`.
- Pure dispatch batching for semantic references.
- Unfiltered inverted TypeScript reference scans.
- Broad batched `getScopedDefinitions()` replacement.

Why keep local or rejected:

- These preserved some outputs but did not improve real workloads or weakened
  precision. They should stay as ledger lessons, not architecture.

## Priority Backlog

1. **Add `EvidenceProduct` registry.** Convert `source-facts` and
   `file-definitions` first because they already have robust cache contracts and
   many consumers.
2. **Build `SourceEvidence` facade.** Route imports, reexports, identifiers,
   facts, and source fingerprints through it.
3. **Promote consumer evidence.** Make "real consumer" classification a shared
   product with provenance.
4. **Unify similarity fingerprints.** Pull callee/source fingerprint corpus and
   index construction behind product APIs.
5. **Register semantic evidence products.** Keep TypeScript as the only provider
   initially, but make capability absence first-class.
6. **Register Git evidence products.** Start with file-add records and changed
   file co-change windows.
7. **Only then revisit scheduler and Vue augmentation.** These are bigger design
   moves and should wait until the evidence-product layer exists.

## Acceptance Criteria For Any Conversion

- The new primitive has one owner module and no analyzer-specific assumptions in
  its cache key.
- The payload has a validator and a fallback-to-recompute path.
- The old command output is byte-identical on representative corpora.
- Cold fill, warm reuse, and mixed-cache timings are recorded.
- The primitive reports profile counters: inputs, hits, misses, writes, rows,
  files, and skipped unsupported capabilities.
- `scip-query diff-gate --json` stays clean.
