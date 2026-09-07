# Wave 2 worker 3 checkpoint

Plan: inspect complete target implementations and necessary contracts using scip-query; split coherent responsibilities while preserving predicates, defaults, ordering, mutations and error contracts; measure each target and new helper against cyclomatic <=10 and cognitive <=15; run focused source tests and changed-file formatting/lint. Root owns combined build, types, suite and impact checks.

Targets:
- complexity:src/source/facts/clojure-facts.ts:recordClojureMembers
- complexity:scripts/benchmark-query-service.ts:benchmarkArguments
- complexity:src/reindex/typescript-incremental-index.ts:planTypeScriptIncrementalUpdate
- complexity:src/semantic/typescript/ts-morph-provider.ts:TsMorphSemanticProvider.referencesForDefinitionsBySymbolScan.<callback:profileSpan:1>
- complexity:src/semantic/typescript/ts-morph-provider.ts:TsMorphSemanticProvider.semanticCalleeForCallNode
- complexity:src/runtime/commands/command-registry.ts:validateJsonOutputOptions
- complexity:src/source/facts/behavior-skeleton.ts:behaviorReceipt
- complexity:src/semantic/typescript/ts-morph-provider.ts:TsMorphSemanticProvider.calleeCoverageForDefinitions.visit
- complexity:src/analysis/strongly-connected-components.ts:stronglyConnectedComponents
- complexity:src/language-parsers/languages/rust.ts:flattenRustUseTree


Original ten targets complete: 176 tests across eleven focused suites passed; changed-file Prettier and ESLint pass; scoped health reports no target or new-helper complexity warnings. Root supplies exact numeric before/after metrics.

Ownership transfer: root assigned src/queries/internal/next-anchor-candidates.ts:sourceRangeNextAnchorPacket (24/38) as an eleventh target within the existing 45-target wave. Plan: inspect the complete per-seed exact/member pipeline and extraction contracts; separate those responsibilities while preserving prefilter counts, key insertion order, alternatives, evidence strength, IDs, source policy, materialized-range exclusion and cap 3; run focused next-anchor/system-map/source-evidence tests and scoped health before freezing again.


Final completed changes and preserved contracts:

- Clojure member recording: named declaration kinds and protocol-extension attribution are separate. Exact supported heads, owner/member kinds, protocol-before-extension-owner order and identifier recording remain unchanged.
- Benchmark arguments: common output suffix and exact operand-bearing command list replace repeated branches. Search-specific flags, operand-free stats/kind-counts and code fallback with --no-session retain their order. No benchmark was executed.
- TypeScript incremental planning: prerequisite validation returns only the snapshot and graph it actually validated; replacement/affected-file planning and final result projection are separate. Validation order, reasons, source/config distinctions, overlay generation precedence, deletion sets and single-project compatibility fields remain unchanged.
- TypeScript provider: reference package/scanning stages, callsite coverage and profiled target lookup are separate. Batch-local symbol caches, ignored-file gates, package/hierarchy merge order, counters, empty/missing targets, caller restrictions and JSX handling remain unchanged.
- JSON validation: ordered required-JSON checks and file-output conflicts are separate. No object-key dispatch was introduced; the original first-error precedence remains intact.
- Behavior receipts: effect qualification, representative selection and output bounds are separate. Signal counts, await/shape rules, branch fallback, max 10/min 1 clamp, omission count and source ordering remain unchanged.
- Strongly connected components: iterative frame advancement, node entry and component emission are separate. No recursive graph walk was introduced; dependency targets, insertion order and reverse topological output remain unchanged.
- Rust use trees: leaf construction and scoped list traversal are separate. Aliases, nested prefixes, self/super/crate, wildcards and unknown-node fallback remain unchanged.
- Transferred next-anchor source packet: per-seed accounting, exact-target emission, member grouping/emission and evidence construction are separate. Exact resolved-call and member-group counts remain prefilter; exact keys are recorded after source/range filtering, member keys before it. First-callsite leaf choice, candidate/derived/exact status, ambiguity, ID inputs, full alternative count, cap 3 and source-line fallback remain unchanged.

Validation completed:

- 176 tests passed across the original eleven focused suites: strongly-connected-components, TypeScript incremental index, CLI contract, source evidence, TypeScript semantic provider, function-complexity contract, Clojure reader primitives, Clojure accuracy, Rust semantic provider, command accuracy, and the new worker-3 regression.
- The new tests/runtime/complexity-wave2-worker-3.test.ts adds nine registered-command JSON error-precedence cases and a 20,001-node chain proving iterative traversal remains safe at depth.
- After the transferred next-anchor refactor, five focused suites passed 117 tests: next-anchor-candidates, system-map, source-evidence, member-call-targets and scip-occurrence-call-targets. Source-evidence overlaps the first group.
- All nine owned source/script files plus the new test pass installed ESLint and Prettier checks.
- Scoped current-source health reports no complexity warning for any of the eleven assigned targets or introduced helpers. Existing unrelated warnings remain unchanged. Receipts: /tmp/wave2-worker3-health-0.json through -7.json; /tmp/wave2-worker3-final-incremental.json; /tmp/wave2-worker3-final-rust.json; /tmp/wave2-worker3-next-anchor-health.json. Root supplies exact before/after numeric metrics from combined review.functions.
- All changed diffs reviewed against the original materialized source. No build, reindex, benchmark, commit, package, skill, threshold, suppression or shared-maintenance edits were made.

Final state: SOURCE FROZEN, no test processes running. Root owns combined typecheck/build/full-suite/API/review/health/diff-impact validation and any resulting findings. No unresolved local target/helper warnings.
