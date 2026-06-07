# Project Evidence Isolated Compression Atlas

Date: 2026-06-07
Scope: first implementation slice from the Primogen Disgust Register's distributed evidence-policy finding.

## Scope Map

Files in scope:

- `src/core/project-index.ts`
- `src/queries/isolated.ts`
- `docs/plans/2026-06-07-primogen-disgust-register.md`

Related evidence modules:

- `src/symbols/source-reference-scan.ts`
- `src/symbols/call-graph-evidence.ts`
- `src/storage/scip-documents.ts`
- `src/analysis/framework-patterns.ts`
- `src/source/ast.ts`

## Role Inventory

A project index is the query-facing facade over indexed project evidence. Its essential role is to let query modules ask project-level questions without knowing which storage, source, AST, semantic, framework, or cache modules produce the answer.

A framework reference is a source-level use created by framework dispatch rather than a normal call or import. Its essential role is to prevent a definition from being treated as isolated or dead when the framework invokes it through strings, attributes, router conventions, or reflection.

A non-self callee set is the set of candidate definitions that call at least one different symbol. Its essential role is to answer "is this candidate connected to executable code?" without exposing the caller to callee-map construction and self-call filtering.

## Opportunity Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| E1 | Move framework-reference evidence out of `isolated`. | `isolated` imports `getRustAttrReferencedNames`, `detectAstLanguage`, and `indexedDocumentPaths`, then reconstructs a candidate leaf index. | merge |
| E2 | Move "has non-self callee" projection out of `isolated`. | `isolated` has a local `connectedCalleeIds()` helper that wraps `ProjectIndex.calleeMap()` and filters self-calls. | merge |
| E3 | Move cross-file caller plus source-fallback caller merging behind `ProjectIndex`. | `stale-abstractions` and `wrapper-candidates` both merge `crossFileCallerMap()` with `sourceFallbackCallerFiles()`. | merge |
| E4 | Leave result projection in `isolated`. | Sorting and mapping to `IsolatedResult` is the query's user-facing result shape, not evidence policy. | keep |
| E5 | Do not introduce a new `ProjectEvidence` class yet. | The current slice is small enough to deepen `ProjectIndex`; a second class would add a seam before there are two adapters. | skip |

## Compression Cluster

Cluster A: Isolated Query Evidence Ownership

- Old mechanism: `isolated` knows how to find Rust framework references and how to interpret callee-map rows.
- New mechanism: `ProjectIndex` exposes `frameworkReferencedSymbolIds()` and `symbolsWithNonSelfCallees()`.
- Behavior preserved: same candidate gates, same scan limit, same framework-reference leaf matching semantics, same strict/additive callee passes, same result projection.

Cluster B: Caller Evidence Union

- Old mechanism: detectors individually merge indexed cross-file callers with source fallback callers.
- New mechanism: `ProjectIndex.callerFileMap()` owns that evidence union.
- Behavior preserved: same indexed caller map, same source fallback map, same semantic toggle.

## Dependency Order

1. Add the `ProjectIndex` evidence methods.
2. Replace direct evidence plumbing in `isolated`.
3. Update the disgust register with the new first fix and remaining evidence-policy work.
4. Verify focused isolated/health behavior, then run typecheck/tests/build/health.

## Validation Plan

```bash
npm run typecheck
npm test -- tests/command-accuracy.test.ts tests/queries.test.ts
npm test
npm run build
node dist/cli.js isolated --min-loc 1 --full
node dist/cli.js health --json
node dist/cli.js drift --min-deviation 3
```

## Implementation Log

- Added `ProjectIndex.frameworkReferencedSymbolIds()` so query modules can ask which candidate definitions are used through framework dispatch without importing framework AST helpers directly.
- Added `ProjectIndex.symbolsWithNonSelfCallees()` so query modules can ask which candidate definitions call real non-self code without hand-projecting callee maps.
- Added `ProjectIndex.callerFileMap()` so detector modules can use the shared indexed-caller plus source-fallback evidence policy without hand-merging maps.
- Replaced `isolated`'s direct imports of Rust framework patterns, AST language detection, indexed document paths, and its local `connectedCalleeIds()` helper with calls to the project index.
- Replaced caller evidence merges in `stale-abstractions` and `wrapper-candidates`.
- Deleted the now-dead `mergeMapOfSets()` query utility after health reported it as unused.
- Kept `isolated`'s candidate gates and result projection local to the query.

## Verification Log

- `npm run typecheck`
- `npm test -- tests/command-accuracy.test.ts tests/queries.test.ts` - 38 tests passed.
- `npm test -- tests/command-accuracy.test.ts tests/stale-abstractions-accuracy.test.ts tests/file-wide-caller-fallback.test.ts` - 29 tests passed.
- `npm run lint`
- `npm test` - 177 tests passed.
- `npm run build`
- `node dist/cli.js reindex --force --allow-partial`
- `node dist/cli.js health --json` - health score 100, no findings.
- `node dist/cli.js dead --only-dead --min-loc 1 --full` - no matching dead-code symbols found.
- `node dist/cli.js drift --min-deviation 3` - no drift detected.
- `node dist/cli.js isolated --min-loc 1 --full` - no isolated symbols found.
- `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 80` - no stale abstractions found.
- `node dist/cli.js passthrough-candidates --max-loc 40` - no passthrough candidates found.
