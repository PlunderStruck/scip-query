# TypeScript accuracy repairs

Status: the ten discovery findings have been addressed and final verification passed. Some repairs establish additional relationships; others preserve declarations while withholding unproved runtime targets or values. This does not mean complete TypeScript runtime analysis. See the [final validation report](../benchmarks/2026-09-09-typescript-accuracy-repairs.md). Prior uncommitted work and the unrelated LaunchPoint benchmark document were preserved. The discovery report remains historical. No commit, push, or VM deployment was performed in this turn.

## Existing flow

1. The TypeScript producer and `reindex/typescript-symbol-identity.ts` emit compiler identities into SCIP; indexing publishes documents to SQLite. Full and incremental indexing must use the same identity rules.
2. `symbols/definition-catalog.ts` provides source-aligned declarations. `symbols/graph/scip-chunk-occurrences.ts` joins occurrences to that catalog. A missing catalog row currently becomes an external range, even for a local field/getter.
3. `source/ast/source-binding-identity.ts` owns lexical bindings, aliases, property writes, and direct parameter identity, cached by parsed source root. `symbols/graph/imported-value-context.ts` follows those facts into exporting files.
4. `symbols/graph/scip-occurrence-call-targets.ts` combines invocation syntax, compiler references, and write rejection. `queries/graph/program-execution-frontiers.ts` reports unresolved invocations. Execution/dataflow providers and public evidence consume these results.
5. `symbols/graph/static-value-flow.ts` uses the same binding resolver for constants and bounded returns. Runtime-boundary extractors and parameter-flow graph consumers publish these values, including HTTP paths.

## Comparable features and conventions

Existing direct-write and unrelated-property controls in `tests/source/source-binding-identity.test.ts` and `tests/queries/graph/typescript-call-mutation-accuracy.test.ts` establish the required distinction between a changed callable, a changed sibling property, and a copied container slot. The discovery recorders add independently executed counterexamples and clean-index comparisons. Use real compiler-valid fixture repositories, direct production owners, and selected public CLI checks. Keep compiler references independent of claims about runtime implementations.

## Reuse and ownership decisions

Extend the shared compiler/binding/value owners above. Shared object origins and effects belong with source bindings, not individual framework extractors. Preserve observed declaration facts even when runtime targets are unresolved. Missing or unsupported value effects must prevent a stronger derived literal or unique-target claim. Transparent wrappers must be normalized before compiler identity checks. Extend producer identity once for both indexing modes; do not add per-query anonymous-name guesses.

## Findings and acceptance checklist

- [x] TS-A01: shared effects invalidate stale member literals; all three independent executions and live HTTP extraction regressions pass, with unchanged/sibling controls. Whole-corpus validation passed.
- [x] TS-A02: retain compiler-owned fields/getters in the catalog and distinguish local unresolved values from external bodies.
- [x] TS-A03: compiler-grounded identity for anonymous default callables, consistent in full/incremental indexes and imported calls.
- [x] TS-A04: imported local declarations participate in direct property-write tracking. Named/default/namespace controls failed before and pass after.
- [x] TS-A05: all six transparent argument forms now retain parameter identity (failed-before/passed-after); complete graph and alias/spread checks passed.
- [x] TS-A06: wrapped literal member invocations obtain compiler-grounded reference/target evidence.
- [x] TS-A07: consolidate shared origins/effects; support the tested bounded operations and identify unsupported effects per affected site rather than assuming unchanged values.
- [x] TS-A08: distinguish exact referenced declarations from established implementation targets and disclose local target-set completeness.
- [x] TS-A09: eager call arguments and preceding initializers with unproved normal completion cannot publish a constant return. Both throw regressions fail before/pass after through static values and HTTP consumers. Broader exception propagation remains explicitly unsupported.
- [x] TS-A10: preserve source declaration evidence for conservative ordering cases; preserve the original invocation observation when following aliases, and give specific reasons when write ordering remains unproved.
- [x] Run the 472-program discovery corpus against the repaired source/build, plus histories, diagnosis and public consumers; classify every retained limitation against the revised contract.
- [x] Run focused regressions, complete repository checks, fresh review/diff-impact and architecture; resolve justified findings without lowering thresholds.

## Execution notes (historical; final results below supersede pending statuses)

Each completed item needs its concrete implementation and executed regression evidence recorded here. Do not mark a capability complete just because a recorder passes or a result was relabeled. The audit's untested language space remains outside a claim of universal TypeScript accuracy.

