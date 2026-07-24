# Architecture Boundary Resolution — finer boundaries, back-edge repair, and a coarse-boundary detector

Date: 2026-07-24

## Goal

The repository declares 14 architectural boundaries with `requireAcyclic: true`, and
`scip-query architecture` reports no violations. That clean result is partly an artifact of
boundary granularity: six of the 14 boundaries contain internal substructure, and the check
cannot see inside a boundary. This plan (A) refines the boundary configuration so the check
has something to enforce, (B) repairs the five real dependency cycles that refinement exposes,
and (C) adds a detector that reports when a boundary is too coarse for `requireAcyclic` to be
meaningful, so this blind spot is caught by tooling rather than by a manual audit.

Done looks like: `scip-query architecture` passes against a refined boundary set with
`requireAcyclic: true`; no cycle in the refined set is suppressed or baselined; and
`scip-query diff-gate` fails on a newly-introduced intra-boundary cycle that today passes.

## Definitions & Invariants

**Boundary** — a named set of files in `architecture.boundaries`, matched by glob, that the
dependency policy treats as one node. The trait that drives everything else here: the check
quotients the file dependency graph by boundary membership (P3), so any edge whose endpoints
land in the same boundary is discarded before analysis. Boundary granularity therefore
*defines* what the policy is able to observe, rather than merely how the report is grouped.

**Sub-unit** — the directory containing a file, used as the partition key when refining a
boundary. Distinct from a boundary: sub-units are derived from the filesystem, not declared.

**Coarse boundary** — a boundary whose quotient by sub-unit contains a strongly connected
component of size > 1. The essential trait: the boundary hides a cyclic dependency that
`requireAcyclic` reports as absent, so the boundary's clean status carries no information
about the code inside it.

**Real back edge** — a file-level import whose direction opposes the dominant direction
between two sub-units. What makes it actionable rather than cosmetic is asymmetry: the
dominant direction carries many edges and the back edge carries one or two (P8–P12), so
the cycle is removable by changing the minority side.

**Quotient cycle vs file cycle** — these are different objects and the distinction is
load-bearing. `scip-query cycles --scope src/queries` reports no file-level cycle (P6), yet
the sub-unit quotient of `src/queries` is cyclic (P7). A quotient can be cyclic while the
underlying graph is acyclic. Detector C must therefore analyze the quotient graph; reusing
the file-level `cycles` detector would report nothing.

**Invariants**

- I1. For every configured boundary B, `requireAcyclic: true` must always mean: the sub-unit
  quotient of B is acyclic **and** the boundary graph is acyclic. Today it means only the second.
- I2. A refined boundary set must always preserve total file coverage: every file mapped to
  exactly one boundary (`coverage.unmappedFiles` and `coverage.ambiguousFiles` both empty).
- I3. With `requireCompletePolicy: true`, the number of declared `allowedDependencies` rows
  must always equal the number of boundaries.
- I4. A behavior-preserving refactor in phase B must not change any command's output. Moving a
  symbol between files is acceptable; changing what it computes is not.
- I5. Detector C must never report a boundary as coarse iff its only intra-boundary cycles are
  module-hierarchy artifacts (barrel/entry re-export bookkeeping).

## Premises

- P1. `.scipquery.json` declares 14 boundaries, `requireAcyclic: true`, and
  `requireCompletePolicy: true`; `allowedDependencies` has 14 rows.
  — Source: `.scipquery.json:15-103`
- P2. `scip-query architecture` currently reports: `Mapped 348/348 indexed file(s) across 14
  boundary(ies); 14/14 dependency row(s) declared. No declared boundary violations found.`
  56 boundary edges, all `allowed`, no cycles.
  — Source: `scip-query architecture`
- P3. `analyzeArchitectureGraph` resolves each file to exactly one boundary, then builds
  `boundaryGraph` from file edges, skipping any edge where `from === to`
  (`architecture.ts:148`). SCC runs on `boundaryGraph` only (`architecture.ts:181`). No
  intra-boundary structure is retained.
  — Source: `scip-query code analyzeArchitectureGraph`
- P4. Six boundaries have internal substructure: `queries` (96 files), `runtime` (54),
  `semantic` (46), `source` (34 + 18 in `language-parsers`), `reindex` (31), `symbols` (16).
  These hold 295 of 348 files (85%).
  — Source: `find src/<dir> -name '*.ts' | wc -l` per boundary
- P5. The `source` boundary maps two distinct top-level trees: `src/source/**` and
  `src/language-parsers/**`.
  — Source: `.scipquery.json:57-60`
- P6. `scip-query cycles --scope <dir>` reports no real file-level cycle in any of
  `src/queries`, `src/runtime`, `src/semantic`, `src/source`, `src/symbols`,
  `src/language-parsers`; `src/reindex` reports one module-hierarchy cycle only.
  — Source: `scip-query cycles --scope <dir>` for each
- P7. Quotienting the file graph by sub-unit yields a strongly connected component of size > 1
  inside all six boundaries of P4.
  — Source: scratch analysis over `scip-query deps --json` for all 348 files
- P8. `source` ↔ `language-parsers` back edge: `language-parsers → source` carries 50 file
  edges; `source → language-parsers` carries exactly 1 —
  `src/source/source-evidence.ts:2` importing `getReExports, getSourceImports`.
  — Source: `scip-query deps` sweep; `src/source/source-evidence.ts:2`
- P9. `queries` back edges: `cleanup/doc-drift.ts:12-13` → `impact/diff-gate-doc-policy.ts`
  and `impact/diff-gate-types.ts` (2 edges), against `impact → cleanup` at 9 edges;
  `impact/diff-gate.ts:42` → `health/health-baseline.ts` (1 edge) against `health → cleanup`
  at 20 edges.
  — Source: `scip-query deps` sweep; cited lines
- P10. `semantic` back edge: `semantic/typescript/reference-fragment-shadow.ts:6` imports
  `getSemanticProvider` from `../provider-cache.js`, used at lines 86 and 206.
  `provider-cache.ts` constructs the TypeScript providers (2 edges outbound).
  — Source: `grep -n getSemanticProvider src/semantic/typescript/reference-fragment-shadow.ts`
- P11. `symbols` back edge: `symbols/graph/call-graph-evidence.ts:13` →
  `references/reference-sites.ts`, and `symbols/references/caller-evidence.ts:3-4` →
  `graph/call-graph-evidence.ts`. One edge each way.
  — Source: cited lines
- P12. `runtime` back edge: `commands → query-commands` carries 10 edges (9 from
  `commands/query-command-specs.ts`, 1 from `commands/invocation-command-descriptors.ts:13`),
  against `query-commands → commands` at 32 edges.
  — Source: `scip-query deps` sweep; `grep -n "from '../query-commands" src/runtime/commands/*.ts`
- P13. `src/runtime/commands/invocation-command-descriptors.ts:13` reaches `query-commands`
  through a **dynamic** `await import(...)`, not a static import. The file is 20 lines and the
  dynamic form is a deliberate lazy-load on the direct-navigation fast path.
  — Source: `src/runtime/commands/invocation-command-descriptors.ts:9-20`
- P14. `src/symbols/references/caller-evidence.ts:11-27` are pure forwarding functions
  (`callerRowsForSymbol`, `callerRowsMapForSymbols`) carrying explicit
  `scip-query: ignore-passthrough` suppression comments.
  — Source: `src/symbols/references/caller-evidence.ts:9-27`
