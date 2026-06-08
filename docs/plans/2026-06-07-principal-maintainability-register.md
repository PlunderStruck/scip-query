# Principal Maintainability Register

Date: 2026-06-07
Scope: current checkout of `scip-query`

Review question: what future-maintenance mistakes does this structure invite, and what smaller named mechanisms would prevent them without hiding real variation?

## Executive Read

The repo is healthy in the ordinary sense: `scip-query health --json` reports score 100, no dead symbols, no isolated symbols, no wrappers, no passthroughs, no similar symbol pairs, and no extraction backlog beyond two low-count candidates. The remaining maintainability pressure is therefore not "broken code." It is concept pressure: a few important policies are still implemented as local agreements that future maintainers must rediscover.

The highest-value next slice is not another broad cleanup pass. It is to repair the current architecture drift in project readiness and then deepen the evidence boundary used by `dead` and `stale-abstractions`. Those two detector queries still know too much about SCIP rows, source fallback, semantic fallback, import parsing, ignore policy, and cache invalidation.

A code smell is a visible codebase fact, such as an import edge, repeated comment, large role-mixing file, or one-consumer type, that predicts avoidable future mistakes because the same knowledge must be rediscovered, synchronized, or defended in more than one place.

An evidence policy is the rule a code-intelligence tool uses to decide which observed fact counts as a result when SCIP mentions, TypeScript semantic data, AST data, and source-text fallback data are all partial views of the same program.

Provenance is the recorded origin of an evidence result, such as "source attribution" or "SCIP reference chunk," that lets later code judge how much to trust the result without repeating the lookup that produced it.

A concept boundary is the set of files and exported symbols that should change together because they serve one reason to change. A weak boundary mixes reasons to change, such as runtime command rendering, query option decoding, detector scoring, and public command declaration in one module.

Accidental variation is a code difference that does not correspond to a real difference in behavior, grammar, protocol, or compatibility. Essential variation is a code difference forced by a real difference in those things.

## Current Status

Implementation pass status:

- Project readiness moved from `src/reindex/project-readiness.ts` to `src/runtime/project-readiness.ts`, removing the `src/reindex` -> `src/semantic` dependency that started the drift finding.
- Vue augmentation types were split by role: cross-module/worker contracts live in `src/reindex/augment-vue-contracts.ts`, runtime adapter shims live with `src/reindex/augment-vue-runtime.ts`, and the cache fingerprint is local to `src/reindex/augment-vue.ts`.
- Cleanup command descriptors now use `cleanupCommand()` and `heuristicCleanupCommand()` so Cleanup docs/category and heuristic notice policy are named once instead of repeated in every command descriptor.
- Health full-report assembly now uses the same phase-result composition path as isolated health phases, removing the second parallel health-analysis assembly path.
- Detector consumer evidence now has a named boundary in `src/queries/internal/consumer-evidence.ts`, used by `stale-abstractions` and `wrapper-candidates`.
- Dead-code reference counts now retain evidence provenance in `src/queries/internal/reference-counts.ts`, distinguishing SCIP mention, source fallback, and caller-map evidence while preserving the existing report counts.
- Dead-code candidate gating now has a named boundary in `src/queries/internal/dead-candidate-gate.ts`, so test-file policy and rejection reasons are not local folklore inside `dead.ts`.
- JavaScript parser compression was evaluated in two layers: merging it with other parser adapters would hide essential grammar variation, but splitting its own import, re-export, and Vue non-script identifier facts was justified and completed.
- JavaScript import parsing now uses the shared import-entry emitters while preserving JavaScript-specific type-only, namespace, and used-member facts.
- AST parsing was split by role: `ast-core.ts` owns tree caching and Vue dispatch, `vue-script.ts` owns Vue script extraction, and `ast-facts.ts` owns callable/callsite/type-container facts. `ast.ts` remains the public facade.
- TypeScript-like semantic source classification now lives in `src/semantic/typescript/source-kinds.ts`, so source-file lookup, semantic provider gating, and tsconfig discovery share one extension policy.
- The root package export surface was narrowed for `0.7.0`: `scip-query` now exports core helpers only, while query, reindex, and runtime APIs stay on explicit subpaths.

Evidence commands run:

```bash
git status --short
scip-query health --json
scip-query drift
scip-query similar-files
scip-query stale-abstractions --include-low-confidence
scip-query wrapper-candidates
scip-query passthrough-candidates
scip-query extract-candidates
scip-query deps src/reindex/project-readiness.ts
scip-query rdeps src/semantic/typescript/status.ts
scip-query rdeps src/core/project-index.ts
scip-query rdeps src/queries/internal/candidate-scan.ts
find src tests -type f | xargs wc -l | sort -nr | head -40
rg -n "scip-query: ignore-(extract|wrapper|passthrough|similar|stale)" src
```

