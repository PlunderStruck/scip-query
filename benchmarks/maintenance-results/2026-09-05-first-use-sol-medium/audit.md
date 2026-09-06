## Audit result

The selected cycle and duplication findings are source-supported and useful as investigation leads. They do not establish runtime failures or justify refactoring by themselves. The architecture summary is too compressed to support policy conclusions, and the review implementation has two concrete comparison/evidence-labeling defects.

### Verified findings

1. **The LaunchPoint dependency cycle is supported as a static relationship.**

The supplied source contains all four reported value-import/re-export edges:

- `client-access/index.ts` re-exports `campaign-workspace-location`.
- That module imports the `clients` barrel.
- The barrel re-exports `queries`.
- `queries` imports the `client-access` barrel.

See [launchpoint-source.txt](</Users/aydansalois/Documents/GitHub/scip-query/benchmarks/maintenance-results/2026-09-05-first-use-sol-medium/launchpoint-source.txt:2>) and [report-sample.json](</Users/aydansalois/Documents/GitHub/scip-query/benchmarks/maintenance-results/2026-09-05-first-use-sol-medium/report-sample.json:4>).

The scanner constructs a graph from eager value imports and reports strongly connected components in [source-dependencies.ts](</Users/aydansalois/Documents/GitHub/scip-query/benchmarks/maintenance-results/2026-09-05-first-use-sol-medium/implementation/src/queries/health/source-dependencies.ts:46>). Thus “derived” is appropriate: the relationship is deterministically computed from captured import syntax and resolution.

This is useful for planning because it names exact edges and suggests a likely barrel-boundary problem. It does **not** establish module-initialization failure, undefined exports, request-path execution, or user-visible impact. Those depend on compiler and bundler behavior and which exports execute at runtime.

2. **The duplication finding is supported, but extraction remains a design recommendation.**

All three displayed `parseCreatorIds` bodies are identical: read `ids`, split, trim, remove empty values, and deduplicate. See [launchpoint-source.txt](</Users/aydansalois/Documents/GitHub/scip-query/benchmarks/maintenance-results/2026-09-05-first-use-sol-medium/launchpoint-source.txt:68>). The implementation correctly labels duplication as a candidate and explicitly requires contract/caller review in [source-findings.ts](</Users/aydansalois/Documents/GitHub/scip-query/benchmarks/maintenance-results/2026-09-05-first-use-sol-medium/implementation/src/queries/health/source-findings.ts:138>).

The sample does not include enough caller behavior to establish that all three routes own one business rule. Their adjacent comments already differ slightly. Sharing a helper may be sensible, but it is not a measured conclusion.

3. **The architecture disclosure cannot support a policy finding.**

A grouping-only cycle is a cycle between aggregate groups, such as directories or declared boundaries, produced by files pointing in both directions across those groups. Different files can produce the opposing edges even when no executable file-level cycle exists.

The sample reports three such cycles only as sizes—628, 13, and 5—with no group names, contributing edges, file-cycle members, or `violatesPolicy` value ([report-sample.json](</Users/aydansalois/Documents/GitHub/scip-query/benchmarks/maintenance-results/2026-09-05-first-use-sol-medium/report-sample.json:63>)). “One declared policy row” does not reveal what that policy requires.

The supplied implementation expects the compact context to retain `configured`, coverage, policy coverage, dependency-role meaning, boundary names, file-cycle members, and whether each cycle violates policy ([source-dependencies.ts](</Users/aydansalois/Documents/GitHub/scip-query/benchmarks/maintenance-results/2026-09-05-first-use-sol-medium/implementation/src/queries/health/source-dependencies.ts:10>)). Their absence from the sample makes the cycles neither actionable nor classifiable as violations. The evidence establishes aggregation structure, not bad architecture.

4. **Configuration errors can receive misleading comparison statuses.**

`sourceComparable` is calculated before current/base project-configuration problems are appended ([source-review.ts](</Users/aydansalois/Documents/GitHub/scip-query/benchmarks/maintenance-results/2026-09-05-first-use-sol-medium/implementation/src/queries/health/source-review.ts:83>)). Dependency comparability protects disappearing findings, but not newly observed findings, which can still become `introduced` at lines 248–260.

Reproducer: compare a valid base with a current malformed `tsconfig.json` that causes an internal alias to stop resolving. The report’s overall coverage becomes incomplete, but the resulting broken-dependency finding can still be labeled `introduced` rather than `uncomparable`. Configuration-only architecture changes are otherwise deliberately expanded across files, while compiler changes that alter resolution are represented through `relationshipChangedFiles`.

5. **Responsibility evidence can be attributed to the wrong exported functions.**

In [source-modules.ts](</Users/aydansalois/Documents/GitHub/scip-query/benchmarks/maintenance-results/2026-09-05-first-use-sol-medium/implementation/src/queries/health/source-modules.ts:99>), the detector collects export names from an entire connected group before removing functions that are non-exported or below 60 tokens. Consumers of a removed small function can therefore satisfy the consumer requirement for the remaining substantial functions.

A reproducible fixture would place two large exported functions and one small exported function in each of two independent binding groups, then import only the small function from distinct consumer files. The detector can report substantial groups with named consumers even though no displayed substantial function has an observed consumer. Consumer filtering should use exports belonging to the retained functions.

The LaunchPoint “no qualifying candidates” note is not evidence that responsibilities are well placed. The detector intentionally misses classes, indirect re-exports, dynamic/external consumers, pure groups without imported dependencies, and files below its thresholds.

6. **One coverage statement conflicts with implementation behavior.**

The limits say package aliases require separate indexed evidence ([source-findings.ts](</Users/aydansalois/Documents/GitHub/scip-query/benchmarks/maintenance-results/2026-09-05-first-use-sol-medium/implementation/src/queries/health/source-findings.ts:57>)), yet the resolver explicitly uses captured compiler configurations and `paths` mappings ([maintenance-imports.ts](</Users/aydansalois/Documents/GitHub/scip-query/benchmarks/maintenance-results/2026-09-05-first-use-sol-medium/implementation/src/source/ast/maintenance-imports.ts:99>)). The selected cycle itself contains two `@/` alias edges. Either the disclosure is stale or the report should explain why those edges are sufficiently resolved.

### Hypotheses requiring further evidence

The cycle may cause runtime initialization problems, and consolidating the parsers may reduce drift, but neither follows from these artifacts. Likewise, the large grouping-only cycles may expose excessively broad boundaries, but they could also be harmless aggregation artifacts.

This audit establishes that the scanner can produce two accurate, concrete leads and identifies implementation defects that could mislead review. It cannot establish that coding agents make better changes: there is no control condition, task-outcome measurement, precision/recall sample, defect rate, review-time comparison, or downstream agent behavior. Fewer complexity points or more warnings would not constitute improvement without better coding outcomes.