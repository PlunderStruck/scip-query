# Architecture Coherence: First Implementation Slice

Date: 2026-07-23

## Outcome

Implement the first report-only architecture contract described in `docs/architecture-coherence-vision.md`: project-owned boundary configuration, a reusable boundary-graph analyzer, a public `architecture` query and CLI command, and an expanded agent workflow for applying it to large existing repositories.

This slice does not replace drift's current layer policy, block diffs, modify health scores, or automatically write architecture rules. Those actions depend on the report and configuration semantics proving stable first.

## Start Status

`scip-query status --capabilities` reports a fresh compiler-backed index for this TypeScript repository.

Relevant current behavior:

- `src/queries/cleanup/drift-policy.ts` contains a scip-query-specific `SRC_LAYER_DEPENDENCIES` table selected only by path names.
- `src/queries/cleanup/drift.ts` combines unused imports, hardcoded/inferred layer violations, and opt-in sibling pattern deviations.
- `src/queries/graph/deep-chains.ts` contains a correct iterative Tarjan strongly-connected-component pass, but the algorithm is private to that query.
- `src/symbols/graph/file-dep-graph.ts` already builds the reusable file dependency graph and supports import-only SCIP edges plus source-import fallback.
- `src/runtime/query-commands/graph.ts` is the established extension point for graph report commands.
- `src/domain/config-types.ts`, `src/runtime/config.ts`, and `src/runtime/cli-context.ts` are the established configuration type, validation, and database-propagation seams.
- `skills/scip-directory-architecture/SKILL.md` already owns agent guidance for directory boundaries, so extending it avoids a competing skill with overlapping responsibility.

## Definitions and Sources

An architectural boundary is a named group of code with one stable reason to change. This definition is grounded in the current directory-architecture skill and is expanded in `docs/architecture-coherence-vision.md`.

A dependency edge points from the importer to the imported file. `src/symbols/graph/file-dep-graph.ts` is the implementation source for these facts.

A forbidden edge is an actual cross-boundary dependency rejected by an explicit project-owned dependency row. This differs from drift's current rare-edge inference: absence from a configured closed row is decisive; directory distance is not.

A strongly connected component is a group of graph nodes that are mutually reachable. `src/queries/graph/deep-chains.ts` already proves the required iterative Tarjan implementation on large cyclic graphs.

An architecture signal is graph evidence that warrants review but does not contradict a rule, such as reciprocity or a multi-boundary component. Signals remain report-only in this slice.

## Premises

**P1. Project architecture rules must be project-owned.** Path names alone cannot identify which repository's dependency policy applies. Therefore an unconfigured project must receive no forbidden-edge findings.

**P2. File imports are the evidence; boundary edges are the usable unit.** Individual import floods obscure the design decision. Therefore file edges must be grouped by boundary pair while retaining representative examples and breadth counts.

**P3. Missing policy is different from permissive policy.** A missing `allowedDependencies` row means “not yet declared,” while a present row is closed and rejects unlisted targets.

**P4. Cycles are contextual signals unless acyclicity is declared.** Reciprocal traffic and strongly connected components can reveal false boundaries, but do not prove a defect without a rule or responsibility analysis.

**P5. Large-repository adoption must be incremental.** Boundary paths can be configured before dependency rows, allowing descriptive measurement before enforcement.

**P6. Existing graph algorithms should be reused.** The Tarjan pass in `deep-chains.ts` is sufficient and should be extracted rather than copied.

**P7. Architecture output needs exact dependency semantics.** The query should request import-only SCIP edges, with the existing source-import fallback, rather than treating every cross-file reference as an architectural dependency.

**P8. Agent guidance and machine analysis have different jobs.** The analyzer evaluates declared rules; the directory-architecture skill identifies real responsibilities and decides which rules are mature enough to declare.

## Invariants

1. Same-boundary file edges never become forbidden boundary edges.
2. An unconfigured architecture produces `configured: false`, no forbidden edges, and no implicit repository policy.
3. A boundary without an `allowedDependencies` row remains descriptive; its outgoing edges have unknown policy status.
4. A boundary with an empty row forbids every cross-boundary outgoing edge.
5. Every forbidden boundary edge includes at least one concrete importer/imported-file example.
6. Boundary names are unique and every configured dependency row references known names.
7. A file matching more than one boundary is reported as ambiguous and excluded from policy evaluation.
8. A file matching no boundary is reported as unmapped and excluded from policy evaluation.
9. Strongly connected components are computed once by a shared iterative implementation and used by both `deepChains()` and architecture analysis.
10. Inferred architecture signals do not affect health scores or diff-gate status in this slice.

