# Clojure Accuracy Parity Plan

Date: 2026-06-29

## Goal

Make Clojure and ClojureScript command results as close to TypeScript accuracy as is reasonable without slowing or weakening existing TypeScript behavior.

Done means:

- Clojure qualified calls such as `conn/transact!` resolve to the imported namespace's symbol when the import graph knows that namespace.
- `call-graph`, `slice --forward`, `slice` backward mode, `dataflow`, `complexity`, `convergence`, and other callee consumers benefit from one shared evidence path.
- `affected` reports Clojure consumers instead of returning an empty result for symbols that have incoming reference evidence.
- `imported-by` can answer Clojure namespace reverse lookup instead of only symbol import mentions.
- Macro-heavy ClojureScript component evidence is documented and tested so cleanup output does not look more certain than it is.

## Current Flow

- `src/source/source-facts.ts:21-43` defines `SourceFacts.callSites` as `{ calleeLeaf, memberAccess, line }`; `src/source/source-facts.ts:81-85` routes Clojure files through `buildClojureSourceFacts`.
  Source: `scip-query code 'src/source/source-facts.ts:1-260'`.
- `src/source/clojure-facts.ts:153-158` records every Clojure call site with only `calleeLeaf`, `memberAccess: false`, and `line`; `src/source/clojure-facts.ts:166-168` strips the qualifier from `conn/transact!`, leaving only `transact!`.
  Source: `scip-query code 'src/source/clojure-facts.ts:1-260'`.
- `src/symbols/graph/call-graph-evidence.ts:228-274` is the shared callee map used by call graph, dataflow, slice, complexity, bottlenecks, similarity, convergence, incomplete migration, and project indexing.
  Source: `scip-query plan-context src/symbols/graph/call-graph-evidence.ts --json --limit 12`.
- `src/symbols/graph/call-graph-evidence.ts:418-445` resolves AST/source call sites through `resolveAstCalleeCandidate`; `src/symbols/graph/call-graph-evidence.ts:465-474` currently resolves by same-language leaf candidates plus the generic `pickAstCallCandidate`.
  Source: `scip-query code 'src/symbols/graph/call-graph-evidence.ts:1-720'`.
- `src/symbols/leaf-symbol-index.ts:14-38` has a generic import-aware candidate picker, but it only sees a leaf and a `memberAccess` boolean. It cannot know that a Clojure qualifier is an alias from `:as conn`.
  Source: `scip-query code 'src/symbols/leaf-symbol-index.ts:1-260'`.
- `src/queries/graph/affected.ts:139-184` only propagates into symbols whose suffix is method, type, or TypeScript-style `().`; Clojure term symbols like `frontend.db:transact!` are filtered out during transitive traversal.
  Source: `scip-query code 'src/queries/graph/affected.ts:1-220'`.
- `src/queries/navigation/imports.ts:39-42` uses indexed import rows first and only falls back to source import scanning when no indexed rows exist; `src/queries/navigation/imports.ts:128-142` source matching can match by target file, named import, namespace import, or module symbol.
  Source: `scip-query code 'src/queries/navigation/imports.ts:1-260'`.

## Reuse Audit

- Reuse `getSourceImports` from `src/symbols/leaf-symbol-index.ts:3` and `src/queries/navigation/imports.ts:4` for Clojure namespace alias resolution. Do not add a second namespace parser.
  Source: `scip-query code 'src/symbols/leaf-symbol-index.ts:1-260'` and `scip-query code 'src/queries/navigation/imports.ts:1-260'`.
- Reuse `buildCalleeMap` and `getCalleeRowsForSymbol` in `src/symbols/graph/call-graph-evidence.ts:49-64` so all callee-based commands improve together.
  Source: `scip-query code 'src/symbols/graph/call-graph-evidence.ts:1-720'`.
- Reuse `callerRowsForSymbol` in `src/queries/graph/affected.ts:86-109` instead of creating a Clojure-only impact command.
  Source: `scip-query code 'src/queries/graph/affected.ts:1-220'`.

## Implementation Checklist

- [x] Extend `SourceFacts.callSites` in `src/source/source-facts.ts:32-36` and `CallSite` in `src/source/ast/ast-facts.ts:15-21` with optional `calleeQualifier?: string` and `calleeText?: string` fields. Existing TypeScript/Rust/Python callers keep producing the current fields.
      Source: `scip-query code 'src/source/source-facts.ts:1-260'` and `scip-query code 'src/source/ast/ast-facts.ts:1-260'`.

