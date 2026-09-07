# scip-query scanner self-audit

Repository revision: `039149d4dd7cdb49b0b8ced5773452d753db87b6`, main. Run on September 6, 2026 local time. The request was to exercise the scanner on this repository and assess what its findings mean. No implementation changes were made. The pre-existing untracked LaunchPoint validation report was preserved.

## Scope and observed results

The current build ran `health --full`, `system --source --full`, `architecture`, `health --indexed`, `complexity expandSystemMapFileFrontier`, and `cycles`. Help was checked for health, system, complexity, architecture and inspect. Exact implementations were read with inspect/code, with search and incoming execution evidence used for a selected consumer. The ordinary human `health` report was also exercised and all three output pages were drained.

Source scans and bounded indexed analyses completed. These observations are command smoke checks and selected finding assessments, not a new full test-suite run or a behavioral review of every module.

| Observation | Result | Meaning and limit |
| --- | --- | --- |
| Source coverage | 560/560 eligible TS/JS files; 12,138 implemented functions; no recorded scan problems | Default exclusions include tests, declarations, build output and unsupported file types. This is not a scan of every language or every test. |
| Source findings | 652 complexity findings across 240 files; seven duplicate-body groups | Complexity is a measurement; duplication is a candidate for shared ownership. Neither count is a bug count. 601 complexity findings are in `src/`; the remainder are tooling. |
| Source module inventory | 43 populated groups, eight without findings; 215 cross-group edges | Groups describe configured file membership, not proven conceptual ownership. |
| Source architecture configuration | 47 boundaries and 47 dependency-policy rows; all 560 files mapped unambiguously | Four configured boundaries have no eligible files in this source scan. |
| Architecture checks | No forbidden directions, boundary cycles or source value-import file cycles reported | A clean policy check does not prove that the policy or the design is good. |
| Indexed coverage | Fresh index; 557 documents, 41,156 symbols; all indexed documents mapped | Indexed and current-source inventories have different coverage. They must not be treated as interchangeable totals. |
| Indexed candidate scan | 17 similar pairs, two small duplicate-body groups, 18 twin groups, five forwarding candidates, 11 co-change pairs | Large-index mode examined its highest-priority 2,500 symbols and retained the top 50 findings per applicable analysis. Counts are bounded, not exhaustive. |
| Test coverage for metrics | No source-matched coverage artifact supplied | CRAP measurements are unavailable. This does not mean that the repository has no tests. |

Cyclomatic complexity is a source-code measure of branching paths under the tool's stated counting rules. Cognitive complexity is a source-code measure that weights structural decisions and nesting to expose functions that require more context to follow. Neither measures whether those decisions are necessary.

## Assessed maintenance concerns

### 1. Graph expansion concentrates several relationship mechanisms

`src/queries/graph/system-map.ts:1633`, `expandSystemMapFileFrontier`: cyclomatic **63**, cognitive **167**, 297 lines. The `complexity` command also reported 63 using `typescript-function-local-v1`. That is agreement between command surfaces using the same rules, not independent proof that the rules cover every language construct correctly.

The complete body handles compiler-resolved calls, callable references, member-call fallbacks, source constructs, external imports, import-derived call candidates and boundary promotion. Source-owner lookup and relation construction recur across these paths. Its caller is visible in `executeSystemMap` at line 2176.

Assessment: a strong refactoring candidate. An agent changing relation attribution must understand several parallel paths and their shared deduplication state. Separate relationship-specific phases with explicit shared traversal state and one appropriate owner for repeated attribution. Preserve relation-policy gates, source restrictions, depth, exact/candidate strength, compiler-call deduplication, service-consumer tracking and boundary-promotion rules. Do not merge different evidence guarantees merely to shorten the function.

### 2. Index conversion combines parsing, normalization and database writes

`src/reindex/scip-sqlite-converter.ts:287`, `convertScipBufferToSqlite`: cyclomatic **69**, cognitive **134**. The complete body contains database setup, two wire-format passes, document/symbol insertion, occurrence normalization, enclosing-range validation, chunk/mention writes, yielding, cancellation and transaction cleanup.

Assessment: a strong candidate for explicit conversion phases. Counterevidence matters: the phases share insertion-order identities and the code documents measured performance reasons for individual prepared inserts. Preserve document/symbol ordering, duplicate handling, counters, cancellation/yield points, the rollback path, database closure and the separate index-creation transaction. A refactor needs converter-equivalence, malformed-input and interruption checks, plus representative performance validation.

### 3. Request decoding is large and repetitive, but its checks are necessary

`src/runtime/query-service-server.ts:331`, `parseEnvelope`: cyclomatic **80**, cognitive **65**. The complete body validates common mailbox/session fields, then validates and reconstructs each request kind. Many branches repeat the envelope and generation fields.