Final verified health summary after the JavaScript parser split:

- Score: 100.
- Documents: 171.
- Symbols: 6,608.
- Health findings: 0 stale abstractions and 0 drifted files.
- Top complexity symbols: `shortenSymbol`, `parseSymbol`, `indexedDocumentPaths`, `findFirstSymbolMatch`, `ProjectIndex.productionCallableDefinitions`.
- Wrapper and passthrough probes: no candidates.
- Similar-files probe: parser adapters share dependency profiles, but most of that is now essential variation under the language-parser contract.

Largest current source/test files:

- `tests/command-accuracy.test.ts` - 672 LOC.
- `src/reindex/augment-vue-runtime.ts` - 635 LOC.
- `src/analysis/framework-patterns.ts` - 634 LOC.
- `src/runtime/query-commands/cleanup.ts` - 633 LOC.
- `src/reindex/index.ts` - 625 LOC.
- `src/symbols/definition-catalog.ts` - 609 LOC.
- `src/queries/health.ts` - 538 LOC.
- `src/queries/stale-abstractions.ts` - 535 LOC.
- `src/queries/dead.ts` - 510 LOC.

## Smell Ledger

| Priority | Smell | Evidence | Why it hurts | Better shape | Disposition |
| --- | --- | --- | --- | --- | --- |
| P0 | Project readiness crosses the reindex/semantic boundary. | `scip-query drift` reported `src/reindex/project-readiness.ts` importing `src/semantic/typescript/status.ts`; `scip-query deps src/reindex/project-readiness.ts` confirmed the edge. | Reindex readiness was becoming "all project intelligence readiness," so future semantic providers would pressure `src/reindex` instead of a neutral capability boundary. | Introduce a small readiness capability boundary that composes indexer readiness and semantic readiness without making `src/reindex` depend on `src/semantic`. | Completed: `src/runtime/project-readiness.ts` now owns the composition. |
| P0 | Detector evidence policy is still too local in `dead` and `stale-abstractions`. | `src/queries/dead.ts` imports file classification, source import parsing, path normalization, document rows, reference counts, caller rows, source caches, and `ProjectIndex`; `src/queries/stale-abstractions.ts` imports source text, AST type containers, stale consumer partitioning, symbol parsing, and `ProjectIndex`. | A new detector author must know when SCIP counts are enough, when source fallback is needed, which cache to clear, which consumers are real, and which syntax artifacts are false positives. That is tool truth implemented as query folklore. | Promote the evidence model behind detector queries with named records for definitions, references, callers, callees, and source facts. | Completed first evidence slice: `definitionConsumerFileMap()` names consumer evidence for stale/wrapper detectors, and `ReferenceCounts` now retains per-file evidence provenance for `dead`. |
| P1 | Vue augmentation has a shared type file that mixes public result records, worker handoff records, Volar dependency shims, and cache fingerprint internals. | `scip-query stale-abstractions --include-low-confidence` flagged `AugmentVueResolvedResult`, `VueCoreModule`, `VolarTsModule`, and `AugmentVueFingerprint`; `scip-query surface src/reindex/augment-vue-types.ts` showed runtime-only Volar module shapes beside cross-module task/result records. | The type file looked like a domain model, but several types were actually local adapters for one implementation file. A maintainer had to inspect imports to learn which records were public contracts and which were runtime dependency shims. | Split `augment-vue-types.ts` by role: public augmentation result/task records, worker handoff records, and runtime-local Volar/TypeScript adapter shims. | Completed: contracts, runtime shims, and cache fingerprint now have separate homes. |
| P1 | Cleanup query commands reconverged into one family module with handlers, renderers, and descriptors. | `src/runtime/query-commands/cleanup.ts` is a large command family module; `scip-query outline` shows handlers plus `cleanupQueryCommandDescriptors`. | The earlier command-spec compression fixed the giant global file, but the cleanup family still repeated category and heuristic descriptor policy across commands. | Add a small detector-command declaration helper for the repeated candidate commands, then split truly custom commands like `dead` and `similar` only if the helper does not clarify them. | Completed for the first slice: `cleanupCommand()` and `heuristicCleanupCommand()` now own repeated descriptor policy. |
| P1 | Health reporting knows each detector's private result shape. | `src/queries/health.ts` had per-detector summarizers plus a full-report assembly path separate from isolated phase result assembly. | Health is a dashboard over detector contracts, but parallel assembly paths make detector changes touch more places than needed. | Give health one phase-result composition path before introducing broader detector adapters. | Reduced: full health reports now compose through `healthAnalysesFromPhases()`, the same phase-result model used by isolated phases. |
| P2 | Suppression comments are numerous enough to be an architectural signal. | `rg` finds many `scip-query: ignore-*` comments under `src`, including comments that explain whole policies such as fallback strategies, transactions, state machines, and parser boundaries. | Many comments are legitimate: they prevent the tool from flattening essential boundaries. The smell is that the comment channel is also serving as the architecture register for policy decisions. | Keep suppressions for real false positives, but move repeated policy language into named mechanisms or local module docs. | Audited and reduced in touched areas: cleanup descriptors, health phases, consumer evidence, dead candidate gating, AST core/facts, Vue script extraction, and JavaScript import emitters now carry named mechanisms where the repeated policy was actionable. Remaining suppressions describe intentional facades, language variation, transaction phases, or detector pipelines. |
| P2 | Parser adapter similarity is mostly false compression, but the JavaScript parser had a real large internal boundary. | `scip-query similar-files` reports high similarity across parser adapters; source inspection shows a named `LanguageParser` contract and shared import emitters. `src/language-parsers/javascript.ts` owned imports, re-exports, Vue non-script identifiers, member usage, and source fallback. | Collapsing per-language AST walkers would hide essential grammar differences. JavaScript was different: it had several source facts in one file and multiple reasons to change. | Do not merge parser AST walkers. Split the JavaScript adapter internally by import parsing, re-export parsing, and Vue identifier support behind the existing adapter. | Completed: `src/language-parsers/javascript.ts` is now a facade over `javascript-imports.ts`, `javascript-reexports.ts`, and `vue-non-script-identifiers.ts`. |