## Reuse Audit

| Need | Existing candidate | Decision |
| --- | --- | --- |
| File dependency facts | `buildFileDepGraph()` | Reuse with `scipEdges: "imports-only"`. |
| Project-relative glob matching | `matchesGlob()` | Reuse for boundary path patterns; its intentionally narrow exact, `/*`, and `/**` semantics are enough for the first config. |
| Strongly connected components | Inline iterative Tarjan in `deepChains()` | Extract to `src/analysis/strongly-connected-components.ts`; change `deepChains()` to consume it. |
| CLI registration and JSON envelope | Graph command descriptors and `reportCommand()` | Reuse in `src/runtime/query-commands/graph.ts`. |
| Config validation | `validateProjectConfig()` and unknown-key reporting | Extend with architecture keys and referential checks. |
| Architecture agent workflow | `scip-directory-architecture` | Extend; do not create a duplicate skill. |

No new helper or module is justified beyond the shared SCC primitive and the architecture query itself.

## Testability Design

| Behavior | Pure seam or fixture | Required assertion |
| --- | --- | --- |
| SCC extraction preserves deep-chain behavior | Existing `graph-risk-output` tests plus SCC unit test | Cycles condense once; target-only nodes are included; component mapping is complete. |
| Unconfigured safety | `analyzeArchitectureGraph()` unit test | No forbidden findings and `configured: false`. |
| Boundary aggregation | Pure graph/config fixture | Multiple file edges become one boundary edge with correct breadth and examples. |
| Closed-row policy | Pure graph/config fixture | Listed target is allowed; unlisted target is forbidden; missing source row remains unknown. |
| Mapping ambiguity | Pure graph/config fixture | Multi-match and no-match files are surfaced and excluded from evaluated edges. |
| Reciprocal and SCC signals | Pure graph/config fixture | Pair is deduplicated; component membership is canonical; narrowest internal edge is identified by file-edge count. |
| Config validation | `runtime-config.test.ts` | Duplicate names, empty paths, unknown dependency names, invalid booleans, and unknown keys are diagnosed. |
| DB config propagation | CLI-context source/behavior contract | `architecture` reaches `ScipDatabase.config` in normal CLI and agent-hook database paths. |
| CLI/public API | CLI contract and public manifest tests | Command registers in descriptor order; public query entry and package export remain in lockstep. |
| Skill workflow | Generated docs plus skill source review | Command shortlist and discover-declare-measure-ratchet stages remain present after generation. |

## Implementation Steps

### 1. Add project-owned configuration

Files:

- `src/domain/config-types.ts`
- `src/runtime/config.ts`
- `src/runtime/cli-context.ts`
- `src/runtime/agent-hooks.ts`
- `.scipquery.json`
- `tests/runtime/runtime-config.test.ts`

Changes:

- Add `ArchitectureConfig` and `ArchitectureBoundaryConfig`.
- Add optional `architecture` to `ProjectConfig` and `ScipQueryConfig`.
- Validate object/array/string/boolean shapes, unique boundary names, non-empty paths, known dependency-row keys and targets, and unknown keys.
- Copy the project architecture config into every `ScipDatabase` construction path that derives from project config.
- Dogfood the descriptive stage by naming this repository's top-level source responsibilities without closing dependency rows.

Premises: P1, P3, P5.

Validation: focused config tests and typecheck.

### 2. Extract the shared SCC primitive

Files:

- new `src/analysis/strongly-connected-components.ts`
- `src/queries/graph/deep-chains.ts`
- focused graph tests

Changes:

- Move the iterative Tarjan pass without changing its graph semantics.
- Return both canonical components and node-to-component mapping.
- Preserve reverse-topological component order required by `deepChains()`.

Premise: P6.

Validation: existing deep-chain tests plus direct SCC edge cases.

### 3. Implement architecture analysis

Files:

- new `src/queries/graph/architecture.ts`
- new `tests/queries/graph/architecture.test.ts`

Changes:

- Export a pure `analyzeArchitectureGraph()` seam.
- Resolve exact/trailing-star path patterns with `matchesGlob()`.
- Aggregate mapped cross-boundary file edges.
- Classify each edge as allowed, forbidden, or undeclared.
- Report mapping coverage, reciprocal pairs, strongly connected components, and the least-broad internal edges for inspection.
- Wrap the pure seam in `architecture(db, { scope })` using the import-only file graph.

Premises: P1-P7.

Validation: the Testability Design matrix above.

### 4. Expose the report

Files:

- `src/queries/index.ts`
- `src/queries/public-query-entries.ts`
- `src/runtime/query-commands/graph.ts`
- `src/runtime/commands/query-command-specs.ts`
- `package.json`
- generated `docs/COMMAND_REFERENCE.md`
- generated `skills/_shared/SKILL.md`

