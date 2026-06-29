# Clojure First-Class Parity Plan

Date: 2026-06-29

## Goal

Bring Clojure support in scip-query to first-class parity where the Clojure evidence model can honestly support it.

A first-class managed language is a programming language that scip-query can detect, index, refresh, inspect, score, and verify through the same public command surface used for mature languages. Its real-world referents here are TypeScript in scip-query and Clojure in Logseq; it is a managed language distinguished by being routed through shared scip-query registries, indexer orchestration, source-fact pipelines, capability reporting, health phases, and validation gates rather than special one-off commands.

Clojure evidence is the code-intelligence data scip-query can obtain for `.clj`, `.cljs`, and `.cljc` files. Its real-world referents are `scip-clojure` SCIP graphs, `clj-kondo` namespace and var analysis, source forms such as `ns`, `:require`, `:import`, `defn`, and `defmacro`, and Logseq command output; it is code evidence distinguished by joining a graph-backed index with source-derived Clojure forms rather than a TypeScript compiler service.

Done means:

- The plan below is checked off with validation notes.
- `scip-clojure` is locally publish-ready: file-URI project roots, executable npm wrapper, package/build/test/pack checks, and GitHub-ready metadata.
- scip-query has a Clojure namespace/import parser registered through the existing language parser registry.
- `imports`, `unused-imports`, dependency graph, cycles, health, complexity, cleanup verification, readiness, and capability matrix work for Clojure or state an evidence-backed limitation.
- Logseq is the regression corpus for mixed Clojure, TypeScript, and Python indexing.
- TypeScript performance and behavior do not regress.

## Current Evidence

- Source imports already flow through `getSourceImports()`, which normalizes the path, picks a parser with `getParserForPath()`, reads source, checks the source-import evidence cache, and calls `parser.parseImports()`. Source: `scip-query plan-context getSourceImports --json`; definition at `src/language-parsers/index.ts:66`.
- The parser contract is `LanguageParser.parseImports(db, importerPath, source): ParsedSourceImport[]`, and each import has `importedName`, `localName`, `sourcePath`, `kind`, `used`, and `usedMembers`. Source: `scip-query code LanguageParser -C 12`; `scip-query code ParsedSourceImport -C 8`.
- The parser registry is the intended extension point: `getParserForPath()` chooses a parser by file extension from `REGISTRY`. Source: `scip-query plan-context getParserForPath --json`.
- Import commands already consume source imports through `loadFileImportEntries()`, `sourceFileImportEntries()`, and `sourceImportersForSymbol()`. Source: `scip-query plan-context imports --json`.
- `languageCapability()` currently reports indexing, source fallback, semantic provider, cleanup detectors, and cleanup verification for each language. Source: `scip-query plan-context languageCapability --json`; definition at `src/runtime/project-readiness.ts:207`.
- `buildClojureSourceFacts()` already extracts Clojure callable and callsite facts for health and complexity fast paths. Source: `scip-query outline src/source/clojure-facts.ts --json`; public entry at `src/source/clojure-facts.ts:42`.
- `src/source/clojure-facts.ts` has a medium-risk single external API surface and no similar files, so extending Clojure-specific source parsing there or beside it is justified. Source: `scip-query change-surface src/source/clojure-facts.ts --json`; `scip-query similar-files src/source/clojure-facts.ts --json --full`.
- Prior Logseq validation showed mixed indexing works for Clojure, TypeScript, and Python, with a fresh index containing 3,303 documents, 30,214 symbols, 75,447 definitions, and 463,436 references. Clojure-only cycles were zero; mixed Logseq cycles were TypeScript SDK cycles.
- Prior health validation showed unbounded Logseq health completes interactively after Clojure source facts and shared health optimizations, while TypeScript health in this repo remained fast.

## Reuse Audit

- Reuse `LanguageParser` and `getSourceImports()` for Clojure namespace imports instead of introducing a Clojure-only import command.
- Reuse `ParsedSourceImport` so `imports`, `unused-imports`, drift, dead-code import checks, file dependency graph, and source import indexes see Clojure through the existing shape.
- Reuse `buildClojureSourceFacts()` scanning helpers where possible for Clojure forms, but keep import parsing separately testable because namespace clauses have different output semantics from callsite facts.
- Reuse `languageCapability()` and `renderCapabilities()` for the capability matrix. Add fields conservatively so JSON consumers keep the existing top-level rows.
- Reuse `detectCheckers()` and cleanup verifier coverage for `clj-kondo`; do not build a separate Clojure verifier.
- Reuse Logseq as the real corpus and fixture tests as the fast correctness net.

## Phase 1 - Namespace And Import Facts

- [x] Add a Clojure language parser for `.clj`, `.cljs`, and `.cljc`.
  - Source: `scip-query code LanguageParser -C 12`; `scip-query plan-context getParserForPath --json`.
  - Files: `src/language-parsers/languages/clojure.ts`, `src/language-parsers/registry.ts`.
  - Parse the `ns` form and its `:require`, `:require-macros`, `:use`, `:import`, and `:refer-clojure` clauses.
  - Emit namespace imports as `kind: 'namespace'`.
  - Emit referred vars as `kind: 'named'` with `localName` equal to the local symbol.
  - Resolve namespace paths where possible by mapping `foo.bar-baz` to `foo/bar_baz.clj`, `.cljs`, or `.cljc` with existing project files.

