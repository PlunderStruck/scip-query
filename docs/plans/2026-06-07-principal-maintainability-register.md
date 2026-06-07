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
- JavaScript parser compression was evaluated and deferred: its size is real, but merging it with other parser adapters would hide essential JavaScript/Vue source-fact variation.

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

Final verified health summary:

- Score: 100.
- Documents: 167.
- Symbols: 6,604.
- Health findings: 0 stale abstractions and 0 drifted files.
- Top complexity symbols: `shortenSymbol`, `parseSymbol`, `indexedDocumentPaths`, `findFirstSymbolMatch`, `ProjectIndex.productionCallableDefinitions`.
- Wrapper and passthrough probes: no candidates.
- Similar-files probe: parser adapters share dependency profiles, but most of that is now essential variation under the language-parser contract.

Largest current source/test files:

- `tests/command-accuracy.test.ts` - 672 LOC.
- `src/language-parsers/javascript.ts` - 650 LOC.
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
| P2 | Suppression comments are numerous enough to be an architectural signal. | `rg` finds many `scip-query: ignore-*` comments under `src`, including comments that explain whole policies such as fallback strategies, transactions, state machines, and parser boundaries. | Many comments are legitimate: they prevent the tool from flattening essential boundaries. The smell is that the comment channel is also serving as the architecture register for policy decisions. | Keep suppressions for real false positives, but move repeated policy language into named mechanisms or local module docs. | Partially addressed through named mechanisms in cleanup descriptors, health phases, and consumer evidence; broader suppression audit deferred. |
| P2 | Parser adapter similarity is mostly false compression, but the JavaScript parser remains a real large boundary. | `scip-query similar-files` reports high similarity across parser adapters; source inspection shows a named `LanguageParser` contract and shared import emitters. `src/language-parsers/javascript.ts` remains large because it owns imports, re-exports, Vue non-script identifiers, member usage, and source fallback. | Collapsing per-language AST walkers would hide essential grammar differences. JavaScript is different: it has several source facts in one file and may still have multiple reasons to change. | Do not merge parser AST walkers. Consider a later JavaScript-only atlas that separates import parsing, re-export parsing, and Vue identifier support behind the existing adapter. | Evaluated and deferred as essential variation plus a future JavaScript-only slice. |

## Next Slice

The next high-value slice is a JavaScript-parser atlas. The parser should not be merged with sibling adapters, but it can be split internally if a scoped atlas proves import parsing, re-export parsing, Vue non-script identifiers, and member-usage policy have separate reasons to change.

Suggested implementation:

1. Build a scope map for `src/language-parsers/javascript.ts`.
2. Separate essential JavaScript/TypeScript syntax variation from Vue-specific source facts.
3. Split only if one extracted module owns a real policy, not just a pile of helper functions.
4. Re-run import fallback, command accuracy, and source-backed accuracy tests.

Expected result: either a smaller JavaScript parser boundary or an explicit deferred-boundary record explaining why the file should remain whole.

## Deferred Boundaries

Do not compress the parser family merely because `similar-files` reports shared dependencies. The real referents are Java, Kotlin, Scala, C#, VB, PHP, Rust, Python, Ruby, C/C++, Dart, JavaScript, and Vue SFC source files. Those languages differ in grammar and import/export semantics, so the per-language AST walkers are essential variation.

Do not flatten Vue augmentation into generic evidence code yet. The referents are Volar virtual files, Vue source files, generated TypeScript offsets, SCIP document rows, synthetic component symbols, worker partitions, and persisted mentions. That is a special transaction. The better move is to split type roles and keep the transaction named.

Do not force `dead` and `stale-abstractions` into the small `runCandidateAnalysis` kernel immediately. Their hard part is not candidate scanning. Their hard part is evidence truth: real consumers, source fallback, semantic fallback, public re-export behavior, singleton-backed classes, and transitive type reachability.

## Verification Plan

For this review artifact:

```bash
test -f docs/plans/2026-06-07-principal-maintainability-register.md
```

For the next implementation slice:

```bash
scip-query drift
scip-query health --json
npm run typecheck
npm test
```