- Initial binding regressions: 8 failures before fixes; all 42 binding tests now pass, including 2,000 existing generated controls and new import/wrapper/effect examples.
- Value/HTTP regressions: 7 compiler-valid, independently executed programs pass. The first run before completion handling had exactly the two expected throwing-case failures.
- The shared source-binding effect map now incorporates actual-to-parameter aliases, direct bounded return aliases, logical/chained expressions, array-rest offsets, known Object/Reflect writes, and conservative unknown argument effects. This is groundwork for TS-A07; public per-site disclosure and remaining corpus cases are still pending.

- Producer revision 6 retains precise field/getter definitions, gives anonymous default callables one compiler-owned identity, and emits wrapped literal computed references. Published-index regressions and clean-index parity pass.
- All six supported parameter transfer forms pass through the materialized graph; direct anonymous imports retain established implementation resolution.
- Second corpus recording: 472 valid programs, zero compiler/catalog mismatch cases, zero stale literals, zero runtime expectation failures. Thirteen remaining declaration/runtime disagreements are all explicitly unresolved implementations with public invocation frontiers; no established implementation disagrees. The recorder keeps the raw disagreements visible.
- Extracted shared source-binding access/effect owners; fixed a self-call ordering regression by preserving the original observation while following an initializer. All 62 focused regressions pass after extraction. Full-suite failures are being assessed; verification is not complete.

- Additional invariant repair: a leading blank line changed helper-write tracking because the TypeScript parse used `root.text` while source nodes retained absolute offsets. Three new leading-trivia regressions failed before; all source/TypeScript offsets and declaration positions now share the root origin. This also corrects module-reference line positions.
- Unknown argument/receiver exposure now traverses the finite source value graph with cycle detection, replacing the hard-coded eight-container limit. Depths 1/8/16/32, copied callable slots, and cycles pass.
- Runtime qualification remains intentionally conservative for general virtual/prototype dispatch and cross-file writers. Compiler declaration leads survive with a call-site location and implementation reason; dataflow does not cross an unproved implementation. A dynamic registry consumer now remains a candidate rather than being used as an established handler.
- Full verification pass 1 exposed 79 regressions/contract expectation changes, addressed through shared owners (not detector-specific fallbacks): namespace read-only slots, wrapper/receiver observation order, shorthand parameter binding, renamed re-export compiler identity, producer-6 fixture migrations, and candidate evidence source contracts. Pass 2 is running; API baseline update pending for the added `scip-declaration` evidence source.
- Current-source review also reports existing complexity and a source-module file-count rule (72 versus 67 after the two new cohesive binding modules). Keep these visible; quality review will distinguish changed implementation complexity from unrelated pre-existing findings. No thresholds or suppressions have been changed.

## Final verification

- `npm test`: **3,732 tests passed in 412 files**.
- Focused binding/declaration/value group: **74 passed**, including 2,000 generated binding controls.
- `npm run lint`, `npm run typecheck`, and the audit TypeScript check passed. Lint includes build, API/consumer and skill checks. The API addition `scip-declaration` is recorded as breaking for exhaustive evidence-source consumers.
- The final corpus has 472 valid programs, zero invocation/compiler/catalog mismatches, zero wrong derived values, and zero missing required targets. Twelve raw declaration/runtime disagreements remain explicitly unresolved; each has a public explanation and no exact call edge to the contradicted declaration.
- All 10 parameter-flow programs and 13 dependency cases match expectations. All 11 edit histories match clean compiler and graph output, including four actual incremental updates. All 15 public projections preserve symmetry and fold accounting; both output pages were recovered completely.
- Fresh self-index completed in 53.9 seconds. Diff-impact reports 147 changed symbols and 175 affected files, with absent/excluded paths disclosed separately.
- [Recorded final results](../benchmarks/typescript-accuracy-audit/2026-09-09-repair-results.json) include per-case evidence and changed-source hashes. Historical discovery artifacts were not overwritten.

## Retained limits and quality findings

The corpus has 301 cases without a static target. Target records contain 44 established and 117 unresolved implementations; these concern selected audit invocations, not overall repository accuracy. General virtual/prototype dispatch, cross-file runtime replacement, asynchronous effects, full exception propagation, and write-order proofs remain incomplete.

Final review reports 23 quality findings: 10 existing, 9 introduced complexity warnings, and 4 worsened findings (three complexity warnings and the source boundary file-count limit). Source has 72 files against its configured limit of 67; the two extracted binding modules increased an already-exceeded limit. These remain visible without changed thresholds or suppressions. Architecture reports no observed cycles or forbidden production/test edges within its coverage; ten audit source files are outside a configured boundary. This accuracy repair does not claim the repository is free of maintainability findings.
