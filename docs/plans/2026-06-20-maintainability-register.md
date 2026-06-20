# SCIP Maintainability Register — 2026-06-20

## Executive Read

The repository is in unusually good mechanical health: `scip-query health --full --json` reports `100/100`, with no active dead code, stale abstractions, wrappers, passthroughs, drift, cycles, hidden coupling, or recent duplicate findings. That score is not the maintainability result; it means the obvious detector-backed cleanup work is currently quiet.

The remaining maintainability pressure is architectural: a small set of central evidence and detector workflow units carry a lot of policy. Future mistakes are most likely to happen when an agent changes one detector or evidence path without understanding the shared lifecycle it participates in.

## Scope Map

- Indexed scope: 217 documents, 9,741 symbols, 21,502 references.
- Source: `node dist/cli.js stats --json`.
- Core evidence spine: `src/index.ts -> src/core/project-index.ts -> src/source/*`.
- Source: `node dist/cli.js similar-chains --full --json`, aggregated by common prefix.
- Query layer: 72 files under `src/queries`.
- Source: `node dist/cli.js system src/queries --json`.
- Runtime command layer: 7 files under `src/runtime/query-commands`, with `cleanup.ts` as the largest command family.
- Source: `node dist/cli.js system src/runtime/query-commands --json`.

## Smell Ledger

| Priority | Smell | Evidence | Why It Hurts | Better Shape | Disposition |
| --- | --- | --- | --- | --- | --- |
| P1 | `ProjectIndex` is the shared evidence facade and policy gate. | `change-surface src/core/project-index.ts --json`: `ProjectIndex` has 25 external consumers; file has 117 external consumer links. `bottlenecks --full --json`: `productionCallableDefinitions()` is top bottleneck with fan-in 10, fan-out 6. | Maintainers must know which methods are core graph facts, which are source fallback views, which are detector policy gates, and which are intentional facades. The class is useful, but it is also where unrelated evidence policies meet. | Split or name narrower roles: a production-callable gate, caller-evidence facade, source-fallback facade, and framework-reference bridge. Keep `ProjectIndex` as the small stable entry point if needed. | `extract` / `enforce` |
| P1 | Detector lifecycle functions own too many phases locally. | `extract-candidates --full --json`: top candidates include `incompleteMigration()` lines 73-197, `docDrift()` lines 71-180, `similarAll()` lines 134-213, `buildVueScriptFacts()` lines 107-172, and `recentDuplicates()` lines 82-145. | These functions are not merely long; each one owns a multi-stage scan lifecycle: collect inputs, classify evidence, apply policy thresholds, score candidates, and shape output. Local edits can accidentally change detector semantics. | Introduce small named workflow records/stages, such as migration scan context, doc drift scan index, duplicate candidate source, and Vue script fact finalization. Avoid generic helper extraction. | `extract` |
| P2 | Suppression comments still carry architectural decisions. | `health --full --json`: 163 suppressions total: 73 extract, 51 wrapper, 17 stale, 15 similar, 7 passthrough. Examples in `ProjectIndex` and `Watcher` explain real lifecycle or facade boundaries. | Many suppressions are legitimate, but at this volume the comment channel also acts as an architecture register. A maintainer must read scattered comments to learn which boundaries are intentional. | Move repeated suppression rationales into named mechanisms or module-level decision notes; leave inline suppressions for true detector exceptions. | `enforce` |
| P2 | Source/AST evidence forms the dominant dependency spine. | `similar-chains --full --json`: 17,385 similar chains collapse mostly into shared prefixes: 8,037 begin `src/index.ts -> src/core/project-index.ts`, 2,460 continue through `src/source/ast.ts`, 1,485 through `src/source/source-facts.ts`. `system src/source --json`: 26 source files depended on by query, symbol, runtime, parser, and reindex modules. | This is expected for an evidence tool, but it means changes to source facts, AST facts, Vue facts, and cached source text need explicit ownership boundaries. | Treat source evidence as a layered subsystem: source text/fileset, AST runtime, source facts, framework profile facts, and consumer-facing evidence. Document the boundaries and keep detector-specific policy out of lower layers. | `enforce` |
| P3 | `src/runtime/query-commands/cleanup.ts` is a broad command-family module. | `system src/runtime/query-commands --json`: `cleanup.ts` spans lines 0-1269 and owns cleanup, similarity, frontend duplicate, drift, convergence, cleanup-plan/apply, recent-duplicates, doc-drift, and unused-params handlers/descriptors. | The descriptor builders are good compression, but the module has many reasons to change: text rendering, query option plumbing, side-effecting cleanup apply, and frontend command presentation. | Split by command family only when the next change forces it: cleanup-plan/apply, duplicate/frontend commands, and cleanup hygiene commands. Do not split just for size. | `defer` |

