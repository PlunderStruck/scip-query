# Exact Incremental TypeScript Reference Fragments

Date: 2026-07-10
Mode: CAMPAIGN
Status: Core optimization complete; incremental producer follow-ups pending

## Goal

Reduce Vega_2.0's cache-empty `dead --json --full` runtime from 36,940ms
toward 8-12 seconds without restoring the 17 false-positive findings produced
by the current inverted reference scan. Then make the parity-proven file-owned
reference facts reusable and incrementally replaceable so an ordinary edit does
not require another whole-project compiler reference pass.

The original output contract was 6,299 findings for the recorded Vega snapshot.
The implementation was accepted on the later active-worktree snapshot only
after the precise oracle and fragment path both returned the same 6,297
findings (140 dead-code, 6,157 file-internal), the same 5,838,139-byte JSON, and
SHA-256 `06916977b69d5a33e4191be8e19d9da7b26146046beed57cf008db6dabc71c61`.

## Current State

- **Source:** `scip-query status --capabilities --json`; the scip-query index is
  fresh and TypeScript semantic/compiler verification is available.
- **Source:** `scip-query plan-context TsMorphSemanticProvider --json`; the
  provider has command/session-local reference caches, a precise per-definition
  path, and an inverted file scan. The file has six external consumers and
  co-changes most strongly with `src/semantic/types.ts`.
- **Source:** `scip-query code 'src/semantic/typescript/ts-morph-provider.ts:204-283'
--json`; exact mode skips the inverted scan, groups 6,353 Vega definitions by
  definition file, and invokes `referencesForDefinitionNode()` for every miss.
- **Source:** `scip-query code semanticReferencesForNode --json`; each precise
  lookup invokes ts-morph `findReferences()` and filters only the definition's
  own range.
- **Source:** the profiled Vega record in
  `docs/benchmarks/runs/2026-07-10-vega-dead-cold.jsonl`; 905 definition-file
  spans consumed 32,913ms inside a 36,940ms unprofiled command.
- **Source:** `scip-query code referencesForDefinitionsBySymbolScan --json` and
  `scip-query code addReferencesFromSourceFileScan --json`; the fast path scans
  each origin file once, resolves identifier compiler symbols, maps those
  symbols to indexed definitions, and stores references by target symbol.
- **Source:** exact-versus-bulk Vega output comparison recorded in the run
  history; the fast path produced 17 additional findings and no exact-only
  findings. All 17 are override/lifecycle-shaped class methods, including
  `buildTurnState`, `getToolSpecs`, `snapshotDomainState`, and
  `componentDidCatch`.
- **Source:** `scip-query code referenceFragmentsForFiles --json` and
  `scip-query code materializeTypeScriptReferenceFragments --json`; a file-owned
  fragment product already exists, is keyed by transitive TypeScript semantic
  identity, replaces missing file entries in batches, and currently derives
  its facts from the incomplete inverted scan.
- **Source:** `scip-query code planTypeScriptIncrementalUpdate --json` and
  `scip-query code tryMaterializeTypeScriptIncrementalIndex --json`; incremental
  SCIP documents already use changed-file plus dependency-closure planning and
  fragment generations, but eligibility currently rejects multi-project
  workspaces such as Vega. Vega still reuses unchanged project shards while
  rebuilding changed TypeScript project shards wholesale.

## Reuse Audit

- Extend `referencesForDefinitionsBySymbolScan()` rather than adding another
  source traversal. It already owns compiler symbol resolution, source-file
  iteration, deduplication, and profiling cardinality.
- Reuse `definitionNodesForFile()`, `compilerCheckerForSourceFile()`, and
  `definitionFromCompilerSymbol()` for hierarchy evidence; do not introduce a
  second indexed-definition matcher.
- Reuse `compareReferenceFragmentMaps()` as the pure parity oracle and
  `recordTypeScriptReferenceFragmentShadow()` as the persistent shadow record.
- Reuse the existing `file:typescript-reference-fragments` evidence product and
  its transitive semantic identity. A new cache table or command option is not
  justified.
- Reuse the TypeScript document emitter's affected-file request and generation
  lifecycle if fragments are promoted after parity. Do not couple semantic
  fragments into SQLite publication until the scan itself is exact.
- A small provider-private hierarchy augmentation is justified because no
  existing symbol maps compiler override families to indexed definitions; raw
  identifier symbols intentionally distinguish base and overriding methods.

## Testability Design