- [x] Change `src/source/clojure-facts.ts:153-158` so a call head like `conn/transact!` records `calleeLeaf: "transact!"`, `calleeQualifier: "conn"`, and `calleeText: "conn/transact!"`. Preserve unqualified calls exactly as they work today.
      Source: `scip-query code 'src/source/clojure-facts.ts:1-260'`.

- [x] In `src/symbols/graph/call-graph-evidence.ts:432-474`, replace the current Clojure leaf-only resolution path with a language-specific branch that uses `getSourceImports(db, file)` to map Clojure namespace aliases to source paths, then picks candidates whose defining file resolves to that imported source path. Fall back to the existing `pickAstCallCandidate` behavior when no qualifier/import match exists.
      Source: `scip-query code 'src/symbols/graph/call-graph-evidence.ts:1-720'` and `scip-query code 'src/symbols/leaf-symbol-index.ts:1-260'`.

- [x] In `src/queries/graph/affected.ts:181-184`, allow Clojure term symbols to propagate when the symbol belongs to the `scip-clojure` scheme or a Clojure file. This keeps TypeScript's current suffix policy but stops dropping Clojure functions during BFS.
      Source: `scip-query code 'src/queries/graph/affected.ts:1-220'`.

- [x] In `src/queries/navigation/imports.ts:39-42`, merge indexed importer rows with source importer rows instead of using indexed rows as an exclusive early return. This lets Clojure namespace source imports supplement SCIP symbol import mentions.
      Source: `scip-query code 'src/queries/navigation/imports.ts:1-260'`.

- [x] Add fixture tests that assert Clojure qualified alias calls resolve through `call-graph`, backward `slice`, `dataflow`, `affected`, and `imported-by` without requiring Logseq. Include a fixture with ambiguous `format-name` leaves so alias resolution is tested, not just leaf uniqueness.
      Source: `scip-query plan-context src/symbols/graph/call-graph-evidence.ts --json --limit 12`, `scip-query plan-context src/queries/graph/affected.ts --json --limit 12`, and `scip-query plan-context src/queries/navigation/slice.ts --json --limit 12`.

- [x] Update `docs/validation/2026-06-29-clojure-command-accuracy-audit.md` after implementation so the matrix reflects the improved commands and the remaining non-parity areas.
      Source: `scip-query files '*clojure*' --json` and prior audit file created in this repo.

## Verification

- [x] Run the focused Clojure/source tests.
- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Run `npm run build`.
- [x] Reindex scip-query and run `scip-query diff-gate`.
- [x] Reindex Logseq with the local build and smoke check:
  - `call-graph frontend.db:transact! --json` has non-empty callees.
  - `slice frontend.db:transact! --json` has backward connected symbols.
  - `affected frontend.db:transact! --json` has direct consumers.
  - `imported-by frontend.db.conn --json` includes namespace importers, not only `conns` symbol users.

## Result

- `call-graph frontend.db:transact! --json`: 43 callers, 4 callees.
- `slice frontend.db:transact! --json`: 23 backward connected symbols.
- `dataflow frontend.db:transact! --json`: 4 producers, 30 consumers, 54 usage sites.
- `affected frontend.db:transact! --json`: 118 affected symbols.
- `imported-by frontend.db.conn --json`: 24 namespace-labeled importer files.
- `health --scope src/main --json`: score 73, completed in about 1.7 seconds during the smoke pass.
- `scip-query diff-gate --json`: exits 1 with 22 `doc-reference` findings from the pre-existing broad dirty diff; the new echo finding from this pass was fixed.

## Principle Stress Test

- Understand before touch: the shared callee map is the correct lever because many commands already depend on it.
- Blast radius: `plan-context` shows `src/symbols/graph/call-graph-evidence.ts` is consumed by project indexing, cleanup, graph, navigation, and quality commands.
- Intermediate validity: optional fields keep existing call-site producers valid.
- Reversibility: each change is internal evidence enrichment; rollback is removing the optional fields and branch.
- Failure design: if source imports cannot resolve an alias, the existing leaf-based resolver remains the fallback.
- Concurrency: changes are pure read-side analysis over cached source/index data.
- Boundaries: no CLI schema break is required.
- Data integrity: no persistent schema migration is needed.
- Observability: tests assert user-visible command output.
- Human: improved commands reduce surprising empty results for Clojure users.
- Reuse: existing parser/import/callee helpers are extended rather than duplicated.