## Next Slice

The next highest-signal extraction candidates are lifecycle, scoring, or evidence coordinators, not obvious duplication:

1. `src/semantic/typescript/source-file-resolver.ts:createTypeScriptSourceFiles()`.
2. `src/runtime/watch.ts:Watcher:handleFileChange()`.
3. `src/queries/similar-chains.ts:compareFilteredChains()`.

Disposition after follow-up pass:

1. `createTypeScriptSourceFiles()` no longer carries the duplicated TypeScript-like extension policy; the remaining method is a source-file resolver closure plus document listing.
2. `Watcher.handleFileChange()` is preserved as the watcher event lifecycle: path normalization, ignore checks, index-file suppression, dirty-state handling, cooldown handling, and debounce scheduling must remain readable together.
3. `compareFilteredChains()` is preserved as local chain-pair acceptance policy; moving its sequence edit-distance helpers into the generic set/cosine similarity kernel would mix different mathematical referents.

A candidate is only worth extracting if the extracted name captures a real policy, such as project-file selection, watcher event lifecycle, or chain-overlap scoring. Do not extract just to reduce line count.

## Deferred Boundaries

Do not compress the parser family merely because `similar-files` reports shared dependencies. The real referents are Java, Kotlin, Scala, C#, VB, PHP, Rust, Python, Ruby, C/C++, Dart, JavaScript, and Vue SFC source files. Those languages differ in grammar and import/export semantics, so the per-language AST walkers are essential variation.

Do not flatten Vue augmentation into generic evidence code yet. The referents are Volar virtual files, Vue source files, generated TypeScript offsets, SCIP document rows, synthetic component symbols, worker partitions, and persisted mentions. That is a special transaction. The transaction now has a context object and split type roles; further compression should name a real Vue augmentation phase, not just reduce line count.

Do not force `dead` and `stale-abstractions` into the small `runCandidateAnalysis` kernel immediately. Their hard part is not candidate scanning. Their hard part is evidence truth: real consumers, source fallback, semantic fallback, public re-export behavior, singleton-backed classes, and transitive type reachability.

## Verification Plan

For this review artifact:

```bash
test -f docs/plans/2026-06-07-principal-maintainability-register.md
```

For subsequent implementation slices:

```bash
scip-query drift
scip-query health --json
npm run typecheck
npm test
```

## 2026-06-07 Verification Addendum

A follow-up review pass re-verified every claim above against the codebase's
own freshly built `dist/`, and found the register accurate: health score 100,
zero stale abstractions, zero wrapper candidates, zero passthrough candidates,
and the only `similar-files` pairs are the per-language parser adapters already
dispositioned as essential variation. No code change was warranted.

