# Architecture audit — 2026-09-07

Status: audit complete. All five findings are fixed and verified; see [the fix record](2026-09-07-architecture-fixes.md). The evidence below describes the original review baseline, `a21c01de`, and retains historical source locations.

## Implemented dispositions

| Finding | Final repair |
| --- | --- |
| A1 | File-owned cache keys are explicit and normalized; arbitrary range keys clear conservatively. Real stale-flow regressions pass. |
| A2 | One shared safety classifier and one TypeScript decision govern graph preparation and emission. Full replacement now includes unchanged documents. |
| A3 | Removed the startup allowlist; the fast parser owns eligibility. Shared CLI defaults and exact integers are checked against canonical parsing. |
| A4 | Nine runtime owners and one property-verification owner have explicit directions. Same-directory cycles are checked. Indexed architecture now includes compiler-resolved current TS/JS imports and qualifies unavailable evidence. |
| A5 | Current guidance replaced; original migration records archived byte-for-byte under an explicit snapshot notice. |

Final checks: **3,416 tests across 392 files pass**; build, lint, type checks and public API compatibility pass. Current-source review has zero findings across 569/569 eligible TS/JS files. Indexed architecture maps 582/582 files under 56 rows with no policy findings. See [the complete result record](2026-09-07-architecture-fixes.md) for intermediate failures, repairs and coverage limits.

## Purpose and scope

Evaluate whether the repository's division of responsibilities helps an agent change behavior correctly without discovering hidden coordination or creating a competing implementation. A module is a group of code assigned a responsibility; its interface includes the inputs, outputs, errors, effects, and ordering that its consumers must understand.

The current-source inventory covers 568 of 568 eligible production TS/JS files in 43 groups. All files are mapped to configured boundaries; all 47 dependency-policy rows are declared. The indexed architecture check maps 563 files and passes its configured checks. These are different inventories, not a claim that every file has received a behavioral review. Tests and unsupported languages are outside the production source inventory. One dynamic import in `scripts/bench-native-symbol-leaf.mjs` cannot be resolved statically.

## Investigation checklist

- [x] Inventory current source, declared dependency directions, and coverage.
- [x] Read the previous behavior/ownership audit; preserve justified distinctions and do not re-report repaired defects.
- [x] Assess architecture-policy granularity against actual responsibilities.
- [x] Trace ownership of incremental-index update decisions and generation publication.
- [x] Trace the places an agent must edit to add or change a query operation.
- [x] Assess runtime composition, lifecycle ownership, and storage/source coordination.
- [x] Assess semantic/provider and query boundaries; distinguish intentional adapters from duplicate owners.
- [x] Record confirmed concerns, rejected candidates, recommended owners, and verification requirements.

## Review constraints

File size, export counts, and dependency breadth locate candidates; they do not prove a design defect. Each finding needs an implementation, a live consumer, a plausible change consequence, and counterevidence. Existing clean checks establish compliance with the configured policy, not that the policy describes an ideal design. The original assessment below remains a baseline record; the separately authorized implementations and checks are tracked in the fix record.

## Assessment

The foundation has useful boundaries: domain values do not import workflows, storage does not import queries, and compiler-specific implementations sit behind shared semantic operations. The main remaining risks are rules that callers must remember across boundaries. This audit found one reproducible cache defect, two sources of duplicated decisions, a limitation in the runtime dependency policy, and outdated architecture guidance. It does not justify a repository-wide rewrite.

| Order | Finding                                                         | Evidence strength                                                                 | Disposition                                                                            |
| ----- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1     | A1: File invalidation does not clear local-flow ranges          | Reproduced incorrect result through real source/parser/cache APIs                 | Fix first and strengthen the cache contract                                            |
| 2     | A2: Incremental planning has overlapping owners                 | Exact live decisions; previous add/restore defect demonstrates divergence         | Consolidate the shared safety decision while retaining TypeScript-specific refinements |
| 3     | A3: Fast-path dispatch and option policy are hand-synchronized  | Exact duplicate lists/defaults; two obsolete startup-list entries                 | Share lightweight metadata; preserve separate execution paths                          |
| 4     | A4: Runtime policy cannot express its internal responsibilities | Exact configuration/analyzer behavior; synthetic check confirms granularity limit | Define narrower responsibilities before changing allowances                            |
| 5     | A5: The target architecture guide describes removed modules     | Current guide differs from current configuration                                  | Separate current guidance from historical migration records                            |