Changes:

- Add the public query entry and package subpath.
- Register `scip-query architecture` with `--scope` and `--json`.
- Render policy coverage, boundary edges, forbidden edges, reciprocal pairs, and connected components without hiding representative file evidence.
- Label the command evidence as mixed because dependency edges are graph facts while the configured boundary interpretation is project policy.

Premises: P2, P7.

Validation: CLI contract tests, docs generation, build.

### 5. Extend the existing agent skill

Files:

- `skills/scip-directory-architecture/SKILL.md`

Changes:

- Add architecture vocabulary.
- Add the discover, declare, measure, ratchet, and migrate stages.
- Explain layers versus subsystems, packages, and services.
- Require descriptive boundaries before closed dependency rows.
- Use `scip-query architecture --json` after config changes.

Premise: P8.

Validation: skill source review and generated command reference.

### 6. Verify the complete slice

Commands:

```bash
npm run typecheck
npx vitest run tests/queries/graph/architecture.test.ts tests/queries/graph/graph-risk-output.test.ts tests/runtime/runtime-config.test.ts tests/runtime/cli-contract.test.ts
npm run docs:commands
npm test
npm run lint
scip-query config-validate
scip-query reindex
scip-query recent-duplicates
scip-query co-change src/domain/config-types.ts
scip-query co-change src/queries/graph/architecture.ts
scip-query diff-gate
```

## Deployability

The slice is additive:

- projects without architecture config retain existing behavior;
- the new command returns an explicit unconfigured result rather than inferred violations;
- no health score or gate changes;
- public API additions do not remove or rename existing exports;
- `deepChains()` keeps its public contract while moving an internal algorithm.

Rollback consists of removing the new command/config/query and restoring the inline SCC block. No stored data migration is involved.

## Counterexample Attacks

### Attack 1: unrelated repository uses `src/core` and `src/runtime`

Expected: no scip-query-specific forbidden edge appears without project architecture config.

Status before implementation: **HOLE** in drift's current hardcoded layer policy.

Target status for the new command: **HELD**.

### Attack 2: boundary paths overlap

Example: `src/features/**` and `src/features/orders/**`.

Expected: matching files are ambiguous and excluded rather than assigned by declaration order.

Target status: **HELD**.

### Attack 3: policy is only partially declared

Example: `domain` has a closed row, `runtime` has none.

Expected: domain's unlisted outgoing edge is forbidden; runtime's outgoing edge is undeclared, not silently allowed or rejected.

Target status: **HELD**.

### Attack 4: one helper creates reverse traffic between otherwise broad boundaries

Expected: reciprocal pair and SCC are visible; edge breadth shows the reverse edge has one file dependency and is the first inspection candidate. The tool does not order a move.

Target status: **HELD**.

### Attack 5: many imports cross a boundary

Expected: one grouped boundary result with total edge, importer, imported-file, and example counts; no terminal flood.

Target status: **HELD**.

### Attack 6: target-only graph node is absent as a map key

Expected: SCC extraction and mapping still include it as a singleton.

Target status: **HELD**.

### Attack 7: a legitimate plugin system is cyclic by design

Expected: the SCC is a signal when `requireAcyclic` is absent/false. It becomes a declared violation only when the project sets `requireAcyclic: true`.

Target status: **HELD**.

### Attack 8: isolated indexed files do not occur in the dependency map

Expected: wrapper supplies indexed documents separately so coverage counts and unmapped files include isolates.

Target status: **HELD**.

## Coverage Matrix

| Premise | Implemented by | Proven by |
| --- | --- | --- |
| P1 | Config-only policy evaluation | Unconfigured and hardcoded-name tests |
| P2 | Boundary-edge aggregation | Breadth-count test and CLI JSON |
| P3 | Three policy states | Closed/missing-row test |
| P4 | Cycle `violatesPolicy` flag | Acyclic false/true tests |
| P5 | Boundaries without policy rows | Descriptive-config test |
| P6 | Shared SCC module | SCC and unchanged deep-chain tests |
| P7 | Import-only wrapper | fixture/source contract and query test |
| P8 | Expanded existing skill | skill workflow review |

## Derived Verdict

The first slice is sufficient when a maintainer can add descriptive boundaries to a large repository, see the actual boundary graph and its pressure points, close only the dependency rows they understand, and receive concrete forbidden-edge evidence without affecting health or CI. Replacing drift's hardcoded policy is intentionally the next slice because it should depend on these tested semantics rather than being rewritten simultaneously.
