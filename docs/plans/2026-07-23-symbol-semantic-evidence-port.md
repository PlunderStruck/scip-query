# Symbols-Owned Semantic-Evidence Port

Date: 2026-07-23

## Goal

Remove every `symbols -> semantic` import while preserving the exact semantic
reference, caller, and callee results; persistent-cache behavior; profiling
spans; public query behavior; and command performance. The resulting dependency
direction must be `semantic -> symbols`: semantic providers may translate
compiler facts into repository symbol identities, while symbol graph code must
not know which provider, engine, or semantic cache produced optional evidence.

## Definitions & Invariants

A **symbol fact** is repository evidence that connects an indexed symbol to a
definition, reference, caller, or callee. What distinguishes it from compiler
machinery is that its identity and merge rules are expressed in the
repository's SCIP-backed symbol model. Referents:
`src/symbols/graph/call-graph-evidence.ts`,
`src/symbols/identifier-attribution.ts`, and
`src/symbols/references/reference-callers.ts`.

A **semantic-evidence port** is a symbols-owned callable contract through which
symbol-fact code can request optional compiler-resolved references, callers,
and callees. What makes it a port is that it describes the facts `symbols`
needs without naming the semantic provider, engine identity, cache key, or
provider lifecycle that produces them. Referents: the current imports reported
by `scip-query imports` for the three symbol files and the proposed
`src/symbols/semantic-evidence-port.ts`.

A **semantic-evidence adapter** is a semantic-owned implementation of that port
which retains provider selection, compiler-engine identity, and persistent
semantic-cache policy. What distinguishes it from a forwarding wrapper is that
it owns the warm-cache scan, miss computation, cache qualification, and cache
writes currently embedded in symbol graph construction. Referents:
`cachedSemanticCalleeMap`, `semanticEvidenceProduct`, and the proposed
`src/semantic/symbol-evidence.ts`.

A **higher-level orchestrator** is query or runtime code that is already allowed
to know both the symbol-fact operation and the semantic implementation, and
therefore can pass the adapter into the port without either lower subsystem
importing the other in both directions. Referents:
`src/queries/internal/project-index.ts`, direct query modules reported by
`scip-query refs`, and `src/runtime/cli-support.ts`.

The slice preserves these invariants:

1. `symbols` must always have zero source imports from `semantic`.
2. Semantic facts are included iff the caller's existing `semantic` option
   enables them and the higher-level caller supplies the production adapter,
   except for the existing bulk-caller behavior documented in P8.
3. A complete persistent semantic-callee cache hit must always return without
   constructing or calling a semantic provider.
4. Cache keys, cache payloads, provider-availability qualification, profiling
   span names, and AST/semantic/chunk merge order must always remain identical.
5. `semantic: false` must always avoid semantic work on paths where it does so
   before this slice; the existing non-targeted bulk-caller behavior must not
   silently change in this behavior-neutral refactor.
6. No new filesystem read, dependency-graph build, hash, provider probe, loop,
   cache, or shared mutable registry may be added.
7. The published `scip-query` and `scip-query/reindex` declaration surfaces
   must remain unchanged.

## Premises

- **P1.** The current architecture has one reciprocal boundary pair:
  `semantic <-> symbols`; `symbols -> semantic` consists of eight file edges
  from three importers to semantic implementation files. Source:
  `node dist/cli.js architecture --json`.
- **P2.** The three importers are
  `src/symbols/graph/call-graph-evidence.ts`,
  `src/symbols/identifier-attribution.ts`, and
  `src/symbols/references/reference-callers.ts`. Their imported semantic
  operations are provider language selection, engine/cache identities,
  definition grouping, semantic references, semantic caller/callee maps, and
  semantic evidence capability. Source:
  `scip-query plan-context <file>`, `scip-query deps <file>`, and
  `scip-query imports <file>` for all three files.
- **P3.** `buildCalleeMap` merges AST evidence first, semantic evidence second,
  and chunk evidence last, deduplicating by symbol and chunk. Source:
  `scip-query code buildCalleeMap`.
- **P4.** `cachedSemanticCalleeMap` first consumes in-memory prefetched rows,
  then scans persistent cache entries, computes only misses, and writes only
  when the corresponding semantic capability is available. Source:
  `scip-query code cachedSemanticCalleeMap`.
