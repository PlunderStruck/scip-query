# Worker 3 complexity checkpoint

Plan: inspect complete implementations and contracts with scip-query; separate validation, selection, aggregation, and rendering responsibilities while preserving decision order and effects; run focused source tests and changed-file lint. No build, reindex, or commits.

Targets:
- complexity:src/runtime/project-setup.ts:buildSetupSmokeTests
- complexity:src/queries/internal/connected-behavior.ts:behaviorForNode
- complexity:src/queries/internal/connected-behavior.ts:focusLinesForNode
- complexity:src/symbols/graph/member-call-targets.ts:factoryCallbackMemberTargets
- complexity:src/queries/cleanup/similar.ts:classifySimilarityEvidence
- complexity:src/reindex/reindex-activity.ts:parseReindexActivityRecord
- complexity:src/analysis/git-history.ts:coChangePairsFromHistory
- complexity:src/analysis/runtime-boundaries/object-members.ts:resolveMember
- complexity:src/queries/navigation/source-search-batch.ts:collectFileMatches
- complexity:src/semantic/symbol-evidence.ts:materializeSemanticCalleeCache.<callback:profileSpan:1>


Completed implementation:

- Setup smoke checks have individual renderers; check order, readiness basis, failure precedence, optionality, command text and evidence text remain intact.
- Connected behavior separates source preparation, representation selection, oversized-line policy, complete-source rendering, edge eligibility and identifier focus. Complete anchors, governing predicates, sibling outcomes, supporting declarations, source coverage and sorted unique focus lines remain intact.
- Factory callback resolution separates factory ownership, unique reference call matching and property forms. Per-database cache keys, target order/deduplication and exact-versus-candidate multiplicity remain intact.
- Similarity reasons, strong-domain policy and category precedence are separate; original thresholds and recommendations remain intact.
- Activity parsing separates header/run validation; suppressed-record precedence, malformed-input rejection and language-detail sanitation remain intact.
- Co-change separates file census, pair accumulation and result materialization; bulk filtering, focus denominators, pair order, recency and confidence remain intact.
- Object members dispatch pairs, methods and spreads while retaining recursive depth, independent seen sets and definition deduplication.
- Source search separates line matching and owner identity; stale compiler exclusion, fallback ownership, CRLF handling, line order and coverage remain intact.
- Semantic cache scanning separates file eligibility and cached payload acceptance; profiling counters, empty cached hits, unsupported-language behavior, unkeyed work and provider-qualified durable writes remain intact.

Validation:

- Changed-file ESLint passes across all nine source files.
- Ten focused source test files pass, 166 tests total: git-history, project-setup, reindex-activity, lossless-source-sensor, similar-topk, runtime-boundary-object-members, system-map, member-call-targets, scip-occurrence-call-targets and typescript-semantic-provider.
- Final header extraction additionally passed reindex-activity (21 tests).
- Current-source health scoped to each owned file reports no complexity warning for any assigned target or introduced helper. Existing unrelated findings remain in these files. JSON receipts are under /tmp/worker3-*-health*.json and /tmp/worker3-health-*.json; payloads were inspected selectively.
- Source preparations accept readonly line arrays, matching the actual source-cache contract.

Remaining limits: root owns final combined typecheck/build/full suite/API/health/review/diff-impact. No new tests were added because existing focused cases exercise the changed policies. No global build, reindex, commit, suppression, threshold, skill or shared maintenance-file changes were made. All nine source files and this checkpoint are worker-3-owned; source work is frozen pending combined validation.