## A1 — File invalidation does not clear cached local-flow ranges

A cache retains a computed result for reuse. Invalidation removes a retained result when it can no longer support the requested observation. Here the storage factory and semantic consumer disagree about the identity used for invalidation.

- **Implementation:** `src/storage/per-db-cache.ts:90` accepts an arbitrary key type, but its registered `clearFile` casts a file path to that type and deletes exactly that key (`:119–125`). The requirement that a `source-file` cache use normalized file paths exists in a comment (`:8–11`), not in its interface.
- **Violating consumer:** `src/semantic/local-flow.ts:15` registers in `source-file` but keys results by `relativePath + NUL + startLine + NUL + endLine` (`:35–36`). A file path cannot equal that composite key. The cache hit also bypasses reading source.
- **Live relationships:** `clearSourceFileEvidenceCaches` (`src/queries/internal/cache-invalidation.ts:27`) supplies normalized file paths. `dead.ts:511` uses that clearing operation after source-file processing. Local-flow results feed `dependence-slice.ts:53`, `program-data-edges.ts:259`, and `slice-cohesion.ts:670`.
- **Reproduction:** Compute flow for a function containing `oldValue`, rewrite the same temporary file with `newValue`, clear that file through the shared API, and query the same range on the same database identity. It still reports `oldValue`. Whole-project clearing followed by the same query correctly reports `newValue`. The equality assertion failed with old names in both points and edges. The reader, TypeScript parser, cache factory, and invalidation functions were real; the database argument supplied only the project-root configuration this source operation uses.
- **Maintenance consequence:** An agent adding a cache can correctly declare its invalidation group and still silently violate the clearing protocol. Consumers then need hidden knowledge of the cache's key format or must clear the whole project.
- **Proposed owner/interface:** Keep invalidation in storage. Make file ownership explicit for file-derived caches, including any range subkeys; use the existing source-aware cache facilities where suitable. Remove the unsafe assumption that an arbitrary generic key can be reconstructed by casting a file path. Adapt local-flow caching to that contract rather than add a second clearing registry.
- **Preserve:** Per-database isolation, bounded retained work, several ranges per file, whole-project/semantic clearing, and existing flow coverage disclosures. A per-file map must not accidentally introduce an unbounded range cache.
- **Checks for the fix:** Same-file edit/clear/requery must match a fresh computation; clear every range for the selected file; exercise a second file, normalized paths, eviction, missing-source recovery, and whole-project clearing. Audit other `source-file` registrations for the same key-contract error.
- **Counterevidence and limit:** New database identities and whole-project clearing avoid this reproduction. The nearby dependency-digest cache (`src/semantic/symbol-evidence.ts:281–289`) uses the file path directly, so it does not exhibit this particular key mismatch. This audit demonstrates the shared API defect, not an incorrect output from every current CLI lifecycle. It does not establish transitive invalidation correctness for all caches.

The central registration mechanism remains valuable. This finding revises the earlier assessment that registration alone establishes correct cache clearing: it establishes membership, but a registered callback can still target the wrong identity.

## A2 — Incremental update scope has overlapping owners

An affected-file plan selects files whose indexed facts may change after an edit. The safety decision is whether the available dependency evidence justifies selecting only some files, or whether the compiler must refresh the project.