- **P5.** The persistent semantic-callee state has one reader,
  `cachedSemanticCalleeMap`, and two writes in that same function: prefetched
  rows and computed misses. Source:
  `scip-query refs readCachedSemanticCalleesForFile` and
  `scip-query refs writeCachedSemanticCalleesBatch`.
- **P6.** `findReferences` prefers semantic reference locations when present
  and otherwise performs its existing source-attribution scan. Source:
  `scip-query code findReferences`.
- **P7.** `buildCrossFileCallerMap` merges AST, SCIP chunk, Rust-attribute, and
  optional semantic caller sets in that order. Source:
  `scip-query code buildCrossFileCallerMap`.
- **P8.** `getCallerRowsMapForSymbols` applies `semantic: false` to the targeted
  path, while its non-targeted path calls the cached whole-project
  `buildCallerRowsMap` without forwarding that option. This asymmetry is
  current behavior and is out of scope to change here. Source:
  `scip-query plan-context src/symbols/graph/call-graph-evidence.ts`.
- **P9.** Direct production consumers exist outside `ProjectIndex`: callee rows
  have six query consumers; caller rows have five query consumers; reference
  sites have five query consumers; bulk caller evidence also flows through
  `caller-evidence.ts`. Source:
  `scip-query refs getCalleeRowsForSymbol`,
  `scip-query refs callerRowsForSymbol`,
  `scip-query refs referenceSitesForSymbol`, and
  `scip-query plan-context src/symbols/references/caller-evidence.ts`.
- **P10.** `ProjectIndex` is a high-fan-in query-owned facade already composing
  symbol graph, caller evidence, source evidence, and storage. Source:
  `scip-query plan-context src/queries/internal/project-index.ts`.
- **P11.** Runtime semantic prewarm directly calls
  `materializeSemanticCalleeCache`; this operation is currently exported from
  the symbol graph file even though it performs only semantic cache/provider
  work. Source: `scip-query refs materializeSemanticCalleeCache` and
  `scip-query code materializeSemanticCalleeCache`.
- **P12.** `SemanticEvidenceProduct` is semantic-owned and broad: it exposes
  capability, import usage, signatures, references, callers, callees, and
  materialization. Importing it from `symbols` would retain the reverse edge,
  so it cannot serve as the symbols-owned port. Source:
  `scip-query surface src/semantic/shared-primitives.ts`.
- **P13.** `call-graph-evidence.ts` co-changes with semantic primitives,
  TypeScript reference-fragment shadowing, and the evidence cache; the first
  and third are structurally linked. Source:
  `scip-query co-change src/symbols/graph/call-graph-evidence.ts --json --full`.
- **P14.** The workspace is fresh with TypeScript and Rust semantic providers
  available before edits. Source: `scip-query status --capabilities`.

## Current State

Symbol graph construction currently owns both symbol-fact merge policy and
semantic provider/cache mechanics (P2-P4). Reference attribution and bulk caller
construction also call the semantic product directly (P6-P7). Semantic
providers import symbol catalogs and parsers to translate compiler identities,
so these three reverse imports produce the repository's final reciprocal
boundary pair (P1).

The persistent cache is particularly sensitive: moving only the provider call
would leave semantic identity and provider-availability knowledge inside
`symbols`, while moving only the types would not break the architectural edge
(P2, P4). The semantic adapter therefore needs to own the complete cache
operation, with `symbols` seeing only returned facts.

## Reuse Audit

| Proposed unit                    | Reuse decision                                                                                                                                                                                                                 | Evidence                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `SymbolSemanticEvidencePort`     | New contract required. Neither `SemanticProvider` nor `SemanticEvidenceProduct` can be reused because both are semantic-owned implementation contracts and importing either preserves `symbols -> semantic`.                   | P2, P12                                                           |
| `symbolSemanticEvidence` adapter | Extend and compose existing semantic primitives; do not duplicate provider algorithms. It will call the existing reference/caller/callee product operations and mechanically relocate the existing durable callee-cache shell. | P4, P5, P12                                                       |
| Semantic result records          | Define the minimal structural reference and callee records beside the port. Do not move or duplicate provider records; TypeScript structural compatibility lets the semantic adapter return its existing records.              | P2, `scip-query imports src/symbols/graph/call-graph-evidence.ts` |
| Query wiring                     | Pass the shared stateless adapter directly. Do not add query wrappers or a global service locator.                                                                                                                             | P9, P10                                                           |

## Testability Design

