# Language playbook

Choose the shortest command path from "what is this system doing?" to a verified, language-specific answer. Start with the active language's row before reaching for broader or noisier commands. Pair relationship commands (`call-graph`, `imports`, `imported-by`, `refs`) with `code` to confirm behavior claims — don't stop at the relationship alone. For de-bloat work, cross-check multiple detector families rather than trusting one. When a command is weaker for a given language, use that language's fallback note instead of forcing it.

## Universal first pass (any language)

Run in order: `stats` (repo-wide size/shape, complete) → `kind-counts` → `files <feature-or-module-name>` (locate the files, complete) → `outline <file>` (symbol tree with line ranges, complete) → `by-kind function --scope <feature-or-module-name>` → `trace <symbol>` (definition + every reference, bounded) → `hierarchy <symbol>` → `code <symbol>` (confirm behavior with source, complete).

## Per-language shortlists

Each row gives the commands to reach for first, a de-bloat set for cleanup passes, and a fallback note for where that language's evidence is weaker or stronger than usual.

**TypeScript** — first: `system`, `surface`, `call-graph`, `dataflow`, `change-surface`. De-bloat: `health`, `dead`, `similar`, `similar --plan`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `unused-imports`, `redundant-reexports`. Fallback: strongest verified surface of any language here; Vue script blocks use this same command path.

**Python** — first: `outline`, `kind-counts --scope`, `system`, `imports`, `imported-by`, `call-graph`. De-bloat: `dead`, `unused-imports`, `drift`, `similar-signatures`, `complexity`, `complexity-hotspots`. Fallback: prefer source-backed fallbacks when call/kind metadata is sparse.

**Java** — first: `system`, `surface`, `call-graph`, `deps`, `rdeps`, `slice`. De-bloat: `health`, `dead`, `similar-files`, `similar-chains`, `wrapper-candidates`, `stale-abstractions`, `extract-candidates`. Fallback: use module/package surfaces to avoid class-only tunnel vision.

**Scala** — first: `surface`, `trace`, `call-graph`, `imports`, `imported-by`. De-bloat: `dead`, `similar-files`, `similar-chains`, `extract-candidates`, `stale-abstractions`, `unused-imports`. Fallback: confirm behavior with `code`.

**Kotlin** — first: `surface`, `trace`, `call-graph`, `imports`, `imported-by`. De-bloat: `dead`, `similar-files`, `similar-chains`, `extract-candidates`, `stale-abstractions`, `unused-imports`. Fallback: confirm behavior with `code`.

**Rust** — first: `trace`, `call-graph`, `refs`, `methods`, `surface`. De-bloat: `dead`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `similar-signatures`, `redundant-reexports`. Fallback: `methods` and `surface` are usually high signal here.

**Go** — first: `surface`, `trace`, `call-graph`, `refs`, `fan-in`. De-bloat: `dead`, `wrapper-candidates`, `passthrough-candidates`, `similar-files`, `similar-signatures`, `complexity`. Fallback: use package-level surfaces and confirm exported APIs before cleanup.

**C++** — first: `trace`, `refs`, `methods`, `surface`, `code`. De-bloat: `dead`, `wrapper-candidates`, `similar-files`, `similar-chains`, `extract-candidates`, `unused-imports`. Fallback: try `call-graph` after trace/refs/code.

**C** — first: `trace`, `call-graph`, `refs`, `outline`, `fan-out`. De-bloat: `dead`, `wrapper-candidates`, `similar-files`, `similar-chains`, `extract-candidates`, `unused-imports`. Fallback: skip class/member commands — they don't apply.

**Ruby** — first: `trace`, `call-graph`, `refs`, `imports`, `imported-by`. De-bloat: `dead`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `similar-files`, `similar-signatures`. Fallback: confirm dynamic-looking paths with source.

**C#** — first: `surface`, `call-graph`, `trace`, `methods`, `refs`. De-bloat: `dead`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `similar-files`, `extract-candidates`. Fallback: use surfaces and methods together.

**Visual Basic** — first: `surface`, `call-graph`, `trace`, `methods`, `refs`. De-bloat: `dead`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `similar-files`, `extract-candidates`. Fallback: use surfaces and methods together.

**Dart** — first: `surface`, `call-graph`, `trace`, `imports`, `imported-by`. De-bloat: `dead`, `wrapper-candidates`, `stale-abstractions`, `similar-files`, `similar-signatures`, `redundant-reexports`. Fallback: confirm exported API shape with `surface`.

**PHP** — first: `trace`, `refs`, `methods`, `surface`, `code`. De-bloat: `dead`, `wrapper-candidates`, `stale-abstractions`, `similar-files`, `similar-signatures`, `extract-candidates`. Fallback: try `call-graph` after trace/refs/code.

**Clojure / ClojureScript** — first: `files`, `outline`, `trace`, `refs`, `call-graph`. De-bloat: `dead`, `similar-files`, `similar-signatures`, `complexity`, `complexity-hotspots`. Constraint: SCIP indexing comes from scip-clojure — there is no TypeScript-style semantic provider available for it, so don't expect the same depth of type-aware results.

## Minimal workflows

**Understand a feature:** `files <feature>` → `outline <file>` → `kind-counts --scope <feature>` → `fan-out <file>` → `trace <entry-symbol>` → `call-graph <entry-symbol>` → `code <entry-symbol>` → `surface <module>`.

**Find DRY and de-bloat wins:** `health` → `dead` → `wrapper-candidates` → `passthrough-candidates` → `stale-abstractions` → `similar-files` → `similar-chains` → `similar-signatures` → `extract-candidates`.

When recommending a command sequence, name the language and say why these commands are highest-signal for it — don't just list commands.