- **Implementation:** `classifyAffectedSetFallback` (`src/reindex/affected-set.ts:29–43`) widens for additions, deletions, configuration, ambient declarations, identity changes, and uncertainty. `typeScriptProjectReplacementRequired` (`src/reindex/typescript-incremental-index.ts:330–346`) independently decides overlapping cases plus TypeScript limits and compiler identity.
- **Consumers:** The generic decision drives shadow planning (`affected-shadow.ts:800–812`) and source warming (`reindex/index.ts:2277–2309`). The TypeScript decision drives actual update planning (`typescript-incremental-index.ts:175`) and whether dependency-graph materialization is required (`:664–695`). Its specialized planner passes only selected modifications to the generic planner and separately handles deletions (`:348–405`).
- **Concrete evidence of drift:** The generic rule already widened additions, while the TypeScript route previously rebuilt only the added file. The real delete/publish/restore history caught unresolved consumers; `a21c01de` repaired that behavior. Current tests at `tests/reindex/typescript-incremental-index.test.ts:180–223` confirm additions now refresh the project. The specialized partial-update helper still carries `addedPaths`, although its live caller now selects project replacement for compiler additions.
- **Maintenance consequence:** An agent changing a safety condition must discover both decision functions, their different input filtering, and their consumers. Changing only the apparently general planner does not necessarily change actual TypeScript indexing.
- **Proposed owner/interface:** One explicit index-update decision should own shared uncertainty and widening reasons. TypeScript should supply verified compiler-specific refinements and execute the resulting plan. Graph preparation and emission should consume the same decision rather than independently reconstruct it. Remove obsolete partial-addition handling after checking its live call contract.
- **Counterevidence:** Generic conservative planning and TypeScript planning are not interchangeable. TypeScript distinguishes semantic from nonsemantic edits, filters active project configurations, partitions workspaces, and can use the old graph to refresh dependents of deleted files. Its deletion traversal deliberately differs from traversal restricted to currently existing files. Do not merge the two traversal implementations merely because their loops look similar.
- **Preserve/check:** Retain ordinary-edit efficiency, deletion consumers, ambient/configuration handling, workspace ownership, unsupported-case rejection, graph reuse, and publication behavior. Run the existing real compiler histories against clean rebuilds, plus decision-table cases for each permitted TypeScript refinement. The previously found production bug is fixed; this is remaining structural risk, not a claim that the fix failed.

## A3 — Fast-path command policy requires coordinated edits

The fast path serves selected compact machine requests before loading the full CLI. Keeping that cheaper startup path is justified; maintaining independent copies of which commands and defaults it supports is avoidable coordination.

- **Implementation/consumer:** `src/runtime/cli.ts:5–29` owns a startup allowlist and loads the fast path at `:35–41`. `src/runtime/query-service-fastpath.ts:370–395` owns another command-to-parser list.
- **Observed drift:** The startup list contains `trace` and `value-flow`; the complete parser map contains neither. These invocations load the fast-path module, return no parsed invocation, and fall through to the full CLI. This is obsolete routing metadata, not evidence of a wrong query result.
- **Another duplicated rule:** Search defaults are independently `context: 2` and `limit: 6` in the fast parser (`query-service-fastpath.ts:724–756`) and the canonical descriptor (`query-commands/navigation.ts:1309–1329`). Flag spellings and validation are also encoded separately.
- **Maintenance consequence:** An agent changing a default or supported invocation must discover the startup list, fast parser, and command descriptor. A default changed in only one path can make behavior depend on which route handles the request.
- **Proposed owner/interface:** Use lightweight, behavior-free command metadata for fast-path eligibility and shared option policy, consumed by both adapters without loading query implementations at startup. Remove the stale entries and duplicated default ownership. Avoid an elaborate second command-definition framework.
- **Counterevidence:** The fast parser deliberately accepts a subset and returns `null` for unsupported forms; full Commander parsing supplies normal errors. CLI ordering, public package exports, and background request handlers have different consumers and should retain their existing owners. The earlier decision to keep client/server/entrypoint separation stands.
- **Preserve/check:** Verify every accepted fast invocation has the same normalized operands, defaults, options, output handling, and exit status as the canonical route. Unsupported forms must fall through without partial output. Retain profiling behavior and the separate startup bundle. Existing parser/output tests passed, but their passing alone does not establish equivalence for every invocation.

## A4 — The runtime dependency boundary is too coarse to enforce its distinct roles