## Rejected Or Low-Priority Signals

- `similar-files --full --json` reports `src/runtime/watch.ts` and `src/runtime/cli-context.ts` as structurally similar because both use config, index path resolution, and gitignore filtering. This is false compression: the referents are different runtime units. `Watcher` is a file-change lifecycle state machine; `cli-context` is a CLI database/context opener.
- The 17,385 `similar-chains` findings are not 17,385 duplicate workflows. They are primarily evidence that the same `ProjectIndex` and `src/source/*` spine feeds many query paths.
- Health `100/100` is real, but it should not hide the architecture register above. The score says the current detector suite sees no active cleanup findings; it does not prove the concept boundaries are fully decomposed.

## Compression Opportunities

1. **Production Callable Gate**
   - Referents: the repeated filtering facts in `ProjectIndex.productionCallableDefinitions()` — scope, suppression comments, tests, generated files, LOC, callable mode, rooted symbols, Rust trait impl exclusions.
   - A better mechanism would make this a named policy object or function used by detectors, while keeping `ProjectIndex` as a facade.

2. **Detector Scan Contexts**
   - Referents: `incompleteMigration()`, `docDrift()`, `recentDuplicates()`, `similarAll()`, and `buildVueScriptFacts()`.
   - A better mechanism would separate scan preparation, evidence indexing, candidate scoring, and report shaping.

3. **Suppression Decision Inventory**
   - Referents: 163 inline `scip-query: ignore-*` comments.
   - A better mechanism would group repeated accepted-boundary explanations into module docs or typed decision records, then keep line comments only for local detector false positives.

4. **Source Evidence Layers**
   - Referents: `src/source/source-text.ts`, `source-facts.ts`, `source-references.ts`, `ast.ts`, `ast-core.ts`, framework profile files, and Vue SFC/template/script fact extraction.
   - A better mechanism would preserve the current layering while making ownership explicit enough that detector authors do not reach across layers casually.

## Verification Notes

Commands run for this review:

- `node dist/cli.js status`
- `node dist/cli.js reindex`
- `node dist/cli.js stats --json`
- `node dist/cli.js health --full --json`
- `node dist/cli.js similar-files --full --json`
- `node dist/cli.js similar-chains --full --json`
- `node dist/cli.js extract-candidates --full --json`
- `node dist/cli.js wrapper-candidates --full --json`
- `node dist/cli.js passthrough-candidates --full --json`
- `node dist/cli.js stale-abstractions --include-low-confidence --full --json`
- `node dist/cli.js recent-duplicates --full --json`
- `node dist/cli.js drift --json`
- `node dist/cli.js cycles --json`
- `node dist/cli.js bottlenecks --full --json`
- `node dist/cli.js co-change --full --json`
- `node dist/cli.js change-surface src/core/project-index.ts --json`
- `node dist/cli.js change-surface src/queries/incomplete-migration.ts --json`
- `node dist/cli.js change-surface src/queries/doc-drift.ts --json`
- `node dist/cli.js change-surface src/queries/recent-duplicates.ts --json`
- `node dist/cli.js change-surface src/source/vue-script-facts.ts --json`