| Behavior                                              | Test seam                                                                    | Dependencies to inject                     | Pure core                                          | Side-effect shell                             | Contract                                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| Base and overriding methods share reference liveness  | `TsMorphSemanticProvider.referencesForDefinitions()` on a multi-file fixture | fixture DB, tsconfig, source files         | compiler-symbol family grouping and pair recording | ts-morph project and SQLite definition lookup | inverted result equals precise `findReferences()` for override definitions              |
| Fast scan stays exact across a real corpus            | CLI JSON symbol/kind set comparison                                          | Vega snapshot and fresh index              | set difference                                     | CLI/compiler process                          | zero exact-only and zero scan-only findings                                             |
| File fragments become authoritative only after parity | `compareReferenceFragmentMaps()` and shadow result                           | fragment product and semantic identity     | reference fact-set comparison                      | evidence cache reads/writes                   | promotion requires zero missing and zero extra facts                                    |
| Changed files replace only their owned facts          | reference-fragment materializer fixture                                      | file identities and fake provider          | fragment assembly/inversion                        | evidence product batch write                  | unchanged fragments are reused; changed/deleted origin facts cannot survive             |
| Multi-project shards update by affected project       | incremental eligibility tests                                                | snapshots, dependency graph, project roots | per-project change partition                       | index requester and generation store          | unchanged projects reuse; each eligible changed project emits only its affected closure |

## Design Phases

### 1. Add compiler hierarchy evidence to the existing inverted scan

- [x] **File:** `src/semantic/typescript/ts-morph-provider.ts`
- **Source:** `scip-query code referencesForDefinitionsBySymbolScan --json`,
  `scip-query code addReferencesFromSourceFileScan --json`, and
  `scip-query code definitionFromCompilerSymbol --json`.
- **What:** Identifier resolution maps an override declaration to its own
  compiler symbol. Precise `findReferences()` also relates base, derived, and
  sibling overrides, so the inverted scan misses liveness that occurs only
  through virtual dispatch or framework lifecycle contracts.
- **Change:** During the same provider pass, group requested class/interface
  member definitions by their canonical compiler base-member symbol. Add other
  project-local declarations in the same hierarchy family as semantic
  reference locations, then dedupe through the existing result loop. Use Maps,
  Sets, cached checker/node access, and allocation-free hot loops in accordance
  with the repository TypeScript performance rules.
- **Testability:** The compiler fixture is the seam; hierarchy grouping remains
  provider-private and deterministic, while ts-morph/SQLite remain the
  side-effect boundary. The returned reference map is unchanged.
- **Validation:** focused TypeScript semantic tests must show inverted/precise
  equality for base, derived, sibling, and unrelated same-name methods.
- **Why:** This repairs the measured accuracy gap without repeating 6,353
  project-wide `findReferences()` queries.

### 2. Prove parity before changing production selection

- [x] **Files:** focused TypeScript semantic tests and
      `docs/benchmarks/runs/2026-07-10-vega-dead-cold.jsonl`
- **Source:** `scip-query code compareReferenceFragmentMaps --json` and the
  existing exact/bulk Vega records.
- **Change:** Run the augmented inverted scan in a diagnostic build and compare
  complete symbol/kind sets against the exact CLI control. Record wall time,
  scan span cardinality, stdout bytes/hash, and set differences.
- **Testability:** Pure set comparison decides acceptance; CLI processes are the
  shell. No tolerance is allowed for output drift.
- **Validation:** zero exact-only and zero scan-only findings on scip-query and
  Vega. Vega's unprofiled cache-empty runtime is 13.81 seconds; this misses the
  stretch target by 1.81 seconds but removes 23.13 seconds / 62.6% from the
  36.94-second precise control.
- **Why:** Historical scan speed is useful only after exactness is demonstrated.

### 3. Route exact batches through the parity-proven scan

- [x] **Files:** `src/semantic/shared-primitives.ts`,
      `src/semantic/typescript/ts-morph-provider.ts`, and exact caller consumers
- **Source:** `scip-query code exactSemanticCallerMap --json` and
  `scip-query call-graph exactSemanticCallerMap --json`.
- **Change:** Preserve the `exact` provider contract while allowing the
  parity-proven inverted implementation to satisfy it. Keep the old precise
  path available as a shadow oracle/fallback until external corpus parity is
  durable.
- **Testability:** Provider exact mode remains the seam; injected strategy or
  internal shadow selection must not leak to CLI options. The CLI result is the
  stable contract.
- **Validation:** focused tests plus exact CLI hashes on scip-query and Vega.
- **Why:** Callers should request truth, not choose an algorithm.

### 4. Promote exact caller-file fragments

- [x] **Files:** `src/semantic/typescript/reference-fragments.ts`,
      `src/semantic/typescript/reference-fragment-shadow.ts`, and
      `src/semantic/shared-primitives.ts`
- **Source:** `scip-query code referenceFragmentsForFiles --json`,
  `scip-query code materializeTypeScriptReferenceFragments --json`, and
  `scip-query refs referenceFragmentsForFiles --json`.