The pass did surface one tooling hazard, recorded here because it makes the
register's own verification commands lie:

| Priority | Smell | Evidence | Why it hurts | Better shape | Disposition |
| --- | --- | --- | --- | --- | --- |
| P1 | The `scip-query` on `PATH` was a stale global install that disagreed with the repo. | Before reinstall, `scip-query drift` (global, `~/.hermes/.../scip-query/dist/cli.js`, built 06-06) reported a `runtime → semantic` layer violation at `src/runtime/project-readiness.ts`; `node dist/cli.js drift` (repo, built 06-07) reported "No drift detected." The global binary's compiled policy was missing `"semantic"` in runtime's allow-set. | This is a self-hosted, dogfooded tool: the register's Verification Plan and the skill's evidence commands invoke bare `scip-query`. A stale global reports phantom drift that contradicts the actual repo state, so "0 drifted files" can read as false to anyone verifying from `PATH`. | Reinstall the global from the current checkout after policy-affecting changes, and bump the package version when package exports change so `scip-query --version` reveals the skew. | Closed in the follow-up pass: package version is `0.7.0`; after build and reinstall, bare `scip-query` and `node dist/cli.js` must both report no drift. |

Concrete confirmation of the false positive: the `runtime → semantic` edge is
explicitly allowed by `isAllowedSrcLayerDependency` (`src/queries/drift-policy.ts:52`),
and `layerViolationDrift` (`src/queries/drift.ts:129-131`) only reports when the
policy verdict is `'violation'`. The fix that landed with the project-readiness
move (commit `bf252a1`) both relocated the composition to `src/runtime` and added
`semantic` to runtime's allow-set, so the original P0 #1 is genuinely complete.

## 2026-06-07 Deferred-Task Closure

- The global reinstall is no longer deferred; it is part of the verification pass for the `0.7.0` package-surface cleanup.
- Root exports are intentionally semver-major and core-only. Programmatic callers import query, reindex, and runtime APIs from explicit subpaths.
- Caller and callee rows now carry provenance fields, so downstream evidence consumers can distinguish AST callsites, semantic evidence, SCIP chunks, caller-map inversion, resolved references, and semantic references.
- Shared SQLite fixture schema creation now lives in `tests/evidence-fixture.ts`.
- AST/Vue follow-up split is complete through `ast-core.ts`, `ast-facts.ts`, and `vue-script.ts`.
- Suppressions were audited after the named-boundary work. The remaining comments are not open tasks; they record intentional public facades, cache lifecycle hooks, parser grammar variation, transaction phases, or command-level detector pipelines.

Final verification:

- `npm run lint` passed.
- `npm run typecheck` passed.
- `npm test` passed: 38 files, 185 tests.
- `npm run build` passed.
- `node dist/cli.js reindex --force --allow-partial` passed.
- `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 120` reported no stale abstractions.
- `node dist/cli.js health --json` reported score 100 with no dead symbols, isolated symbols, cycles, wrappers, passthroughs, stale types, or drifted files.
- `npm i -g . --force` completed; `scip-query --version` reported `0.7.0`; both global `scip-query drift --min-deviation 3` and local `node dist/cli.js drift --min-deviation 3` reported no drift.

## 2026-06-08 Fresh Review Addendum

This pass rebuilt `dist/`, rebuilt the SCIP/SQLite index, and asked the current
local CLI for maintainability signals again. The repo still has a health score
of 100, zero drifted files, zero stale abstractions, zero wrapper candidates,
zero passthrough candidates, and no health-gated extraction backlog. The only
health action is one similar-function pair inside Vue augmentation, and the
standalone extraction probe reports two candidates.

A heuristic probe is a code-analysis command that reports likely maintenance
risks from observable code facts, such as shared callees or isolated callee
clusters, while leaving the final judgment to a reader who can compare the
reported shape to the real behavior. Its value is that it narrows inspection to
specific files and symbols; its limit is that it cannot know whether similarity
reflects accidental repetition or essential domain variation.

An AST callable-shape policy is the source-analysis rule that decides which
parser nodes count as function-like program units, such as Rust
`function_item`, Python `function_definition`, or TypeScript
`function_declaration`, `method_definition`, `arrow_function`, and
`function_expression`. It belongs to the wider class of parser classification
rules and is essential because every later AST fact about callable bodies,
signatures, and candidate functions depends on choosing the same units.

Fresh evidence commands:

