# SCIP Maintainability Register

Date: 2026-06-09. Scope: whole repo, evidence from `scip-query` index built 2026-06-09 16:29 (186 files, 6,965 symbols) plus direct reads. Health score is 100 with zero dead/cycle/drift findings — this register is about what the detectors cannot see: scattered policies, hand-synchronized surfaces, and partially-adopted lifecycles.

## Executive Read

The codebase is deliberately structured and the command surface is genuinely descriptor-owned: `docs/COMMAND_REFERENCE.md` is generated (`src/runtime/command-docs.ts:27-51`) and contract-tested (`tests/cli-contract.test.ts:67-73`). The three real pressures are:

1. **The detector exclusion policy is folklore.** "What does not count as a finding" (test files, Rust test modules, barrels, entry surfaces, public/rooted symbols) is implemented per-detector with different mechanisms. Symptom visible today: `stale-abstractions` flags 11 published `*Result` contract types — including `PlanContextResult`, which is a `package.json` subpath export — as "premature abstraction," because only `dead.ts:203` and `health.ts:478` apply `isRootedSymbol`.
2. **The public query list is hand-maintained in three places** (`package.json` exports, `tsup.config.ts:3` `publicQueryEntries`, `tests/cli-contract.test.ts:98-144` `publicQuerySubpaths`), and the tsup↔package.json sync has no enforcement at all — a missing tsup entry ships a broken export.
3. **Cache invalidation membership is a hand-maintained registry** (`cache-invalidation.ts:31` `CACHE_REGISTRY`) even though every cache is created through one factory that already receives — and discards — its identity (`src/storage/per-db-cache.ts:27` `createPerDbCache(_name)`). A new cache can silently miss invalidation.

## Scope Map

| Cluster | Files | Role |
| --- | --- | --- |
| Command surface | `src/runtime/command-*`, `query-command-*`, `query-commands/*` (7 family files) | Descriptor-owned CLI; docs generated; specs aggregated with runtime order check (`query-command-specs.ts:76-79`) |
| Detector family | `src/queries/{dead,stale-abstractions,wrapper,passthrough,extract,similar*}.ts` + `src/queries/internal/*` | Candidate → evidence → gate → score → report detectors |
| Evidence caches | `src/storage/per-db-cache.ts`, `src/queries/internal/cache-invalidation.ts`, ~15 per-db caches + provider-instance caches | In-memory evidence memoization with explicit invalidation |
| Reindex/augment | `src/reindex/*`, `augment-vue-{contracts,runtime,worker,workers}.ts` | Indexer orchestration; Vue augmentation across a worker boundary with disk fingerprint cache |
| Public library surface | `package.json` exports, `tsup.config.ts`, `src/queries/index.ts`, `src/index.ts` | Per-query subpath exports; root kept minimal (enforced by `cli-contract.test.ts:162-170`) |
| Docs/skills | `docs/*`, `skills/*/SKILL.md`, `scripts/render-command-reference.ts` | Generated reference + hand-authored workflow guidance |

## Smell Ledger