| Behavior                      | Test seam                                            | Dependencies to inject                  | Pure core                          | Side-effect shell                              | Contract                        |
| ----------------------------- | ---------------------------------------------------- | --------------------------------------- | ---------------------------------- | ---------------------------------------------- | ------------------------------- |
| AST/semantic/chunk merge      | `buildCalleeMap`                                     | `SymbolSemanticEvidencePort` in options | Existing ordered merge/dedupe      | Port's `calleeMap`                             | `SymbolSemanticEvidencePort`    |
| Reference preference/fallback | `findReferences` and `referenceSitesForSymbol`       | Port in options                         | Existing reference materialization | Port's `references`                            | `SymbolSemanticEvidencePort`    |
| Caller-set merge              | `buildCrossFileCallerMap`                            | Port in options                         | Existing set merge                 | Port's `callerMap`                             | `SymbolSemanticEvidencePort`    |
| Warm semantic-callee cache    | `materializeSemanticCalleeCache` in semantic adapter | Existing DB/cache/provider primitives   | Existing miss selection            | Existing cache reads/writes and provider calls | Semantic adapter implementation |
| Production assembly           | Query functions and `ProjectIndex`                   | Shared stateless production adapter     | Existing query decisions           | Semantic provider/cache behind adapter         | Existing query option contracts |

## Implementation Checklist

### 1. Add the symbols-owned port

- [x] **File:** `src/symbols/semantic-evidence-port.ts` (new)
- **Premises:** P1, P2, P12
- **Deployable:** no — part of single-deploy group `semantic-port-inversion`.
- **Change:** Define only the reference, callee, and four operations required by
  the three symbol consumers. Use type-only imports and no implementation state.
- **Validation:** Typecheck and `scip-query deps` show no semantic dependency.

### 2. Move semantic callee-cache authority behind the adapter

- [x] **Files:** `src/semantic/symbol-evidence.ts` (new),
      `src/symbols/graph/call-graph-evidence.ts:329-563`,
      `src/runtime/cli-support.ts`
- **Premises:** P3-P5, P11-P13
- **Deployable:** no — part of `semantic-port-inversion`.
- **Change:** Relocate the existing persistent cache scan, digest construction,
  provider computation, capability qualification, writes, and prewarm export
  without reordering operations or renaming profiling spans. Implement the
  remaining port methods by composing existing semantic primitives.
- **Validation:** Existing TypeScript semantic provider/cache tests; exact cache
  hit regression; runtime prewarm tests; typecheck.

### 3. Make symbol facts consume the port

- [x] **Files:** `src/symbols/graph/call-graph-evidence.ts`,
      `src/symbols/identifier-attribution.ts`,
      `src/symbols/references/reference-callers.ts`,
      `src/symbols/references/reference-sites.ts`,
      `src/symbols/references/caller-evidence.ts`
- **Premises:** P2, P3, P6-P9
- **Deployable:** no — part of `semantic-port-inversion`.
- **Change:** Add the port to existing options and preserve all current
  semantic enable/disable decisions, merge order, fallback rules, and
  non-targeted caller-cache behavior. Remove all semantic imports.
- **Validation:** Symbol/reference/query focused tests and an import scan showing
  zero `src/symbols/** -> src/semantic/**` imports.

### 4. Wire every higher-level production caller

- [x] **Files:** `src/queries/internal/project-index.ts` and every direct query
      consumer enumerated by P9.
- **Premises:** P8-P10
- **Deployable:** yes, as completion of `semantic-port-inversion`.
- **Change:** Import the stateless semantic adapter in query-owned modules and
  pass it through existing symbol options. Preserve `semantic: false` and
  defaults exactly; do not add wrappers or global registration.
- **Validation:** Typecheck catches missing option shapes; focused navigation,
  graph, cleanup, health, and semantic tests prove production wiring.

### 5. Re-measure and document the boundary

- [x] **Files:** `docs/architecture/scip-query-target-architecture.md`, this plan
- **Premises:** P1
- **Deployable:** yes.
- **Change:** Record the completed migration, final edge/cycle counts, and the
  semantic-to-symbols direction.
- **Validation:** Local architecture query reports no reciprocal pair,
  `symbols -> semantic` is empty, and architecture drift has no findings.

### 6. Verify the completed slice

- [x] **Files:** affected tests and shared `.scipquery` event records
- **Premises:** P3-P14
- **Deployable:** yes.
- **Change:** Run matching extraction/new-interface/move postchecks, focused
  tests, full suite, lint, typecheck, build, reindex, architecture, and
  diff-gate.