- **Configuration:** `.scipquery.json:126–178` groups 48 top-level files into `runtime-services`, from skill installation and update notices to query delivery, watching, output transport, and TypeScript request workers. They share one allowed-dependency row (`:479–497`). Their roles have different effects: for example, `setup.ts:35–65` installs user-level skill links; `query-service.ts:1–80` handles background query transport and session policy; `cli-main.ts:80–90` composes project preparation.
- **Check limitation:** Boundary rules govern relationships between named groups. `requireResolvedBoundaries` defaults to grouping members by directory (`queries/graph/architecture.ts:291,570–608`). All these service files occupy the same directory, so their relationships disappear at that grouping step. The same issue applies to flat portions of `reindex`; increasing a file-count allowance cannot express ownership.
- **Verification:** A synthetic pair of mutually dependent files under `src/runtime/` produced zero coarse-boundary findings with directory grouping and one with file grouping. This demonstrates analyzer scope, not an actual cycle in this repository. File-cycle scanning is a separate source of evidence.
- **Maintenance consequence:** A future dependency from query delivery into skill-installation workflow would remain inside one group. The configured direction rules cannot reject it even if maintainers intend those responsibilities to remain separate.
- **Proposed next step:** Map existing consumers to explicit responsibilities: installation/configuration, evidence output, query execution, and background refresh are candidates. Record intended directions and the orchestration owner, then partition exact file membership and close the corresponding rows. Start with policy where no file moves are needed. File-level subunits can expose cycles but do not replace responsibility-based rules.
- **Counterevidence/limit:** Shared runtime placement and broad dependencies are not by themselves code defects. Runtime composition legitimately knows several lower layers. No present forbidden internal direction or actual same-directory cycle was established. This is an enforcement gap and a design task, not justification to split files until a count passes.
- **Checks:** Current allowed relationships must retain their behavior; a synthetic prohibited direction should fail the proposed policy; mapping must remain complete and unambiguous. Do not merely allow every existing edge or change size limits to make a proposed split pass.

## A5 — Current architecture guidance and migration history are mixed

- **Evidence:** `docs/architecture/scip-query-target-architecture.md:34–47` presents a July snapshot of 351 files and 34 boundaries under “Current Evidence.” Its “Enforced Boundary Responsibilities” still lists `queries-compatibility` (`:66`) and `tla` (`:94`), and its target flow includes TLA (`:101`). Neither boundary exists in the current complete configuration. The newer filesystem boundary is also absent from that table, though a later migration entry discusses it.
- **Maintenance consequence:** An agent consulting this target guide has to determine which statements remain current and which describe retired implementations before choosing an owner. The guide can suggest extending a boundary that has been removed.
- **Proposed owner/change:** Keep a short current architecture guide with present responsibilities, justified dependency directions, and links to configuration/source. Move historical measurements and migration ledgers to a dated record. Preserve the useful reasoning about consumer-owned contracts, generation leases, and symbol/semantic direction. Remove obsolete modules from current guidance.
- **Counterevidence:** The document is dated and several sections explicitly discuss history. No current skill was shown to require this guide; references found include older plans and reviews. Therefore this is a documentation maintenance issue, not a demonstrated cause of a recent agent mistake.
- **Checks:** Compare every current boundary name against configuration, validate source links, and label any retained measurement with its date and scope. A numerical score is unnecessary.

## Decisions to retain

| Area                                  | Evidence and decision                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Foundation direction                  | Current dependency reports show `domain` with no internal outgoing dependency files, `platform -> domain/filesystem`, and `storage -> domain/filesystem/instrumentation/platform`. Preserve the separation from query and runtime workflows.                                                                                                                             |
| Source versus semantic evidence       | Source parsing and compiler-backed relationships establish different facts. `semantic/shared-primitives.ts:76–87` exposes named evidence operations and capability information; `semantic/local-flow.ts:28–52` explicitly reports unsupported source/coverage. Do not merge these mechanisms based on similar names. This review does not certify every provider result. |
| Provider construction and lifetime    | `semantic/provider-cache.ts:15–41` centralizes language-specific construction; `session-manager.ts:14–60` shares providers per database identity and language and registers disposal. Retain this owner. Disposal failure behavior was not newly fault-tested here.                                                                                                      |
| Cache registry                        | Factories register when their caches are created, and composite analyses name clearing moments rather than enumerate cache modules. Keep that mechanism; A1 requires a sound key/ownership contract at the same boundary.                                                                                                                                                |
| Public exports versus CLI descriptors | Published names map to implementation paths in `public-query-entries.ts`; `service-queries.ts` is a small service-facing export surface; CLI families and explicit ordering assemble descriptors with missing-order checks. These are different consumers, not duplicate query engines.                                                                                  |
| Query service and full CLI            | The fast route returns control to the canonical route when unsupported or unavailable. Existing tests cover silent fallback, pagination, serialized bytes, and command-specific exit status. Retain execution roles; A3 concerns shared policy metadata.                                                                                                                 |
| Publication and readers               | The recent state-verification audit traces one immutable artifact publication owner, authoritative generation-pointer acceptance, reader leases, and recovery. Its real process-failure tests support retaining that design. File length alone does not justify extracting another publication coordinator.                                                              |