| Priority | Smell | Evidence | Why it hurts | Better shape | Disposition |
| --- | --- | --- | --- | --- | --- |
| 1 | Detector exclusion policy scattered across mechanisms | Test files: SQL patterns `internal/dead-candidate-gate.ts:79-82` vs `index.fileKind()` inline at `wrapper-candidates.ts:138-140` and `similar.ts:380`. Rust test modules: `wrapper-candidates.ts:87` vs `similar.ts:381`, no shared gate. Public surface: `isRootedSymbol` applied at `dead.ts:203`, `health.ts:478,489` — absent from stale-abstractions, wrapper-, passthrough-, extract-candidates. Barrels: `dead.ts:96` vs consumer partition in `stale-abstractions.ts:195-199` | Each new detector re-decides correctness policy; existing detectors disagree (stale-abstractions flags published API types today — 11 false positives in this repo's own output). Fixing a policy bug means finding N implementations | One named gate (`internal/finding-gate.ts` or extend `analysis/file-classifier.ts`) exposing `excludeFromFindings(db, def, {tests, rustTestMods, barrels, entrySurface, rootedSymbols})`; each detector declares which exclusions apply, mechanism is shared | `enforce` |
| 2 | Detector lifecycle template adopted by only 2 of 7 detectors | `runCandidateAnalysis()` `internal/candidate-scan.ts:18-35` used by `wrapper-candidates.ts:47`, `passthrough-candidates.ts:38`; `dead.ts:74-232`, `stale-abstractions.ts:78-132`, `extract-candidates.ts:51-84` re-implement candidates→limit→evidence→evaluate→order→slice manually | A maintainer cannot trust the template to describe the family; scan-limit/ordering fixes must be repeated per detector | Migrate `stale-abstractions` and `extract-candidates` onto `runCandidateAnalysis`. `dead` (multi-source evidence merge) and `similar-files` (pairwise comparison) are different shapes — leave them | `merge` (partial) |
| 3 | Public query list triple-maintained, tsup sync unenforced | `package.json` exports (~44 `./queries/*` entries), `tsup.config.ts:3-50` `publicQueryEntries`, `tests/cli-contract.test.ts:98-144` `publicQuerySubpaths`. Adding `plan-context` touched all three by hand (current diff). No test reads `tsup.config.ts` | Forget tsup → export resolves in types but `dist/` file missing at runtime for consumers; forget the test list → test passes silently with missing export | Single manifest: export `publicQueryEntries` from one module; tsup imports it; test derives expectations from it *and* from `ls src/queries/*.ts` minus the private list (`query-utils`, `drift-policy`, `dead-exclusions`, `health-*`) | `generate` |
| 4 | Cache identity exists at creation but invalidation membership is hand-listed elsewhere | `createPerDbCache(_name)` discards `_name` (`per-db-cache.ts:27,54,85`); `CACHE_REGISTRY` `cache-invalidation.ts:31-52` hand-maps kinds to clear functions; `WHOLE_PROJECT_CACHE_KINDS` `cache-invalidation.ts:54` is a second hand list. `FILE_DEFINITION_CACHE` has per-file clear only (`definition-catalog.ts:36`, registry line 51); `FILE_USAGE_CACHE` cleared only from `health.ts:439` | A new evidence cache compiles and works but silently misses whole-project invalidation — stale-evidence bugs in long-lived processes (`watch.ts`) with no failing test | Make the factory register: `createPerDbCache(name)` records its clear function in the registry at creation; `clearEvidenceCaches` iterates registrations. The hand list becomes impossible to drift | `enforce` |
| 5 | Skill docs reference commands with no contract check | `readDocumentedCommands` covers README/AGENT_GUIDE/COMMAND_REFERENCE only (`cli-contract.test.ts:55-59`); `skills/*/SKILL.md` contain 178 `scip-query <cmd>` mentions, unchecked | A renamed/removed command rots silently in the skills that agents actually load | Add `skills/*/SKILL.md` to the documented-commands scan (same regex, same descriptor-backed assertion) | `enforce` |
| 6 | `BUILTIN_SKILLS` hand-list vs `skills/` directory | `setup.ts:8-16`; test only spot-checks two names (`setup.test.ts:73-74`) | New skill directory ships but never installs; spot-check test invites copy-paste growth | Test asserts `BUILTIN_SKILLS` equals `readdirSync('skills/')`; keep the const (needed at install time from packaged dist) | `enforce` |
| 7 | Scope-keyed dep-graph cache can serve stale graphs in long-lived processes | `FILE_DEP_GRAPH_CACHE` keyed `(db, scope ?? '')` `file-dep-graph.ts:6,15`; cleared only via whole-project clears | In `watch` mode, scoped queries between reindexes can read pre-edit graphs | Covered by item 4's registration fix if per-file clears also drop scoped entries; otherwise document the invariant at the cache site | `supersede` (into 4) |
| 8 | Render shapes partially adopted | 5 shapes in `render.ts:53-130`; `dead`, `extract-candidates`, `similar`, `similar-files` hand-roll (`query-commands/cleanup.ts:23-107,128-148,223-308`) | Mild: inconsistent output idiom; but `renderShape: 'custom'` is declared honestly in descriptors | Leave. The custom reports are genuinely custom layouts (two-section dead report, cluster trees). Only act if a sixth shape emerges twice | `skip` |
| 9 | `domain/query-result-types.ts` is a 3-line `export {}` signpost | File contains only a comment + `export {}`; re-exported by `domain/types.ts` | One file of pure ceremony; trivial | Delete file + barrel line, move the comment to `queries/index.ts` where the types actually live | `delete` |

## Compression Opportunities

### C1 — Finding gate (ledger 1) — shape-level
Replaces five local exclusion idioms with one named policy mechanism. Models considered: (a) conservative — copy `isRootedSymbol` calls into each detector: fixes the symptom, deepens the scatter; (b) shape-level — one `excludeFromFindings` predicate with per-detector flags: removes the policy duplication, keeps essential per-detector differences as declared flags; (c) radical — push gating into `runCandidateAnalysis`: couples gate adoption to lifecycle adoption, blocks `dead`/`similar` which don't use the template. **Choose (b).** Blast radius: 6 detector files + `file-classifier.ts`; behavior change limited to *intended* fixes (stale-abstractions stops flagging rooted symbols — update `tests/stale-abstractions-accuracy.test.ts` expectations deliberately).

### C2 — Cache self-registration (ledger 4, absorbs 7) — shape-level
`createPerDbCache(name, {clearScope: 'whole-project' | 'per-file' | 'both'})` registers its clear functions at creation; `cache-invalidation.ts` iterates registrations instead of hand-listing. Deletes `CACHE_REGISTRY` and `WHOLE_PROJECT_CACHE_KINDS` as hand-maintained data. The unused `_name` parameters prove every call site already supplies identity. Risk: registration order/test isolation — registrations are module-scope, same as the caches themselves, so no new lifecycle. Verify with `tests/debloat-health.test.ts`, `tests/watch.test.ts`.

### C3 — Single public-query manifest (ledger 3) — generate
One exported `PUBLIC_QUERY_ENTRIES` array; `tsup.config.ts` maps it to entries; `cli-contract.test.ts` derives both the package.json assertion and a filesystem-completeness assertion from it. Deletes two of the three hand lists. Zero runtime behavior change.

### C4 — Contract-test reach (ledger 5, 6) — conservative
Two test edits: extend `readDocumentedCommands` to `skills/*/SKILL.md`; assert `BUILTIN_SKILLS` ≡ `readdirSync('skills')`. No production code change.

## Deferred Boundaries

- **Vue augmentation family** (`augment-vue-{contracts,runtime,worker,workers}.ts`, 1,608 LOC): the worker process boundary forces the file split (`augment-vue-worker.ts` is a 28-line worker entry — essential). The extract-candidates hit on `augmentVueResolvedReferences()` (5-callee isolated cache cluster) is real but local; revisit only when next touching Vue augmentation.
- **Language parsers flagged 100% similar** (`dotnet/jvm/php`, `ruby/c-like`): similarity is shared *dependencies*, not shared logic — different grammars are essential variation. Also a detector-quality note: `similar-files` scoring on shared deps alone makes unrelated files with common infra deps score 100% (`watch.ts` vs `cli-context.ts` is a false pair).
- **`dead.ts` lifecycle**: stays off `runCandidateAnalysis`; its three-source evidence merge (`dead.ts:97-110`) is a genuinely different shape.
- **Detector self-report quality**: once C1 lands, `stale-abstractions` honoring `isRootedSymbol`/`entryRoots` removes this repo's 11 false positives without per-repo config.

## Status (2026-06-09, end of day)

All four compressions implemented — see `2026-06-09-maintainability-implementation.md` for the
phase-by-phase record. Net: ledger 1 `enforce` done (via package-surface derivation + existing
gate, not a new module), ledger 2 `merge` done, ledger 3 `generate` done, ledger 4+7 `enforce`
done (cache self-registration; three latent invalidation gaps fixed), ledger 5+6 `enforce` done
(the extended scan caught 14 real drift instances in skills on first run), ledger 9 `delete`
done. Ledger 8 stays `skip`.

## Verification Plan

1. `npm test` — full suite; deliberately update `stale-abstractions-accuracy` expectations for C1.
2. `scip-query reindex && scip-query stale-abstractions --include-low-confidence` — expect the 11 published-type false positives gone after C1.
3. `scip-query health --json` — score is a side effect; confirm no new findings categories appear.
4. For C3: `npm run build && node -e "import('scip-query/queries/plan-context')"`-style smoke per entry, or assert `dist/queries/*.js` exists for each manifest entry in the contract test.
5. Re-run probes that motivated the work: `wrapper-candidates`, `passthrough-candidates`, `similar-files` — confirm unchanged candidate sets (no behavior drift from gate unification except intended C1 fixes).