- [x] Track usage for aliases and referred vars.
  - Source: `scip-query code ParsedSourceImport -C 8`.
  - `:as x` is used when `x/anything` appears outside the namespace form.
  - `:refer [a b]` entries are used when `a` or `b` appears outside the namespace form.
  - Whole namespace imports without aliases are marked used when their namespace leaf appears in qualified calls.

- [x] Add fixtures for common Clojure import shapes.
  - Cover `.clj`, `.cljs`, and `.cljc`.
  - Include vector requires, bare requires, aliases, `:as-alias`, `:refer`, `:refer :all`, reader comments, strings, and Java import forms.

## Phase 2 - Command Support

- [x] Verify `imports` on Clojure files uses source parser output.
  - Source: `scip-query plan-context imports --json`.
  - Acceptance: a Logseq Clojure file reports namespace imports with aliases and source paths when resolvable.

- [x] Verify `unused-imports` reports unused Clojure aliases or referred vars without flagging imports used inside comments or strings.
  - Source: `scip-query plan-context imports --json`.
  - Acceptance: focused fixture tests catch unused alias and unused refer cases.

- [x] Verify dependency graph and cycle commands see Clojure namespace dependencies.
  - Source: `scip-query plan-context getSourceImports --json` shows source imports feed `buildFileDepGraph()`.
  - Acceptance: fixture dependency graph includes Clojure namespace edges; Logseq Clojure cycles remain zero unless fresh upstream code changes introduce one.

## Phase 3 - Capability Matrix

- [x] Make Clojure capability reporting granular without breaking existing JSON consumers.
  - Source: `scip-query plan-context languageCapability --json`.
  - Keep existing `indexing`, `sourceFacts`, `semantic`, `detectors`, and `cleanupVerification`.
  - Add optional capability rows such as namespace imports, source callsites, and clj-kondo verification if the current rendering path can display them without making old consumers brittle.
  - If optional rows are too invasive, improve Clojure reasons and labels while preserving the current schema.

- [x] Ensure capability matrix uses an existing indexed graph when the indexer is absent from `PATH`.
  - Source: current `renderCapabilities()` now passes graph freshness into `getProjectCapabilities()`.
  - Acceptance: Logseq reports Clojure indexing as `partial`, not unavailable, when the graph exists but `scip-clojure` is not runnable.

## Phase 4 - clj-kondo And scip-clojure Readiness

- [x] Finish local `scip-clojure` packaging readiness.
  - Files: `/Users/aydansalois/Documents/GitHub/scip-clojure`.
  - Acceptance: `npm test`, `npm run build`, and `npm pack --dry-run` pass.
  - Preserve the executable npm wrapper.

- [x] Confirm `scip-clojure` emits a file-URI project root.
  - Acceptance: unit test covers `file://` metadata roots and Logseq index paths align with scip-query root matching.

- [x] Audit clj-kondo semantic ingestion boundary.
  - If `scip-clojure` already emits clj-kondo namespace, definition, and reference facts into SCIP, document that as the semantic ingestion path.
  - If clj-kondo exposes useful analysis not currently emitted, add a follow-up TODO in the repo with exact missing fact classes.

## Phase 5 - Regression Verification

- [x] Run focused parser/source tests.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build`.
- [x] Run focused runtime/readiness tests.
- [x] Run `scip-query reindex && scip-query diff-gate`.
  - `reindex` passed.
  - `diff-gate` exits 1 with doc-reference warnings against broad historical validation/benchmark docs that cite files touched by the larger Clojure-support diff. The earlier code-echo finding was fixed; remaining findings are documentation review signals, not runtime regressions.
- [x] Reindex Logseq for Clojure, TypeScript, and Python.
  - Forced reindex reused cached Clojure, TypeScript, and Python shards, merged three language indexes, converted SQLite, and completed in 10.3s.
- [x] Run Logseq checks:
  - `capability-matrix --json`
    - Clojure indexing is `partial` because an indexed graph is present while `scip-clojure` is not currently runnable from `PATH`; source facts, detectors, and `clj-kondo` cleanup verification are available.
  - `imports --json` on representative Clojure files
    - `imports src/main/frontend/db.cljs --json` reports namespace imports such as `frontend.config as config`, `frontend.db.conn as conn`, `logseq.db as ldb`, and referred `import-vars`, with resolvable source files.
  - `unused-imports --json` on Clojure fixtures or Logseq files
    - `unused-imports src/main/frontend/db.cljs --json` reports `frontend.db.model`, `frontend.db.utils`, and `logseq.outliner.op`.
  - `cycles --json`
    - Full Logseq cycles completes in about 0.3s and reports real mixed/Clojure graph cycles.
  - `complexity-hotspots --json`
    - Completes in about 2s and reports Clojure hotspots including `logseq.cli.commands/execute`, `frontend.db.utils/entity`, and `frontend.state/set-state!`.
  - `health --json`
    - Full unbounded Logseq health completes in about 3s with score 73 after excluding generated dependency caches and avoiding whole-file Clojure import parsing. Findings include 27 dead symbols, 0 isolated symbols, and 32 cycles after the final forced reindex.

## Acceptance Criteria

- Clojure imports are not merely graph-only; namespace forms are available through the same source import path used by other languages.
- Clojure capability output tells the truth: graph facts and source facts are available, TypeScript-style semantic provider is not, and clj-kondo verification is available when detected.
- Logseq validates mixed-language indexing and command behavior.
- scip-query TypeScript checks and performance remain healthy.
- Anything left below TypeScript parity is documented as a real evidence-model gap, not an accidental missing command.