## Verification and coverage

- Newly run: `system --source`, `architecture`, scoped runtime/reindex inventories, explicit incoming execution evidence for the planning decisions, and exact implementation/consumer reads. Bounded graph edges marked candidate were confirmed with source before use.
- Newly run: `npx vitest run tests/queries/graph/architecture.test.ts tests/reindex/typescript-incremental-index.test.ts tests/runtime/query-service.test.ts tests/runtime/query-service-fastpath.test.ts` — **141 tests in four files passed**.
- Newly run: the synthetic same-directory cycle check described in A4 — expected grouping distinction confirmed.
- Newly run: a temporary Vitest reproduction for A1 — **one assertion failed**, demonstrating stale local-flow points and edges after file invalidation; the fresh whole-project result passed its `newValue` check. Log: `/tmp/scip-query-architecture-local-flow-repro.log`. The temporary test and source fixture were removed; the reproduction recipe is retained below. An initial direct runner attempt could not load the uninstalled `tsx` package and executed no test; Vitest supplied the actual reproduction.
- Prior evidence reused, not rerun: [state verification](2026-09-07-indexer-state-verification.md) recorded 3,363 tests across 387 files, real compiler histories, writer interruption/recovery, and a zero-finding source scan at this baseline. That result did not cover the newly demonstrated A1 case. [Behavior/ownership audit](2026-09-07-behavior-ownership-audit.md) and [coordination decisions](2026-09-07-cleanup-integrity-implementation.md) supplied retained-design counterevidence.
- This is repository-wide structural coverage plus behavioral investigation of selected central paths. It is not a line-by-line review of every module, every cache registration, Rust/native internals, release tooling, parser language, operating-system schedule, or dynamic dependency. The indexed report covers its indexed generation; the TypeScript file changed at the baseline was read from exact current source where semantic alignment was stale. No agent benchmarks, full-suite rerun, VM deployment, or production refactor were performed for this audit.

### Reproduction to turn into a regression test for A1

Use the real `semanticLocalFlowForRange` and the two clearing functions; supply a database-shaped object with `config.projectRoot` pointing at a temporary directory. These source-backed operations require no SQLite calls. Clean up the directory and whole-project caches in `finally`.

```ts
writeFileSync(file, 'export function flow(input: number) { const oldValue = input; return oldValue; }\n');
const before = semanticLocalFlowForRange(db, 'flow.ts', 0, 1);
expect(JSON.stringify(before)).toContain('oldValue');

writeFileSync(file, 'export function flow(input: number) { const newValue = input; return newValue; }\n');
clearSourceFileEvidenceCaches(db, 'flow.ts');
const afterFileClear = semanticLocalFlowForRange(db, 'flow.ts', 0, 1);

clearWholeProjectEvidenceCaches(db);
const afterWholeClear = semanticLocalFlowForRange(db, 'flow.ts', 0, 1);
expect(JSON.stringify(afterWholeClear)).toContain('newValue');
expect(afterFileClear).toEqual(afterWholeClear); // Fails at a21c01de: still oldValue.
```

## Follow-up work, in order

- [x] A1: Add the permanent failing regression, repair file/range invalidation ownership, and inspect sibling registrations for the same contract misuse.
- [x] A2: Plan and consolidate incremental safety decisions; retire unreachable partial-addition handling with real compiler-history checks.
- [x] A3: Consolidate lightweight dispatch/default metadata and add canonical-versus-fast-route contract cases.
- [x] A4: Define runtime responsibility boundaries and enforce justified directions without widening the policy.
- [x] A5: Publish a concise current architecture guide and preserve dated historical decisions separately.