- **Change:** Version the fragment payload/identity for exact hierarchy facts
  and let exact caller maps assemble cross-file caller presence from file
  fragments. Missing or uncertain identities fall back to precise computation
  rather than empty facts. Full line/column parity remains diagnostic-only;
  `dead` consumes the narrower caller-file contract that passed on both corpora.
- **Testability:** `compareReferenceFragmentMaps()` is the pure gate; fake
  per-file identities/providers isolate cache I/O. The evidence product is the
  side-effect shell.
- **Validation:** cache miss/fill/hit, changed file, deleted file, and malformed
  fragment tests; cold/warm CLI output equality. Vega cold miss: 13.81s; warm
  hit: 4.16s; both exactly match the precise 6,297-finding output.
- **Why:** File ownership makes invalidation local: replacing one origin file's
  fragment removes its old outgoing facts without rewriting every target.

### 5. Feed fragments from incremental TypeScript emission

- [ ] **Files:** `src/reindex/typescript-document-emitter.ts`, TypeScript index
      protocol/service/requester, fragment generation store, and incremental index
      orchestrator
- **Source:** `scip-query code tryMaterializeTypeScriptIncrementalIndex --json`.
- **Change:** Extend the existing affected-document response to include exact
  reference fragments for the same origin files and commit them under the same
  project/generation identity. Publication must expose either the prior complete
  generation or the next complete generation, never a mixed one.
- **Testability:** Protocol/service fixture injects the document producer;
  generation commit logic stays pure over returned fragments; mailbox and files
  are the shell.
- **Validation:** incremental mailbox, fragment store, and SQLite publication
  tests plus a real one-file edit/revert benchmark.
- **Why:** The compiler already has the affected files loaded while emitting
  SCIP documents; recomputing them in the first query repeats work.

### 6. Extend affected-file updates to multi-project workspaces

- [ ] **Files:** `src/reindex/typescript-incremental-index.ts` and project/index
      service fixtures
- **Source:** `scip-query code planTypeScriptIncrementalUpdate --json`.
- **Change:** Partition the change manifest by discovered TypeScript project,
  plan a dependency closure per changed project, reuse untouched project
  generations, and fall back to a whole project shard for config/add/delete or
  ambiguous ownership. Do not require the workspace root to be the only project.
- **Testability:** Project partition/eligibility is pure over snapshots and
  graphs; requester/publication remain injected shells.
- **Validation:** multi-project tests for one changed project, cross-project
  dependency changes, config changes, additions/deletions, and rollback.
- **Why:** Vega currently reuses unchanged project shards but rebuilds each
  changed shard wholesale; file-level affected updates do not yet apply there.

## Stress-Test Findings

- The exact path's cost is repeated language-service search, not JSON
  serialization or process transport. Rust cannot remove this TypeScript
  compiler work.
- Same-name methods in unrelated classes must never be grouped. Canonical
  compiler base-member identity, not leaf text, is the grouping key.
- A derived declaration may connect through an external framework base symbol.
  Multiple project-local overrides of that external member must share a family
  without persisting dependency-file paths as project references.
- Fragment replacement must be origin-file-owned. Target-owned cache rows make
  deletion/invalidation fan out to every referenced symbol and defeat local
  updates.
- The precise path remains the oracle and fallback until parity is proven on
  both scip-query and Vega. Rollback is strategy selection plus fragment schema
  version, not data migration.
- Compiler object identity is not stable across every ts-morph project view.
  Hierarchy facts therefore use declaration-file/position identities. The
  compiler may also expose interface members that SCIP does not catalog as
  definitions, so those unindexed ancestor symbols participate in the scan.
- Dependency declarations such as React lifecycle members are outside the
  indexed file-owned product and are ignored by `dead`; parity compares the
  project-owned caller-file facts the command can consume.
- Multi-project incremental indexing is a later deployable phase. The exact
  scan and exact fragments must not depend on it to ship safely.

## Execution and Ship Order

1. Implement and unit-test hierarchy augmentation behind the existing scan.
2. Benchmark diagnostic scan parity on scip-query and Vega.
3. If parity fails, keep production exact mode unchanged and refine/reject the
   augmentation. If parity passes, route exact mode through it.
4. Verify and ship the exact cold-computation speedup as a standalone phase.
5. Promote/version caller fragments and verify cache invalidation in the same
   accepted slice.
6. Integrate incremental emission, then extend multi-project eligibility in a
   final independently revertible phase.

## Files

- Create: this plan; reuse the existing Vega run-history JSONL.
- First deployable edit: TypeScript semantic provider and focused semantic
  tests.
- Later edits after parity: fragment product, semantic materializer, TypeScript
  index service/protocol, incremental planner, and their fixtures.
- Delete: none planned.
