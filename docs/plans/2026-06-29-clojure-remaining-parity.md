# Clojure Remaining Accuracy Parity

## Goal

Finish the remaining practical Clojure parity work so Clojure behaves like a managed language in scip-query: record/protocol navigation should produce useful `members` and `methods` results, cleanup detectors should avoid overconfident advice on macro scaffolding, self-audit should report Clojure evidence instead of appearing unavailable, and Logseq should remain fast enough for normal health workflows.

## Gate A - Restate The User Goal

The user wants Clojure support to be as accurate as reasonable compared with TypeScript. Done means Clojure commands have honest capability behavior: normal namespace/function graph commands already work, record/protocol navigation works where source facts can see the forms, and heuristic cleanup/health commands do not present macro-expanded scaffolding as compiler-grade certainty.

Source: `scip-query status --capabilities --json` reported the current repo index is fresh and TypeScript-only for the scip-query codebase, so implementation evidence comes from the TypeScript query implementation and Clojure fixture/Logseq verification.

## Gate B - Current End-To-End Flow

- In `src/source/clojure-facts.ts:43-122`, `buildClojureSourceFacts` scans raw Clojure source into `SourceFacts` callables, call sites, and identifier lines. It currently records `defn`, `defn-`, `defmacro`, `defmacro-`, and `defmethod` as callable definitions in `recordCompletedFrame` at `src/source/clojure-facts.ts:125-161`, but it does not record `defprotocol`, `defrecord`, `deftype`, `extend-protocol`, or `extend-type` member forms.
  Source: `scip-query code 'src/source/clojure-facts.ts:1-260'`; `scip-query plan-context src/source/clojure-facts.ts --json --limit 12`.

- In `src/source/source-facts.ts:21-45`, `SourceFacts` is the shared source-fact carrier used by call graph, reference, complexity, and cleanup queries. It currently has no Clojure member facts, and serialized cache compatibility is guarded only for Clojure call-site `calleeText` at `src/source/source-facts.ts:124-145`.
  Source: `scip-query code 'src/source/source-facts.ts:1-240'`; `scip-query plan-context src/source/source-facts.ts --json --limit 12`.

- In `src/queries/navigation/members.ts:21-37`, `members` finds direct child SCIP symbols for the matched parent. This is right for class-like languages but misses Clojure record/protocol members because those are source forms rather than SCIP child symbols.
  Source: `scip-query code 'src/queries/navigation/members.ts:1-120'`; `scip-query plan-context src/queries/navigation/members.ts --json --limit 12`.

- In `src/queries/navigation/methods.ts:13-40`, `methods` finds function-like definitions whose parent type/name matches the class symbol. This also misses Clojure record/protocol methods for the same source-form reason.
  Source: `scip-query code 'src/queries/navigation/methods.ts:1-120'`; `scip-query plan-context src/queries/navigation/methods.ts --json --limit 12`.

- In `src/queries/cleanup/passthrough-candidates.ts:43-57`, passthrough analysis scans production callable definitions and uses callee maps plus `isLiteralPassthrough` at `src/queries/cleanup/passthrough-candidates.ts:60-91`. For Clojure, `isLiteralPassthrough` reads the same source-fact callable shape that currently marks all Clojure callables as not literal passthrough, so the safe path is to keep macro forms out of the candidate set rather than weakening the body-shape gate.
  Source: `scip-query code 'src/queries/cleanup/passthrough-candidates.ts:1-280'`; `scip-query plan-context src/queries/cleanup/passthrough-candidates.ts --json --limit 12`.

- In `src/queries/cleanup/wrapper-candidates.ts:47-67`, wrapper analysis scans production callable definitions and uses indexed, semantic, and source-fallback caller maps. It already notes macro-style calls can distort evidence at `src/queries/cleanup/wrapper-candidates.ts:58-61`; Clojure macro definitions should be filtered before scoring so the command does not advise inlining a macro boundary as a normal wrapper.
  Source: `scip-query code 'src/queries/cleanup/wrapper-candidates.ts:1-380'`.

- In `src/queries/cleanup/convergence.ts:21-95`, convergence compares callee sets directly. For Clojure macro scaffolding, reporting shared macro constructor callees as ordinary consolidation evidence can overstate similarity, so macro symbols need an honest filter when either compared symbol is Clojure.
  Source: `scip-query code 'src/queries/cleanup/convergence.ts:1-240'`.

- In `src/queries/quality/self-audit.ts:63-122`, `selfAudit` samples production callables and compares cheap graph evidence against the TypeScript semantic provider. `oracleAvailable` at `src/queries/quality/self-audit.ts:148-156` makes non-TypeScript languages unavailable, so Clojure currently has no audit report even when source facts can provide a bounded Clojure source oracle.
  Source: `scip-query code 'src/queries/quality/self-audit.ts:1-260'`; `scip-query plan-context src/queries/quality/self-audit.ts --json --limit 12`.