Assessment: consider common envelope validation followed by request-specific decoders. High branching here partly reflects legitimate input validation. Removing checks would lower the metric while weakening the implementation. Preserve session identity, protocol version, deadlines, generation, selector bounds and each request's validation and errors. Validate malformed envelopes and every supported request kind before replacing it.

### 4. A small duplicate has a clear shared contract

`src/platform/repository-cache-lock.ts:15` and `src/reindex/shared-generation-store.ts:832` contain the same legacy lock-record decoder: accept a non-array object with a positive safe-integer `pid`, otherwise return null. Both supply that decoder to `tryAcquireProcessFileLock`.

Assessment: a credible small consolidation into the common lock implementation. The generic lock and shared-generation lock still have different acquisition contracts, paths, timing and completion outcomes; those are not interchangeable merely because the decoder is identical.

## Scanner problems exposed by using it

### Default output spends its first page on irrelevant-to-this-scan records

The normal `health` report printed **83 unmatched suppression decisions** before its finding groups. Its first 6,355-character page contained no actionable finding. The whole default report occupied three pages, 15,092 characters. `renderMaintenanceSuppressions` in `src/runtime/query-commands/maintenance.ts:104` prints every decision.

Assessment: confirmed presentation defect for agent use. Summarize unmatched decisions and provide an explicit detail path while keeping applied, rejected or otherwise decision-relevant suppressions visible. An unmatched record in this mode is not proof it should be deleted; some records belong to other detectors or scopes.

### The five-group shortlist obscures major concentrations

The first group was performance tooling, led by three identical benchmark summary helpers. Three of the five displayed groups were tooling groups. `runtime-services` had 100 findings across 47 files and `reindex` had 64 across 34 files, yet neither appeared in the default shortlist. Graph queries did appear second.

Assessment: confirmed visibility limitation, not proof that one universal severity formula would be correct. Expose a compact complexity shortlist and duplication shortlist without allowing one category to crowd out the other. Preserve recoverable complete results. Module finding counts identify where to look; they do not prove that a module owns too many responsibilities.

### Indexed reporting still talks about a removed health score

The indexed report has no overall score field, but still emits `scoreInterpretation.status = experimental-composite` and the warning beginning “The score summarizes analyses…”. The text originates at `src/runtime/health-capability-disclosure.ts:20`. Its co-change action also mentions score-weighted counts.

Assessment: confirmed stale product language. Remove obsolete composite-score metadata and describe remaining measurements by what they count. This is distinct from per-candidate ranking values.

### Historical co-change results need judgment

The indexed report's leading hidden-coupling examples include pairs of audit documents and a benchmark ledger paired with its result log. Shared commit history is observed; an architectural defect is not established by those examples. Do not turn these pairs into automatic module-refactoring recommendations.

## Apparent disagreement that has an explanation

The indexed scan reported one dependency cycle. `cycles` identified:

- `src/source/ast/function-metrics.ts` imports a value from `maintenance-bindings.ts`.
- `src/source/ast/maintenance-bindings.ts` imports a type from `function-metrics.ts`.

Current-source import observations confirm those roles. The type-only return edge does not participate in the source scanner's runtime value-import cycle check, and both files belong to the same configured boundary. Thus zero source value-import cycles, zero boundary cycles and one indexed reference-based cycle are compatible observations. A second Rust lib/main component was explicitly classified as a module-structure candidate rather than a real dependency cycle.

## Recommended order

1. Make the default scan immediately useful: compact suppression disclosure, visible complexity and duplication shortlists, and removal of stale score language.
2. Consolidate the shared legacy lock decoder with preservation tests.
3. Plan graph-expansion simplification around its relationship phases and evidence guarantees.
4. Separate converter phases and request decoders only with the contract and performance checks described above.
5. Use actual agent tasks to evaluate whether these changes reduce missed behavior and unnecessary edits. Do not treat reducing the 652 warnings as the goal.

The full source inventory was observed; implementation review was deliberately concentrated on the concerns above. The other complexity findings and indexed candidates remain unassessed individually.

## Reproduction artifacts

Full machine reports were saved outside the repository and inspected programmatically:

- `/tmp/scip-self-audit-health.json`
- `/tmp/scip-self-audit-system.json`
- `/tmp/scip-self-audit-architecture.json`
- `/tmp/scip-self-audit-indexed-health.json`
- `/tmp/scip-self-audit-complexity.json`
- `/tmp/scip-self-audit-cycles.json`

Source/evidence packets are `/tmp/scip-self-audit-top-source.json`, `/tmp/scip-self-audit-fold-source.json`, `/tmp/scip-self-audit-lock-consumers.json` and `/tmp/scip-self-audit-hotspot-consumer.json`. These temporary paths are local run artifacts; this document preserves the conclusions if they are removed.