- **Validation:** All commands pass or every finding has a written acceptance
  reason.

## Attack Record

### A1. Direct query bypass drops semantic evidence

- **Attack:** An agent wires the adapter only into `ProjectIndex`; a user runs
  `refs`, `trace`, `dataflow`, or `call-graph`, whose direct query module still
  calls a symbol function without the port; semantic results silently disappear.
- **Outcome:** **HOLE — repaired by step 4.** P9 requires wiring every direct
  caller enumerated by `refs`, not only P10's facade.

### A2. Warm cache accidentally constructs the provider

- **Attack:** A large TypeScript project has complete durable callee entries; a
  refactor makes the port call `semanticCalleeMap` before checking the cache;
  ts-morph eagerly loads even though every row is cached.
- **Outcome:** **HELD —** step 2 mechanically relocates the full cache shell and
  retains the early return after the cache scan (P4-P5).

### A3. `semantic: false` changes on the bulk caller path

- **Attack:** A small index uses the non-targeted caller cache and passes
  `semantic: false`; a clean-looking port propagation now disables semantic
  evidence where the previous implementation did not, changing results.
- **Outcome:** **HOLE — repaired by step 3.** The implementation must preserve
  P8's current asymmetry; behavior correction belongs in a separate change.

### A4. Cache identity becomes weaker during the move

- **Attack:** A dependency or Rust engine version changes after an earlier
  result was cached; the moved adapter omits the transitive TypeScript identity
  or Rust engine-qualified digest and returns stale callees.
- **Outcome:** **HELD —** step 2 moves the exact identity/digest code and step 6
  runs the existing TypeScript and Rust cache-gate tests (P4-P5).

### A5. New port becomes a broad semantic facade

- **Attack:** A future caller adds provider availability, import usage,
  signatures, lifecycle, or engine details to the port because the broad
  `SemanticEvidenceProduct` already exposes them; `symbols` again knows
  semantic implementation policy.
- **Outcome:** **HELD —** step 1 limits the port to facts consumed by the three
  current symbol modules, justified by P2 and P12.

### A6. Architectural success hides extra work

- **Attack:** Every query now creates a provider or recomputes a dependency
  graph before calling symbols; imports look one-way but large-repository
  latency regresses.
- **Outcome:** **HELD —** steps 2 and 4 pass one stateless adapter and keep all
  provider/cache work lazy behind the same conditions; invariant 6 and the full
  cache tests enforce no new work (P3-P5).

### Coverage Matrix

| Surface or lens                         | Attacks |
| --------------------------------------- | ------- |
| Direct query readers                    | A1      |
| `ProjectIndex` readers                  | A1      |
| Persistent semantic-callee cache reader | A2, A4  |
| Prefetched-cache writer                 | A2, A4  |
| Computed-miss cache writer              | A2, A4  |
| Semantic disable behavior               | A3      |
| Boundary ownership/reuse                | A5      |
| Efficiency                              | A2, A6  |
| Failure/provider unavailable            | A2, A4  |
| Public behavior                         | A1, A3  |
| Testability                             | A1, A4  |
| Reversibility                           | A1, A4  |

## Execution and Ship Order

Steps 1-4 are one compile-atomic migration group: the contract, adapter,
consumers, and every production assembly site land together. Step 5 records
measured facts only after reindexing. Step 6 is the ship gate. There are no data
migrations or one-way doors; rollback restores the moved functions and imports.

## Verdict

A plan is `PLANNED-COMPLETE` iff the coverage matrix has no blank rows, every
attack ends in `HELD` with cited steps and premises or a recorded repaired
hole, and no premise fails reverification.

Result: **PLANNED-COMPLETE** — 6 attacks, 2 holes repaired, 0 holes accepted;
all state readers/writers and direct production readers are covered.

## File Summary

- Create:
  `src/symbols/semantic-evidence-port.ts`,
  `src/semantic/symbol-evidence.ts`.
- Edit:
  the five symbol evidence modules named in step 3, query assembly consumers,
  runtime prewarm import, semantic cache tests, architecture documentation, and
  this plan.
- Delete:
  no public module; remove the semantic cache block from
  `call-graph-evidence.ts`.
- Verify:
  symbol/reference, query navigation/graph/cleanup, semantic cache/provider,
  runtime prewarm, architecture, full project, and diff-gate checks.