## Gate C - Reuse Audit

- Reuse `SourceFacts` rather than adding a second Clojure parser service; source facts are already consumed by graph, identifier, cleanup, and complexity paths.
  Source: `scip-query plan-context src/source/source-facts.ts --json --limit 12`.

- Reuse the existing raw Clojure scanner in `src/source/clojure-facts.ts:43-122` instead of adding a tree-sitter dependency. It already handles comments, strings, reader macro prefixes, token delimiters, form stack tracking, and identifier-line maps.
  Source: `scip-query code 'src/source/clojure-facts.ts:1-260'`.

- Reuse `ProjectIndex.definitionsForFile` and existing symbol lookup in navigation commands, adding a Clojure source-fact fallback only when SCIP child/member evidence is empty or language-specific.
  Source: `scip-query code 'src/queries/navigation/members.ts:1-120'`; `scip-query code 'src/queries/navigation/methods.ts:1-120'`.

## Implementation Checklist

- [x] Extend `SourceFacts` in `src/source/source-facts.ts:21-45` with a serialized `clojureMembers` array containing owner name, owner kind, member name, start/end lines, and member kind. In `deserializeSourceFacts` at `src/source/source-facts.ts:124-145`, invalidate old Clojure cache entries that lack this field.
      Source: `scip-query code 'src/source/source-facts.ts:1-240'`.

- [x] Extend `buildClojureSourceFacts` in `src/source/clojure-facts.ts:43-122` and `recordCompletedFrame` in `src/source/clojure-facts.ts:125-161` so closed `defprotocol`, `defrecord`, `deftype`, `extend-protocol`, and `extend-type` forms emit member facts. Keep scanning linear over the source string and reuse `FormFrame.headTokens`; do not introduce a second parser.
      Source: `scip-query code 'src/source/clojure-facts.ts:1-260'`.

- [x] Update `members` in `src/queries/navigation/members.ts:21-37` to return SCIP direct children first and Clojure source members for matched Clojure owners when graph children are absent. Preserve the existing result shape.
      Source: `scip-query code 'src/queries/navigation/members.ts:1-120'`.

- [x] Update `methods` in `src/queries/navigation/methods.ts:13-40` to include Clojure source members whose member kind is method-like for matched protocol/record/type owners. Preserve the existing TypeScript/Rust behavior.
      Source: `scip-query code 'src/queries/navigation/methods.ts:1-120'`.

- [x] Add a narrow source helper that identifies Clojure macro definitions from source facts, then exclude macro definitions from `wrapperCandidates` in `src/queries/cleanup/wrapper-candidates.ts:178-192` and from `passthroughCandidates` if a macro ever reaches the candidate set. Do not disable normal Clojure functions.
      Source: `scip-query code 'src/queries/cleanup/wrapper-candidates.ts:1-380'`; `scip-query code 'src/queries/cleanup/passthrough-candidates.ts:1-280'`.

- [x] In `convergence` at `src/queries/cleanup/convergence.ts:21-95`, when either compared symbol is Clojure, filter macro definition callees out of the compared callee sets and make the consolidation strategy mention that Clojure macro scaffolding was ignored when the filter changes the set.
      Source: `scip-query code 'src/queries/cleanup/convergence.ts:1-240'`.

- [x] Update `selfAudit` in `src/queries/quality/self-audit.ts:63-122` so TypeScript still uses `semanticReferences` and `semanticCalleeMap`, while Clojure uses a source-fact oracle that compares source reference/callee file sets. Report it as available only when sampled Clojure symbols have source facts, and keep precision `null` for Clojure callees if the oracle is partial.
      Source: `scip-query code 'src/queries/quality/self-audit.ts:1-260'`.

- [x] Add fixture-backed tests for Clojure record/protocol `members` and `methods`, macro filtering in cleanup/convergence, and Clojure self-audit availability. Existing test files are not present in the SCIP index, so test paths will be verified by the test runner rather than cited as code-evidence here.
      Source: `scip-query files clojure --json` returned indexed Clojure production files only.

- [x] Update the Clojure capability/audit docs to reflect the new supported surface and the remaining distinction from TypeScript: Clojure has source-backed protocol/record navigation and a source oracle, while TypeScript still has a compiler semantic oracle.
      Source: `scip-query plan-context src/source/source-facts.ts --json --limit 12` reported source-fact co-change pressure with docs.

- [x] Verify with `npm run typecheck`, targeted Clojure tests, full `npm test`, `npm run build`, Logseq smoke checks for `members`, `methods`, `self-audit`, cleanup commands, `node dist/cli.js reindex`, and `node dist/cli.js diff-gate --json`.
      Source: repo AGENTS.md scip-query workflow and `scip-query` skill verification requirements.