- P15. `src/queries/impact/diff-gate-types.ts` is 3 lines: two exported type aliases
  (`DiffGateActionTier`, `DocCitationKind`) and no runtime code.
  — Source: `cat src/queries/impact/diff-gate-types.ts`
- P16. `src/language-parsers/index.ts` is 130 lines containing per-DB caches
  (`SOURCE_IMPORT_CACHE`, `SOURCE_EXPORT_CACHE`, `SOURCE_REEXPORT_CACHE`) and cache-keying
  logic. It is not a re-export-only file.
  — Source: `src/language-parsers/index.ts:1-25`
- P17. `classifyFile` in `src/analysis/file-classifier.ts:36-43` decides `barrel` from the
  **path** (`isBarrelPath`), not from content. Consequently `src/language-parsers/index.ts`
  classifies as `barrel` despite P16.
  — Source: `src/analysis/file-classifier.ts:36-48`
- P18. Empirically, detector variant `sub-unit = dirname` + exclude `barrel`/`entry` files
  reports 6 findings on this repo matching the manual analysis, but **misses** the
  `source → language-parsers` cycle because the back edge's target is
  `language-parsers/index.ts`, excluded by P17. Variant without exclusion reports the same
  boundaries but with 9-member components dominated by barrel bookkeeping.
  — Source: scratch detector prototype over the P7 graph, 4 variants measured
- P19. State authority — `ArchitectureReport`. Writers: `analyzeArchitectureGraph`
  (`architecture.ts:92-222`) is the sole constructor. Readers: `architecture()`
  (`architecture.ts:225`), `architectureFindingIdentities()` (`architecture.ts:241`),
  `hasEnforceableArchitecturePolicy()` (`architecture.ts:264`), plus files
  `queries/cleanup/drift.ts`, `queries/health/health-baseline.ts`,
  `queries/impact/diff-gate.ts`, `queries/index.ts`,
  `runtime/query-commands/cleanup/handlers.ts`, `runtime/query-commands/graph.ts`.
  — Source: `scip-query plan-context src/queries/graph/architecture.ts`
- P20. State authority — architecture baseline identities. Writer:
  `architectureFindingIdentities()` (`architecture.ts:241-261`), producing
  `forbidden-edge:`, `missing-policy-row:`, and `cycle:` identities under
  `ARCHITECTURE_BASELINE_PREFIX`. Readers: `health-baseline.ts:160,227`
  (`checkArchitectureBaseline`), consumed by `diff-gate.ts:42,1332-1365`.
  `.scipquery-baseline.json` currently holds `"findings": []`.
  — Source: `architecture.ts:241-261`, `health-baseline.ts:20,156-227`, `.scipquery-baseline.json`
- P21. State authority — `architecture` config validation. Writers: `src/runtime/config.ts`
  lines 379-495 validate `boundaries`, `allowedDependencies`, `requireAcyclic`,
  `requireCompletePolicy`; line 712 rejects unknown keys against `ARCHITECTURE_CONFIG_KEYS`.
  Readers: `db.config.architecture` via `architecture()` (`architecture.ts:233`).
  — Source: `grep -n architecture src/runtime/config.ts`
- P22. `diff-gate` registers `architecture` as a check name in a literal list
  (`diff-gate.ts:61,74`) and runs it via `runUnlessSkipped('architecture', ...)`
  (`diff-gate.ts:330`), delegating to `runArchitectureCheck` (`diff-gate.ts:1332`), which
  short-circuits when `hasEnforceableArchitecturePolicy` is false.
  — Source: `grep -n architecture src/queries/impact/diff-gate.ts`
- P23. Existing tests: `tests/queries/graph/architecture.test.ts` and
  `tests/queries/graph/cycles.test.ts`. Tests are not SCIP-indexed, so exported test-only
  helpers trip `new-dead` (precedent recorded in `.scipquery.json` suppression `SQ15F514D7AF85`).
  — Source: `ls tests/queries/graph/`, `.scipquery.json:136-140`
- P24. `src/core/` and `src/resolution/` exist as directories and contain zero `.ts` files.
  They match no boundary glob, and do not appear in `coverage.unmappedFiles` because they
  contribute no indexed files.
  — Source: `find src/core src/resolution -name '*.ts'`
- P25. The file dependency graph counts the dynamic `await import()` at
  `invocation-command-descriptors.ts:13` as an ordinary edge: `scip-query deps` on that file
  resolves both dynamic targets (`command-descriptors.js`,
  `query-commands/direct-navigation.js`). Confirmed directly; no longer an assumption.
  — Source: `scip-query deps src/runtime/commands/invocation-command-descriptors.ts`
- P26. `src/runtime/commands/` splits cleanly by direction. Files imported **by**
  `query-commands/` (the kit): `command-execution.ts` (11 importers),
  `command-descriptor-types.ts` (10), `command-spec-builders.ts` (9),
  `query-command-builders.ts` (3); `command-docs.ts` imports only
  `command-descriptor-types.ts`. None of these five imports `query-commands/` or any registry
  file. Files that import `query-commands/` (the registry): `query-command-specs.ts`,
  `invocation-command-descriptors.ts`. `command-handlers.ts` matches a `query-commands` grep
  only at line 96, which is a comment, not an import.
  — Source: `grep -rho "commands/[a-z-]*\.js" src/runtime/query-commands/ | sort | uniq -c`;
  per-file import listing of the five kit files
- P27. `src/runtime/commands/command-descriptors.ts:14` imports `orderedQueryCommandDescriptors`
  from `./query-command-specs.js`, and is itself imported only by
  `invocation-command-descriptors.ts`. Relocating `query-command-specs.ts` alone therefore
  re-routes the `runtime-commands → runtime-query-commands` edge rather than removing it.
  — Source: `src/runtime/commands/command-descriptors.ts:14`;
  `scip-query rdeps src/runtime/commands/command-descriptors.ts`
- P28. Eight `allowedDependencies` rows name a to-be-split boundary as a **target**:
  `analysis → source,symbols`; `public-api → queries,source,symbols`;
  `queries → semantic,source,symbols`; `reindex → semantic,source,symbols`;
  `runtime → queries,semantic,source,symbols`; `semantic → source,symbols`;
  `symbols → source`; `tla → queries,source,symbols`. `src/runtime/config.ts:452` emits
  `Unknown target boundary` for any row naming a boundary that no longer exists, so deleting a
  coarse boundary name invalidates every row targeting it.
  — Source: `.scipquery.json` allowedDependencies scan; `src/runtime/config.ts:445-462`
- P29. Of the four callers of `sourceEvidence`, only `src/analysis/file-classifier.ts` has an
  existing direct edge to `language-parsers`. `queries/internal/consumer-evidence.ts`,
  `queries/internal/project-index.ts`, and `symbols/definition-catalog.ts` have none. Both
  candidate repairs in B1.1 (inject, or relocate) give all four callers a direct
  `language-parsers` edge, creating three new boundary edges. None of the three forms a cycle
  — `language-parsers` sits below `queries` and `symbols` — so they are policy-row work, not
  architectural violations.
  — Source: `scip-query deps` for each of the four callers

## Current State

`scip-query architecture` builds the file dependency graph, maps all 348 indexed files to one
of 14 boundaries, and discards every edge internal to a boundary (P3). It then runs SCC over
the 14-node boundary graph and reports no cycles (P2). Because 85% of files live in the six
boundaries that have internal substructure (P4), the acyclicity guarantee covers the
relationships *between* the six large boundaries and the eight small ones, but says nothing
about the relationships inside them.