```bash
npm run build
node dist/cli.js reindex --force --allow-partial
node dist/cli.js health --json
node dist/cli.js drift --min-deviation 3
node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 120
node dist/cli.js wrapper-candidates --limit 120
node dist/cli.js passthrough-candidates --limit 120
node dist/cli.js similar-files --limit 40
node dist/cli.js extract-candidates --limit 80
node dist/cli.js similar --limit 20
rg -n "callableNodeTypes|function_item|function_definition|function_declaration|method_definition|arrow_function|function_expression" src tests
```

Fresh signal summary:

- `node dist/cli.js health --json`: score 100, documents 174, symbols 6,632, similar pairs 1, all other finding counts 0.
- `node dist/cli.js similar --limit 20`: one pair, `computeVueReferenceComputation()` and `computeVueResolvedReferencesForWorker()`, sharing Volar context, source reader, symbol lookup, and file reference computation setup.
- `node dist/cli.js extract-candidates --limit 80`: `augmentVueResolvedReferences()` and `complexityHotspots()` surfaced as candidates.
- `node dist/cli.js similar-files --limit 40`: parser-adapter similarity remains mostly essential variation; a more interesting 100% pair is `src/analysis/passthrough-detect.ts` with `src/source/ast-signatures.ts`.

| Priority | Smell | Evidence | Why it hurts | Better shape | Disposition |
| --- | --- | --- | --- | --- | --- |
| P1 | AST callable-shape policy is duplicated between body and signature analyses. | `src/analysis/passthrough-detect.ts:45-49` and `src/source/ast-signatures.ts:43-49` independently built the same per-language callable node sets. `src/source/ast-facts.ts:16-48` also carries callable query patterns for a richer named-definition use case. | Adding a new callable form, such as a language-specific method signature or field-backed function, could update one analysis while leaving another silently stale. That would make passthrough detection, similar-function signature filtering, and callable-site discovery disagree about what a function is. | Add a tiny source-owned callable-shape helper for node-set based AST scans, while leaving `getCallableSites()` query strings local because they also bind names, ranges, and variable declarators. | Completed: `src/source/ast-callables.ts` now owns `callableBodyNodeTypesForLanguage()`, and both node-walk consumers use it. |
| P1 | Vue augmentation still has two computation entrypoints with repeated setup, but the variation is partly essential. | `computeVueReferenceComputation()` and `computeVueResolvedReferencesForWorker()` share `createVueSourceReader()`, `createVueLanguageContext()`, `createSymbolLookup()`, and `computeVueResolvedReferencesForFiles()`. The main path can dispatch workers and owns a writable transaction; the worker path opens a readonly DB and accepts bounded tasks. | The duplicated setup is easy to keep in sync today, but it is the only current similar-function pair. A future change to symbol lookup, Volar context construction, or source-reader behavior must remember both paths. | Extract only the shared "local Vue reference computation context" if it can preserve the writable transaction path and readonly worker path as explicit callers. Do not merge the transaction and worker lifecycles. | Open but lower-risk than the AST callable-shape slice. |
| P2 | `complexityHotspots()` appears as an extraction candidate, but the helper already names the candidate-analysis lifecycle. | `node dist/cli.js extract-candidates --limit 80` reports `src/queries/complexity-hotspots.ts:31-54`; inspection shows it already delegates candidate scan, preparation, evaluation, ordering, and limiting to `runCandidateAnalysis()`. | Further extraction would mostly split a compact command-specific scorer away from the named candidate-analysis mechanism. That adds names without lowering maintainer memory load. | Leave it alone unless another complexity query adopts the same fan-in/fan-out scoring shape. | Rejected as false compression. |

Updated next slice:

1. Evaluate whether a Vue local-computation context removes drift risk
   without obscuring the separate transaction and worker lifecycles.
2. Continue rejecting parser-family similarity unless the shared unit is a
   source-analysis rule rather than a language grammar walker.

## 2026-06-08 Callable-Shape Slice Closure

Implemented the AST callable-shape slice by adding
`src/source/ast-callables.ts`. The new helper names the body-node policy shared
by range-indexed AST walks: Rust function items and function signatures, Python
function definitions, and JavaScript-like function declarations, methods, arrow
functions, and function expressions. `src/analysis/passthrough-detect.ts` and
`src/source/ast-signatures.ts` now use that shared policy.

The `getCallableSites()` query strings in `src/source/ast-facts.ts` were
deliberately not compressed. Their referents are named definition sites,
including variable declarators and public fields whose function value has to be
bound back to a symbol name. The new helper's referents are body-bearing AST
nodes indexed by range. Those are related but not identical facts.
