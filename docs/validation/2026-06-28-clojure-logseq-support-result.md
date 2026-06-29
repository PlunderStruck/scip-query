# Clojure Logseq Managed-Language Validation Result

Date: 2026-06-28

## Result

Clojure is now usable as a managed scip-query language for Logseq indexing and graph-backed navigation.

Validated repository: `/Users/aydansalois/Documents/GitHub/logseq`

Project-local Logseq config used:

- `.scipquery.json`: `"languages": ["clojure"]` and `indexer.clojure.configPath: ".scip-clojure.json"`.
- `.scip-clojure.json`: `scip-clojure` config with Logseq lint paths `src`, `deps`, `libs`, `scripts`, and `.clj-kondo`.

## Commands

- `check-deps`: passed; detected `clojure` and resolved `scip-clojure`.
- `config-validate --json`: passed with no diagnostics.
- `reindex --language clojure --force`: passed in 69.0s; indexed 3,273 Clojure documents.
- `reindex --language clojure`: reused the existing Clojure shard and SQLite DB in 0.3s.
- `status --json`: passed; freshness state `fresh`; 25,632 symbols, 3,273 files, index size 59,052,032 bytes.
- `capabilities --json`: reported Clojure indexing available, source fallback unavailable, semantic provider unavailable, cleanup verification available through `npx clj-kondo --lint .`.
- Later `status --json` with the rebuilt scip-query CLI reported the existing fresh graph as analyzable even though `scip-clojure` was not on PATH in that shell: indexing `partial`, source facts `available`, detectors `available`, semantic provider `unavailable`, cleanup verification `available`.
- `stats --json`: returned 3,273 documents, 25,632 symbols, 71,845 definitions, and 457,591 references.
- `code init --json`: returned `frontend.modules.instrumentation.posthog:init` from `src/main/frontend/modules/instrumentation/posthog.cljs`.
- `refs init --json`: returned a reference in `src/main/frontend/modules/instrumentation/posthog.cljs`.
- `trace init --json`: returned the Clojure definition and caller.
- `outline src/main/frontend/modules/instrumentation/posthog.cljs --json`: returned seven Clojure symbols.
- `deps src/main/frontend/modules/instrumentation/posthog.cljs --json`: returned dependencies on Logseq Clojure files.
- `affected src/main/frontend/modules/instrumentation/posthog.cljs --json`: returned an empty affected set, which is a valid graph result for that file.

## Health Follow-Up

After adding Clojure source callsite facts and optimizing shared chunk callee matching, default unbounded `health --json` completed on Logseq in 1.41s wall time.

After fixing SCIP kind-name interpretation and Clojure source-callable complexity gating, default unbounded `health --json` completed on Logseq in 1.63s wall time.

Latest measured slow-phase timings:

- `isolated`: 0.99s
- `similar`: 0.49s
- `extract-candidates`: 0.46s
- `wrapper-candidates`: 1.19s
- `passthrough-candidates`: 0.49s

Latest health output summary:

- `score`: 76
- `riskScore`: 97
- `hygieneScore`: 76
- `cycles`: 0
- `isolatedSymbols`: 0
- `similarPairs`: 157
- `wrappers`: 560
- `passthroughs`: 147
- `complexityHotspotCount`: 0; `topComplexity` still reports ranked callable evidence below the extreme-hotspot threshold.

Latest kind and complexity validation:

- `kind-counts --json`: `Function` 11,864; `Variable` 2,600; `Class` 77; `Namespace` 32; `Macro` 29; `TypeAlias` 1.
- `by-kind function --json --limit 5`: returned Clojure functions from `.clj-kondo/hooks/*.clj` in 0.37s wall time.
- `complexity-hotspots --json --min-loc 1 --limit 5`: returned Clojure callables in 1.30s wall time: `logseq.cli.commands:execute`, `frontend.db.utils:entity`, `frontend.state:set-state!`, `frontend.handler.notification:show!`, and `frontend.handler.editor:api-insert-new-block!`.
- `cycles --json`: returned `[]` in 0.46s wall time.

Tree-sitter Clojure remains a follow-up rather than part of this validation. `tree-sitter-clojure@0.4.0` does not build on Node 22, and `@yogthos/tree-sitter-clojure@0.0.14` targets a newer Tree-sitter JavaScript runtime than scip-query currently pins. The current Clojure source adapter is intentionally dependency-free and preserves other language parser performance.