Refining each boundary by sub-unit exposes a strongly connected component in all six (P7).
Most of the exposed structure is module-hierarchy bookkeeping — a facade re-exporting its
children while children import shared helpers from the same directory — but five genuine
cycles survive that filtering (P8–P12). Each has a strongly asymmetric edge count, so each is
removable by changing one or two files on the minority side.

Two of the five are notable. The `source` boundary maps two separate top-level trees (P5), so
a cycle between `src/source` and `src/language-parsers` is invisible by configuration rather
than by granularity (P8). And the `runtime` cycle (P12) is partly carried by a deliberate
dynamic import on a startup fast path (P13), so it cannot be repaired by naive static
reordering.

The detector work has a measured design tension: the barrel exclusion that suppresses
module-hierarchy noise also suppresses the single most important finding in this repository,
because `language-parsers/index.ts` is a 130-line cache module that the path-based classifier
labels a barrel (P16, P17, P18).

## Reuse Audit

| Proposed unit | Decision | Evidence |
| --- | --- | --- |
| Sub-unit quotient + SCC for detector C | **Reuse** `stronglyConnectedComponents` from `src/analysis/strongly-connected-components.ts` | Already imported by `architecture.ts:2`; same `Map<string, Set<string>>` shape as `boundaryGraph` (P3) |
| Barrel/entry classification for I5 | **Reuse** `classifyFile` / `isBarrel` from `src/analysis/file-classifier.ts` | Already the shared answer for this question (`file-classifier.ts:5-6`); used by `cycles.ts:3` |
| File-level cycle detection for C | **Rejected** — `cycles.ts` operates on the file graph, which is acyclic here (P6) | A quotient can be cyclic while the file graph is acyclic; reusing `cycles()` would report nothing (Definitions) |
| New `coarse-boundary` CLI command | **Rejected** — extend `ArchitectureReport` instead | Adding a command costs 7 registration sites (`docs/COMMAND_REFERENCE.md`, `skills/_shared/SKILL.md`, `src/runtime/setup.ts`, `src/queries/index.ts`, `public-query-entries.ts`, `package.json`, descriptors) per the declared `generated command surface` coupling (`.scipquery.json:190-202`). The finding belongs to the architecture report that already has the boundary config and file graph in hand (P19). |
| New `ArchitectureCoarseBoundary` field on `ArchitectureReport` | **New — justified** | `ArchitectureReport` has one writer (P19); adding an optional field is additive for its 6 readers. No existing field expresses "boundary hides an internal cycle" — `cycles` is boundary-level (P3). |
| New diff-gate check name | **Reject** — extend the existing `architecture` check | `runArchitectureCheck` already gates on `hasEnforceableArchitecturePolicy` and emits baseline identities (P22); a new identity prefix reuses the whole ratchet |
| New config flag `requireResolvedBoundaries` | **New — justified** | `requireAcyclic` cannot carry this meaning without changing what it means for existing projects (I1 would silently tighten every downstream consumer's gate). Validation site already exists (P21). |

## Testability Design

| Behavior | Test seam | Dependencies to inject | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Refined boundary config is complete and acyclic (A) | `analyzeArchitectureGraph(graph, files, config)` | none — already pure (P3) | the whole function | `architecture(db)` reads `db.config` | `(graph, files, config) -> ArchitectureReport` |
| Back-edge repairs preserve behavior (B) | existing command tests + `scip-query diff-gate` | none | moved symbols stay pure | none | unchanged public exports |
| Coarse-boundary detection (C) | `detectCoarseBoundaries(fileGraph, filesByBoundary, opts)` | `classify` fn injected so tests can force barrel/non-barrel | quotient + SCC + classification | none — operates on an in-memory graph | `(graph, Map<boundary, Set<file>>) -> CoarseBoundaryFinding[]` |
| Config validation of the new flag (C) | `validateConfig` in `src/runtime/config.ts` | none | validation is pure over a parsed object | file read happens upstream | appends `ConfigDiagnostic[]` |

The detector's core takes a graph and a membership map, not a `ScipDatabase`. That keeps every
classification rule in I5 testable with a hand-built 5-node graph and no index.

## Design Phases

### Phase A — Refine boundaries to expose what the check cannot see

Purpose: make the current hidden structure visible and failing, so B has a target and C has a
reference result. A is deliberately shipped in a **failing** state and repaired by B.

#### A1.1 — Split `language-parsers` out of the `source` boundary

- [ ] **File**: `.scipquery.json:57-60`, `:74-100`
- **Premises**: P5, P8, I2, I3
- **Deployable**: no — part of single-deploy group `boundary-refinement` (fails `architecture` until B1.1)
- **What**: One boundary named `source` maps `["src/source/**", "src/language-parsers/**"]` (P5).
- **Change**: Replace with two boundaries: `source` → `["src/source/**"]`, `language-parsers` →
  `["src/language-parsers/**"]`. Add `allowedDependencies` rows: `language-parsers`:
  `["domain", "platform", "source", "storage"]`; `source`: `["domain", "platform", "storage"]`
  (dropping `language-parsers` — that is the edge B1.1 removes). Add `language-parsers` to the
  dependency lists of every boundary that currently reaches it through `source`.
- **Testability**: seam `analyzeArchitectureGraph`; assert `coverage.unmappedFiles` is empty
  (I2) and `policyCoverage.missingRows` is empty (I3).
- **Validation**: `scip-query architecture` reports 15 boundaries, 15/15 rows, and **one
  forbidden edge** `source -> language-parsers` (this failure is the intended outcome).
- **Why**: P8 shows the cycle is concealed by configuration, not granularity — this is the one
  refinement that needs no sub-unit reasoning at all.

#### A1.2 — Refine the five remaining coarse boundaries by sub-unit

- [ ] **File**: `.scipquery.json:15-103`
- **Premises**: P4, P7, P9, P10, P11, P12, I2, I3
- **Deployable**: no — group `boundary-refinement`
- **What**: `queries`, `runtime`, `semantic`, `symbols`, `reindex` are single boundaries (P1).
- **Change**: Split into sub-unit boundaries, holding total coverage:
  - `queries` → `queries-internal`, `queries-navigation`, `queries-graph`, `queries-quality`,
    `queries-frontend`, `queries-cleanup`, `queries-impact`, `queries-health`,
    `queries-facade` (`src/queries/index.ts`, `public-query-entries.ts`),
    `queries-utils` (`src/queries/query-utils.ts`)
  - `runtime` → `runtime-commands` (`src/runtime/commands/**`),
    `runtime-command-kit` (`src/runtime/command-kit/**`, the directory B1.5 creates),
    `runtime-query-commands` (`src/runtime/query-commands/**`),
    `runtime-entry` (exact paths `src/runtime/cli.ts`, `index.ts`, `postinstall.ts`),
    `runtime-services` (the remaining 24 top-level files, enumerated as **exact paths** — a
    `src/runtime/*` glob would also match the three entry files and make them ambiguous, A1.5)
  - `semantic` → `semantic-contracts` (`types.ts`), `semantic-typescript`, `semantic-rust`,
    `semantic-core`
  - `symbols` → `symbols-graph`, `symbols-references`, `symbols-core`
  - `source` → `source-ast`, `source-vue`, `source-core`, `source-facade` (`src/source/ast.ts`)
  - `reindex` → left whole; its only internal cycle is module-hierarchy (P6)
  `allowedDependencies` rows are **generated** by A1.6, not hand-written — the coarse names
  `queries`, `semantic`, `symbols`, `source`, `runtime` disappear here, invalidating the eight
  existing rows that target them (P28).
- **Testability**: seam `analyzeArchitectureGraph` over the real graph.
- **Validation**: `scip-query architecture` maps 348/348 with zero ambiguous files, declares a
  row per boundary, and reports exactly the cycles of P9–P12 — no more, no fewer. A cycle not
  in P9–P12 means the partition is wrong, not that new debt was found.
- **Why**: `queries-facade` and `queries-utils` are split out because a directory's root mixes
  a top-of-stack facade with bottom-of-stack helpers; merging them manufactures a cycle that
  the code does not have (P7 vs P6).

#### A1.3 — Delete the two empty directories

- [ ] **File**: `src/core/`, `src/resolution/`
- **Premises**: P24
- **Deployable**: yes
- **What**: Both directories exist with zero `.ts` files and match no boundary glob (P24).
- **Change**: `rmdir src/core src/resolution`.
- **Testability**: none required — no indexed file changes.
- **Validation**: `scip-query reindex && scip-query architecture` still maps 348/348.
- **Why**: They read as boundaries-in-waiting and would silently become unmapped the moment
  someone adds a file (I2).

#### A1.4 — Assert total coverage instead of relying on a catch-all

- [ ] **File**: `tests/queries/graph/architecture.test.ts`
- **Premises**: P3, I2
- **Deployable**: yes
- **What**: With one coarse boundary per top-level directory, a new file anywhere under
  `src/queries/**` was automatically covered. After A1.2 the sub-boundaries are exact, so a new
  directory (`src/queries/experimental/`) matches nothing and becomes unmapped silently — the
  report still says "no violations."
- **Change**: Add a test asserting `architecture(db).coverage.unmappedFiles` is empty. Do
  **not** add a catch-all boundary: `architecture.ts:127-134` collects *all* matching
  boundaries and marks multi-match files ambiguous (there is no last-wins precedence), so a
  catch-all would make every file ambiguous and drop it from `resolved` entirely.
- **Testability**: seam `analyzeArchitectureGraph`; the assertion is a pure property of the
  returned report.
- **Validation**: temporarily add a file under an unmatched path; the test fails.
- **Why**: Refinement converts a silent pass into a silent gap. A file in no boundary is a file
  in no policy, and `coverage` is the only surface that reports it.

#### A1.5 — Prove boundary globs are mutually exclusive

- [ ] **File**: `tests/queries/graph/architecture.test.ts`
- **Premises**: P3, I2
- **Deployable**: yes
- **What**: `architecture.ts:127-134` marks a file matching two boundaries as ambiguous and
  excludes it from `resolved`, so every edge through it vanishes. This *weakens* the analysis
  without failing.
- **Change**: Add a test asserting `coverage.ambiguousFiles` is empty. Constrain A1.2's globs
  accordingly: `queries-cleanup` is `["src/queries/cleanup/**"]`, and no boundary may claim a
  bare `["src/queries/**"]` alongside the exact-path facade boundaries.
- **Testability**: same seam as A1.4.
- **Validation**: temporarily add an overlapping glob; the test fails.
- **Why**: This is A1.4's failure mode seen from the other side, and the more dangerous of the
  two because it degrades the graph rather than leaving a file out of it.

#### A1.6 — Generate `allowedDependencies` from the measured graph

- [ ] **File**: `.scipquery.json`, `scripts/` (new one-shot generator)
- **Premises**: P7, P28, P29, I3
- **Deployable**: no — group `boundary-refinement`
- **What**: Eight existing rows name a coarse boundary as a target (P28), and
  `config.ts:452` rejects rows targeting a boundary that no longer exists. Hand-deriving ~30
  rows at sub-boundary precision — including re-deriving which specific `queries-*` /
  `symbols-*` sub-boundary each of the eight consumers actually uses — is error-prone and was
  unbudgeted in the first draft of this plan.
- **Change**: Write a throwaway script that reads the refined boundary set, quotients the real
  file dependency graph by it, and emits the **minimal** `allowedDependencies` matrix: for each
  boundary, exactly the set of boundaries it actually reaches. Review the output by hand before
  committing — the generated matrix describes what *is*, and the point of the exercise is to
  reject the rows that should not exist (they are the B-phase targets).
- **Testability**: the generator's output is compared against `scip-query architecture`, which
  must report zero `undeclared` and zero `forbidden` edges when fed the generated matrix.
- **Validation**: `scip-query architecture` reports `N/N dependency row(s) declared` with no
  `Unknown target boundary` diagnostic from `scip-query` config validation.
- **Why**: Generating the descriptive matrix first, then deleting the rows that encode the five
  cycles, separates mechanical bookkeeping from the architectural judgment. Hand-writing 30
  rows mixes the two and hides the judgment in the noise.

### Phase B — Repair the five real back edges

Each step removes a minority-direction edge. I4 governs all of them: behavior must not change.

#### B1.1 — Remove `source → language-parsers`

- [ ] **File**: `src/source/source-evidence.ts:2`
- **Premises**: P8, P16, I4
- **Deployable**: yes
- **What**: `source-evidence.ts` imports `getReExports, getSourceImports` from
  `../language-parsers/index.js` (P8) and uses them at line 58 to populate optional
  `imports`/`reExports` fields of its evidence record.
- **Change**: Relocate `src/source/source-evidence.ts` into `src/language-parsers/`. Rejected
  alternative: injecting the parsed imports through `sourceEvidence`'s request object. Both
  repairs give all four callers a direct `language-parsers` edge (P29), so injection buys
  nothing and costs a signature change across four call sites.
  **Binding constraint from P29**: three of the four callers
  (`queries/internal/consumer-evidence.ts`, `queries/internal/project-index.ts`,
  `symbols/definition-catalog.ts`) have no `language-parsers` edge today, so this step creates
  three new boundary edges. They are downward edges — `language-parsers` sits below both
  `queries` and `symbols` — so none forms a cycle, but each needs an `allowedDependencies`
  grant. A1.6's generated matrix must be regenerated after this step, not before.
- **Testability**: seam is the exported `sourceEvidence` function; the injected port replaces a
  module import with a parameter, so tests can pass literal import lists with no index.
- **Validation**: `scip-query deps src/source/source-evidence.ts` shows no `language-parsers`
  entry; `scip-query architecture` clears the `source -> language-parsers` forbidden edge from A1.1.
- **Why**: `language-parsers → source` carries 50 edges against this one (P8), so the minority
  side is unambiguous. P16 rules out the alternative reading that `index.ts` is a mere barrel.

#### B1.2 — Remove `source-ast → source-vue`

- [ ] **File**: `src/source/ast/ast-core.ts:14,57`
- **Premises**: P7, I4
- **Deployable**: yes
- **What**: The generic AST core imports `extractVueScriptBlock` from `../vue/vue-script.js`
  and calls it at line 57, while `source/vue/**` depends on `source/ast/**` (4 edges).
- **Change**: Invert with a registration seam — `ast-core` exposes a hook for language-specific
  pre-extraction; `vue-script.ts` registers the Vue SFC extractor. Keeps `ast-core` generic.
- **Testability**: seam is the registration function; a test registers a fake extractor and
  asserts `getAst` routes to it, with no Vue file involved.
- **Validation**: `scip-query deps src/source/ast/ast-core.ts` shows no `source/vue` entry.
- **Why**: A generic AST core reaching into one framework's extractor inverts the intended
  direction; the registry seam is how the language adapters already work (`language-parsers/registry.ts`).

#### B1.3 — Remove `symbols-references → symbols-graph`

- [ ] **File**: `src/symbols/references/caller-evidence.ts:3-4,11-27`
- **Premises**: P11, P14, I4
- **Deployable**: yes
- **What**: `callerRowsForSymbol` and `callerRowsMapForSymbols` are pure forwarding functions
  to `graph/call-graph-evidence.ts`, annotated `ignore-passthrough` (P14).
- **Change**: Delete both forwarders and repoint their consumers at
  `graph/call-graph-evidence.ts` directly. Re-export the `CallerRow` type from wherever
  consumers need it without creating an import edge back into `graph/`.
- **Testability**: no new seam; existing consumer tests cover behavior since the functions
  forward verbatim (P14).
- **Validation**: `scip-query deps src/symbols/references/caller-evidence.ts` shows no
  `symbols/graph` entry; `scip-query passthrough-candidates` no longer lists them.
- **Why**: P14 makes this the cheapest of the five — the edge exists only to forward, and the
  suppression comments are themselves evidence the indirection was already questioned.

#### B1.4 — Remove `semantic-typescript → semantic-core`

- [ ] **File**: `src/semantic/typescript/reference-fragment-shadow.ts:6,86,206`
- **Premises**: P10, I4
- **Deployable**: yes
- **What**: A concrete TypeScript provider module calls `getSemanticProvider` from
  `../provider-cache.js`, the factory that constructs those same providers (P10).
- **Change**: Pass the resolved provider in as a parameter at both call sites rather than
  resolving it from the registry inside the module. The two callers
  (`semantic/shared-primitives.ts`, `reindex/index.ts`) already hold a database handle and can
  resolve the provider before calling.
- **Testability**: seam is the exported function; injecting the provider removes the registry
  dependency entirely, so tests supply a stub provider.
- **Validation**: `scip-query deps src/semantic/typescript/reference-fragment-shadow.ts` shows
  no `provider-cache` entry.
- **Why**: Provider-calls-its-own-factory is the inversion; parameterizing is the standard
  repair and matches the injected-port shape used elsewhere in `semantic/`.

#### B1.5 — Remove `runtime-commands → runtime-query-commands`

- [ ] **File**: new `src/runtime/command-kit/`; `src/runtime/commands/*.ts`
- **Premises**: P12, P13, P25, P26, P27, I4
- **Deployable**: yes
- **What**: `src/runtime/commands/` holds two layers with opposite dependency directions (P26).
  Five files form a *kit* that `query-commands/` imports (`command-execution.ts` ×11,
  `command-descriptor-types.ts` ×10, `command-spec-builders.ts` ×9,
  `query-command-builders.ts` ×3, plus `command-docs.ts`), and none of the five imports
  `query-commands/` or any registry file. Two files form a *registry* that imports
  `query-commands/`: `query-command-specs.ts` and `invocation-command-descriptors.ts:13`
  (dynamic, P13). `command-descriptors.ts:14` imports the registry (P27).
- **Change**: Create `src/runtime/command-kit/` and move the five kit files into it, updating
  importers. `src/runtime/commands/` keeps `command-descriptors.ts`,
  `query-command-specs.ts`, `invocation-command-descriptors.ts`, `command-registry.ts`, and
  `command-handlers.ts`. Resulting direction: `runtime-commands → runtime-query-commands →
  runtime-command-kit`, acyclic. Leave the dynamic import at
  `invocation-command-descriptors.ts:13` untouched — it is a measured startup fast path (P13),
  and after this split its direction is no longer a back edge.
- **Testability**: seam is `commandDescriptors`; assert the registered command-name set is
  byte-identical before and after (the same coverage question `BUILTIN_SKILLS` poses).
- **Validation**: `scip-query deps` sweep shows `runtime-command-kit → runtime-query-commands`
  and `runtime-command-kit → runtime-commands` both at 0 edges; `scip-query --help` lists the
  same commands; `npm run docs:commands` leaves `docs/COMMAND_REFERENCE.md` unchanged.
- **Why**: This supersedes the first draft's plan to relocate `query-command-specs.ts` alone.
  That move would have re-routed the edge rather than removed it, because
  `command-descriptors.ts` — which stays in `commands/` — imports it (P27). The direction of
  the cut has to follow the import direction (P26), not the aggregation story.

#### B1.6 — Remove the `queries` cleanup/health/impact cycle

- [ ] **File**: `src/queries/impact/diff-gate-types.ts`, `src/queries/cleanup/doc-drift.ts:12-13`,
  `src/queries/impact/diff-gate.ts:42`
- **Premises**: P9, P15, P20, I4
- **Deployable**: yes
- **What**: Intended layering is `cleanup` (detectors) → `impact` (diff-gate consumes them) →
  `health` (report consumes both). `doc-drift.ts` imports upward into `impact` (2 edges), and
  `diff-gate.ts` imports upward into `health` (1 edge) (P9).
- **Change**: three moves.
  1. Move `diff-gate-types.ts` (3 lines of type aliases, P15) to a layer both sides may
     depend on — `src/queries/internal/`. Update all importers.
  2. Move `isSnapshotDoc` and `docReferencePolicy` out of `impact/diff-gate-doc-policy.ts`.
     These are doc-classification policy consumed by a `cleanup` detector; relocate to
     `src/queries/cleanup/` and have `diff-gate.ts` import them downward.
  3. Move `checkArchitectureBaseline` / `checkHealthBaseline` / `resolveBaselinePath` out of
     `health/health-baseline.ts` into `src/queries/internal/`. Baseline resolution is shared
     ratchet infrastructure, not a health-report concern; `diff-gate.ts`,
     `queries/index.ts`, and `runtime/commands/command-handlers.ts` all consume it.
- **Testability**: seams are the moved functions, all already exported and pure over a `db`
  handle. `resolveBaselinePath` is the one with filesystem contact — keep it as the side-effect
  shell and test the policy functions directly.
- **Validation**: `scip-query architecture` reports no cycle among `queries-cleanup`,
  `queries-impact`, `queries-health`. `scip-query diff-gate` emits an identical finding set to
  the pre-change run — P20 makes this load-bearing, since moving baseline code must not change
  any emitted identity string.
- **Why**: Each move pushes a shared concern *down* to a layer both consumers may depend on,
  rather than pushing a dependency sideways. P15 makes move 1 nearly free.

#### B1.7 — Re-tighten the configuration

- [ ] **File**: `.scipquery.json`
- **Premises**: I1, I3, P20
- **Deployable**: yes — closes the `boundary-refinement` group
- **What**: After A1.1–A1.2 the config declares the refined boundaries but `architecture` fails.
- **Change**: Remove the now-obsolete allowances that existed only to carry the repaired edges;
  confirm `requireAcyclic: true` and `requireCompletePolicy: true` still hold.
- **Testability**: seam `analyzeArchitectureGraph`.
- **Validation**: `scip-query reindex && scip-query architecture && scip-query diff-gate` — all
  clean, and `.scipquery-baseline.json` still reads `"findings": []` (P20). A non-empty
  baseline means a cycle was ratcheted rather than repaired, which fails the goal.
- **Why**: The plan's value is a config that *passes while meaning something*; leaving
  allowances in place would restore the original blind spot at finer granularity.

### Phase C — Detect boundaries too coarse to check

#### C1.1 — Add the detector core

- [ ] **File**: `src/queries/graph/architecture.ts` (new exported function, near `architectureCycle`)
- **Premises**: P3, P7, P17, P18, I5
- **Deployable**: yes — reporting only until C1.3
- **What**: `analyzeArchitectureGraph` discards intra-boundary edges (P3); nothing measures
  what was discarded.
- **Change**: Add `detectCoarseBoundaries(fileGraph, filesByBoundary, opts)`:
  1. For each boundary with ≥ 2 files, key each member file by its containing directory.
  2. Build the quotient of the intra-boundary edges by that key.
  3. Run `stronglyConnectedComponents` (reused, per the audit) and keep components of size > 1.
  4. Classify each component as module-hierarchy or real using injected `classify`, defaulting
     to `classifyFile` (I5).
  Return `{ boundary, subUnits, internalEdges, narrowestEdges }`, mirroring the existing
  `ArchitectureCycle` shape so report rendering can be shared.
- **Testability**: seam is `detectCoarseBoundaries` with a hand-built graph and an injected
  `classify`; I5's barrel rule is testable without touching the index.
- **Validation**: run against this repo's **pre-Phase-B** config and assert it reports exactly
  the six boundaries of P7 — this is the acceptance test that C would have caught B.
- **Why**: The quotient, not the file graph, is the object that carries the finding
  (Definitions; P6 vs P7).

#### C1.2 — Resolve the barrel-exclusion false negative

- [ ] **File**: `src/analysis/file-classifier.ts` or `detectCoarseBoundaries` options
- **Premises**: P16, P17, P18, I5
- **Deployable**: yes
- **What**: Path-based barrel classification (P17) labels the 130-line cache module
  `language-parsers/index.ts` a barrel (P16), so excluding barrels suppresses the most
  important finding in this repository (P18).
- **Change**: Exclude a file from the quotient only when it is re-export-only *in fact*, not by
  filename. Preferred: gate the exclusion on the file having no non-re-export definitions,
  which the index can answer. If that proves expensive, fall back to excluding barrel files
  from *node* collapsing but still counting their edges, and measure both against P18's four
  variants before choosing.
- **Testability**: seam is the injected `classify`; one test asserts a named-`index.ts`
  file with real definitions is **not** excluded.
- **Validation**: detector reports `source ↔ language-parsers` (P8) while still not reporting
  the 9-member barrel-dominated `queries` component of P18's unfiltered variant.
- **Why**: This is the measured failure mode, not a hypothetical. Shipping C1.1 without it
  produces a detector that misses the case that motivated the work.

#### C1.3 — Gate on it

- [ ] **File**: `src/domain/config-types.ts`, `src/runtime/config.ts:379-495,712`,
  `src/queries/graph/architecture.ts:241-261`, `src/queries/impact/diff-gate.ts:1332`
- **Premises**: P20, P21, P22, I1
- **Deployable**: yes — default off
- **What**: `requireAcyclic` covers only the boundary graph (P3); `architectureFindingIdentities`
  emits three identity kinds (P20); `diff-gate`'s `architecture` check consumes them (P22).
- **Change**: Add `architecture.requireResolvedBoundaries?: boolean`, defaulting **false**.
  Validate it alongside `requireAcyclic` (P21) and add it to `ARCHITECTURE_CONFIG_KEYS`
  (`config.ts:712`). When true, emit
  `${ARCHITECTURE_BASELINE_PREFIX}coarse-boundary:<boundary>` identities from
  `architectureFindingIdentities`, and include the flag in `hasEnforceableArchitecturePolicy`
  so `runArchitectureCheck` stops short-circuiting for projects that set only this flag.
- **Testability**: seam `validateConfig` for the flag; `architectureFindingIdentities` for the
  identities (pure over a report object).
- **Enforcement window**: this step installs an enforcer. Per P20 the only writer of baseline
  identities is `architectureFindingIdentities`, and the only readers are `checkArchitectureBaseline`
  and `diff-gate`. Defaulting to `false` means no existing project's gate changes on upgrade;
  this repo opts in only in C1.4, after Phase B has cleared the findings. There is no window
  in which an existing writer fails a new check.
- **Validation**: with the flag false, `scip-query diff-gate` output is byte-identical to
  before. With it true and Phase B incomplete, `diff-gate` exits 1.
- **Why**: Folding this into `requireAcyclic` would silently tighten every downstream project's
  gate on upgrade — the reuse audit rejects that for exactly the I1 reason.

#### C1.4 — Enable it for this repository

- [ ] **File**: `.scipquery.json`
- **Premises**: I1
- **Deployable**: yes
- **Change**: Set `architecture.requireResolvedBoundaries: true`.
- **Validation**: `scip-query reindex && scip-query diff-gate` clean, baseline still empty.
- **Why**: Closes I1 — from here, a new intra-boundary cycle fails the gate.

## Attack Record

### A1. I2 (total coverage) via boundaries
- Attack: an author adds `src/queries/experimental/foo.ts`. Under A1.2 the `queries` boundary
  no longer exists as a catch-all; the new directory matches no glob.
- Outcome: HOLE — repaired by new step **A1.4**: keep a catch-all `queries-unassigned`
  boundary with paths `["src/queries/**"]` ordered last, or assert `coverage.unmappedFiles`
  is empty in CI. Without it, refinement converts a silent pass into a silent gap: a file in
  no boundary is a file in no policy. Note `matches.length > 1` marks the file *ambiguous*
  (`architecture.ts:133`), not last-wins — so a naive catch-all breaks I2 in the other
  direction. The repair must use `coverage` assertions, not glob ordering.

### A2. I4 (behavior preservation) via data integrity
- Attack: B1.6 move 3 relocates `checkArchitectureBaseline`. If the move changes any emitted
  identity string, `.scipquery-baseline.json` entries stop matching and previously-ratcheted
  findings silently reappear or vanish.
- Outcome: HELD — defended by B1.6 validation, which requires an identical `diff-gate` finding
  set before and after, and by P20 enumerating the complete writer/reader set of the identity
  surface. The identities are built from boundary names (`architecture.ts:241-261`), not file
  paths, so relocation cannot change them.

### A3. I4 via valid intermediate state
- Attack: Phase A ships alone. `architecture` now fails, so `diff-gate` exits 1 on every
  commit until Phase B lands — the plan that adds enforcement is itself the outage.
- Outcome: HOLE — accepted with mitigation: A1.1 and A1.2 are marked `Deployable: no` and
  belong to the single-deploy group `boundary-refinement`, closed by B1.7. The group must land
  as one commit series on `main` without an intervening release. Recorded as accepted rather
  than repaired because the user explicitly asked to run A first and observe the failures.

### A4. I5 (no module-hierarchy false positives) via boundaries
- Attack: a Rust crate boundary where `mod.rs` and its children reference each other. The
  dirname quotient puts `mod.rs` and children in the *same* sub-unit, so no cycle appears —
  but a two-level Rust hierarchy (`a/mod.rs`, `a/b/mod.rs`) lands in different sub-units and
  produces a component that is pure module bookkeeping.
- Outcome: HOLE — repaired by new step **C1.5**: port `isRustSubmodulePair` from `cycles.ts:152`
  into the classification in C1.1 step 4. `cycles.ts` already solved this exact problem
  (`cycles.ts:132-138`); the detector must reuse that rule or it will be unusable on Rust
  projects — including this repo's own `crates/` boundary.

### A5. I1 via reversibility
- Attack: a project sets `requireResolvedBoundaries: true`, accumulates findings, and wants
  out. Are the findings baselineable, or is the only exit turning the flag off?
- Outcome: HELD — defended by C1.3, which routes findings through
  `architectureFindingIdentities` and therefore through the existing baseline ratchet (P20).
  A project can baseline `coarse-boundary:` identities exactly as it baselines `cycle:` ones.

### A6. I4 via concurrency
- Attack: B1.5 moves `query-command-specs.ts` while `scip-query watch` is running. The watcher
  reindexes on the delete before the create lands, transiently indexing a state where
  `command-descriptors.ts` imports a missing module; a `diff-gate` run in that window reports
  spurious findings.
- Outcome: HOLE — accepted: transient, self-correcting on the next reindex, and
  `watch.debounceMs` is 250ms (`.scipquery.json:5`) which coalesces a git-mv into one event.
  Recorded rather than repaired because the failure is a stale report, not a wrong repair.

### A7. I5 via efficiency
- Attack: `detectCoarseBoundaries` runs on every `architecture` call, which `diff-gate` and
  `health` both invoke (P19). Quotient + SCC per boundary on a large monorepo adds cost to an
  already-measured hot path.
- Outcome: HELD — defended by C1.1's design: the quotient is built from intra-boundary edges
  that `analyzeArchitectureGraph` already iterates at `architecture.ts:143-159` and currently
  discards, so the added work is O(V+E) over edges already in hand. This is strictly cheaper
  than `cycles.ts`, whose DFS is bounded by `maxDepth` 10 (`cycles.ts:37`).

### A8. I2 via data integrity
- Attack: A1.2 assigns `src/queries/index.ts` to `queries-facade` via an exact path, and
  `src/queries/**` to another boundary. `architecture.ts:127-134` collects **all** matching
  boundaries and marks multi-match files ambiguous — so the file is dropped from `resolved`
  and every edge through it disappears.
- Outcome: HOLE — repaired by new step **A1.5**: every refined boundary's globs must be
  mutually exclusive by construction. Since `matchesGlob` has no precedence, `queries-cleanup`
  must be `["src/queries/cleanup/**"]` and no boundary may claim bare `["src/queries/**"]`.
  Add a test asserting `coverage.ambiguousFiles` is empty. This is the same defect as A1 seen
  from the other side, and it silently *weakens* the graph rather than failing loudly.

### A9. I4 via failure
- Attack: B1.1's preferred repair injects parsed imports into `sourceEvidence`. Its four
  callers include `analysis/file-classifier.ts` — but `analysis` may not depend on
  `language-parsers` under the A1.1 policy, so the injection just relocates the forbidden edge
  into `analysis`.
- Outcome: HOLE — repaired by amending B1.1: check each of the four callers' boundaries against
  the A1.1 policy **before** choosing injection over relocation. If `analysis` cannot reach
  `language-parsers`, relocating `source-evidence.ts` into `language-parsers/` is the only
  repair that does not move the violation. The step already says to decide from the reverse-dep
  list; this attack makes the criterion explicit and binding.

### A10. I1 via observability
- Attack: `requireResolvedBoundaries` is false by default (C1.3), so no existing project ever
  learns its boundaries are coarse. The detector ships and changes nothing for anyone.
- Outcome: HOLE — repaired by new step **C1.6**: surface coarse boundaries in
  `scip-query architecture`'s human output and in `health` as an informational finding
  regardless of the flag. Gating controls *failure*, not *visibility* — a detector nobody sees
  is a detector nobody adopts.

### A11. I3 (complete policy) via data integrity — *found by adversarial pass*
- Attack: A1.2 deletes the boundary names `queries`, `semantic`, `symbols`, `source`,
  `runtime`. Eight surviving `allowedDependencies` rows name those as targets (P28).
  `config.ts:452` emits `Unknown target boundary` for each, so config validation fails before
  `scip-query architecture` can run at all — A1.2's own Validation output is unreachable.
- Outcome: HOLE — repaired by new step **A1.6**: generate the full matrix from the measured
  graph rather than hand-editing rows. The first draft said only "declare a row for every new
  boundary" and silently assumed existing rows were unaffected. This is the single largest
  omission the adversarial pass found: the work is mechanical but unbudgeted, and it blocks
  every downstream validation in Phase A.

### A12. I4 via boundaries — *found by adversarial pass*
- Attack: B1.5 (first draft) moves `query-command-specs.ts` into `query-commands/`.
  `command-descriptors.ts` stays in `commands/` and still imports it (P27), so
  `runtime-commands → runtime-query-commands` survives at 1 static edge while the 32 reverse
  edges are untouched. The 2-boundary cycle persists, and B1.7's "clean `requireAcyclic`" claim
  is false.
- Outcome: HOLE — repaired by rewriting **B1.5** to split `commands/` by import direction
  (P26) into `command-kit/` (imported by `query-commands`) and a registry (imports
  `query-commands`). The original step cut along the aggregation story rather than the import
  direction, which is why it re-routed the edge instead of removing it.

### A13. I2 via boundaries — *found by adversarial pass*
- Attack: A1.2's `runtime` split named `runtime-services` and `runtime-entry` with no glob or
  file list. `src/runtime/` has 2 subdirectories and 27 top-level files sharing one sub-unit,
  so the plan's own "sub-unit = directory" definition cannot derive the split. A naive
  `src/runtime/*` glob for `runtime-services` also matches `cli.ts`, making the entry files
  ambiguous and dropping them from the graph (A8's mechanism).
- Outcome: HOLE — repaired by amending **A1.2** to enumerate `runtime-entry` as three exact
  paths and `runtime-services` as the remaining 24 exact paths, with an explicit note that a
  `src/runtime/*` glob is wrong here.

### A14. I1 via observability — *found by adversarial pass*
- Attack: P25 was recorded as an unconfirmed ASSUMPTION whose confirmation was deferred to
  B1.5's validation, and it predicted a post-move count of 1. Both were wrong: the assumption
  is directly checkable today, and the true post-move count under the first-draft B1.5 was 2.
- Outcome: HOLE — repaired by promoting **P25** to a confirmed premise and rewriting B1.5
  (A12). A premise deferred to a later step's validation cannot catch that step's design error,
  which is exactly what happened here.

### Coverage matrix

| Surface or lens | Attacks |
| --- | --- |
| `ArchitectureReport` writer (`analyzeArchitectureGraph`) | A7, A8 |
| `ArchitectureReport` readers (6 files, P19) | A2, A7 |
| Baseline identity writer (`architectureFindingIdentities`) | A2, A5 |
| Baseline identity readers (`checkArchitectureBaseline`, `diff-gate`) | A2, A5 |
| Config validation writers (`config.ts:379-495`) | A5, A10 |
| Boundary coverage (I2) | A1, A8 |
| Valid intermediate state | A3, A6 |
| Reversibility | A5 |
| Concurrency | A6 |
| Efficiency | A7 |
| Observability | A10 |
| Data integrity | A2, A8 |
| Failure | A9 |
| Boundaries | A1, A4 |
| Blast radius | A2, A3 |
| Testability | covered by Testability Design; no attack — **accepted**: every seam is a pure function over an in-memory graph |
| Human experience | A10 |
| Purpose | A10 |
| Reuse | covered by Reuse Audit rejections (C command, `cycles()`) — **accepted** |

## Execution Order

1. **A1.1, A1.2, A1.4, A1.5, A1.6** — refine config; A1.6 must run last within this group and
   its generated matrix reviewed by hand. Not deployable alone (A3); `architecture` fails by design.
2. **Observe** — run `scip-query architecture` and confirm the reported cycles are exactly
   P8–P12. This is the checkpoint: does A detect what B must fix? Any cycle outside that set
   means the partition is wrong, not that new debt was found.
3. **B1.1–B1.6** — repair, cheapest first: B1.3 (delete forwarders, P14) → B1.6 move 1
   (3-line type file, P15) → B1.4 → B1.2 → B1.5 (directory split) → B1.6 moves 2-3 → B1.1
   (creates three new policy edges, P29 — regenerate A1.6's matrix after).
4. **B1.7** — re-tighten; group `boundary-refinement` closes here.
5. **A1.3** — delete empty directories (independent; may land any time).
6. **C1.1, C1.5, C1.2** — detector core, Rust rule, barrel fix.
7. **C1.6** — visibility.
8. **C1.3, C1.4** — gate, then opt in.

## Ship Order and one-way doors

- **One-way door**: B1.6 move 3 relocates baseline resolution. If identity strings change,
  every downstream project's `.scipquery-baseline.json` breaks on upgrade. Verify A2's
  identical-finding-set check before committing.
- **One-way door**: C1.3's config key becomes public API the moment it ships. Name it before
  release, not after.
- **Reversible**: A1.1–A1.2 (config only), A1.3, B1.3, C1.4.

## Verdict

A plan is PLANNED-COMPLETE iff the coverage matrix has no blank rows, every attack ends in
HELD with cited steps and premises or an accepted hole with a written reason, and no premise
failed reverification.

Result: **PLANNED-COMPLETE** — 14 attacks, 10 holes repaired (A1→A1.4, A4→C1.5, A8→A1.5,
A9→B1.1 amendment, A10→C1.6, A11→A1.6, A12→B1.5 rewrite, A13→A1.2 amendment, A14→P25
promotion, plus A1/A8 jointly forcing the mutual-exclusion constraint), 2 holes accepted
(A3 intermediate-state, A6 watch race), 2 HELD.

The second pass (A11–A14) was run by a fresh adversarial context given only the Definitions,
Premises, and Design Phases — not this attack record. It verified all 25 original premises as
reproducing, and found four holes, two of them ship-blockers that invalidated a step's stated
validation (A11, A12). That distribution is the expected shape: the evidence base held, the
cross-step bookkeeping did not.

Remaining known risks, carried into implementation rather than resolved on paper:
- C1.2's preferred fix (content-based re-export detection) has no measured cost. The step
  requires measuring both options against P18's four variants before choosing.
- A1.6's generated matrix is descriptive, not normative. Reviewing it by hand is the step where
  architectural judgment enters; a rubber-stamp review would encode the five cycles as policy
  and defeat the entire plan.
- Phase A ships `diff-gate` red until B1.7 (A3, accepted). This is intentional and sequenced,
  but it means the `boundary-refinement` group must not be interrupted by an unrelated release.

## Files

**Create**: `src/queries/internal/diff-gate-types.ts` (moved), `src/queries/internal/baseline-resolution.ts` (moved)
**Edit**: `.scipquery.json`, `src/queries/graph/architecture.ts`, `src/domain/config-types.ts`,
`src/runtime/config.ts`, `src/queries/impact/diff-gate.ts`, `src/queries/cleanup/doc-drift.ts`,
`src/source/source-evidence.ts`, `src/source/ast/ast-core.ts`,
`src/symbols/references/caller-evidence.ts`,
`src/semantic/typescript/reference-fragment-shadow.ts`, `src/runtime/commands/command-descriptors.ts`
**Move**: `src/runtime/commands/query-command-specs.ts` → `src/runtime/query-commands/`
**Delete**: `src/core/`, `src/resolution/`, forwarders at `caller-evidence.ts:11-27`
**Verify**: `tests/queries/graph/architecture.test.ts`, `tests/queries/graph/cycles.test.ts`,
`docs/COMMAND_REFERENCE.md` (must remain unchanged)

---

## Execution Outcome (2026-07-24)

**Result: complete.** 39 boundaries, 348/348 files mapped, 0 unmapped, 0 ambiguous,
39/39 dependency rows, 0 forbidden edges, 0 cycles, 0 coarse boundaries.
`diff-gate` passes (2 advisory doc-reference findings, none blocking). 1437/1437 tests pass.

### Deviations from the plan

- **B1.5 was rewritten during execution.** The adversarial pass proved the planned move of
  `query-command-specs.ts` would only re-route the edge, because `command-descriptors.ts`
  imports it and stays in `commands/` (P27). Executed instead as a directional split:
  `src/runtime/command-kit/` holds the five modules `query-commands` imports; `commands/`
  keeps the registry. Direction is now `commands -> query-commands -> command-kit`.
- **B1.1/B1.2 grew into a `src/source` reorganization.** At directory granularity the source
  cycle was unfixable by import edits: `src/source/*` held both the lowest layer
  (`source-text.ts`) and the highest (`ast.ts`, a facade over `ast/**`). Measured the intended
  layering, then realized it structurally — `primitives/`, `ast/`, `facts/`, `vue/`, products at
  root — moving 23 files. `vue-sfc.ts` and `vue-script.ts` moved down into `ast/` as SFC parsing
  primitives, which removed both Vue back edges without needing the planned registration seam.
- **Two boundaries the plan never identified** were caught by the new detector once it was
  gated: `language-parsers` (`utils.ts` imported only by `languages/*`) and `reindex`
  (`index.ts` orchestrator sharing a directory with the augmentation primitives `vue/` needs).
  Both were the same root pattern as `src/source` and were fixed the same way.
- **C1.5 was removed, not implemented.** The planned Rust submodule rule was written as a
  directory-nesting suppression and silently hid the `queries` and `semantic` findings. Rust
  `mod.rs` files fall out through the content-aware barrel rule instead, because a pure
  `pub mod x;` file defines nothing of its own.

### Validation performed

The detector was run against the pre-change tree in an isolated git worktree using the original
14-boundary config: `requireAcyclic` reported 0 cycles, `detectCoarseBoundaries` reported exactly
the 6 boundaries of P7, and `narrowestEdges` named the exact imports Phase B removed. On the
repaired tree it reports 0. Both directions covered.

### Remaining gaps — closed in follow-up (commit `05a7304`)

The five gaps this plan left open were audited immediately afterward. Four were
real and are now enforced; one was not real.

| Gap | Outcome |
| --- | --- |
| Test files outside enforcement | Closed by `testPaths`. The check needs no index — `getSourceText` reads from disk — and judges each test against the boundary of the code it covers, allowing the subject's transitive reach plus any boundary that reaches the subject. |
| Layer inversion inside one directory | Closed by per-boundary `subUnits: 'file'`. |
| Policy minimality unchecked | Closed by `requireMinimalPolicy`. |
| Dynamic `import()` counted as a static edge | **Not real.** Measured with `deps`, which uses `scipEdges: 'all-references'`; `architecture` uses `'imports-only'`, which never includes dynamic edges. The detector written against that premise was removed rather than shipped. |
| No growth limits | Closed by `maxBoundaryFanOut` and `maxBoundaryFiles`. |

A sixth signal was added along the way: `fragileEdges` reports a boundary
dependency resting on a single import (61 of 251 here). It is advisory — a
fragile edge is incidental rather than wrong — so it carries no finding
identity and cannot block a diff.
