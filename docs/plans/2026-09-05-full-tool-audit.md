# Full tool audit — 2026-09-05

Status: tool-wide audit pass completed; remediation remains open. Exhaustive integrity certification was not established; the final report states the coverage limits. Audit requested after first-use scanner validation. Preserve the existing uncommitted implementation; this audit is not a release or permission to change LaunchPoint.

## Purpose and evidence rules

Determine which public capabilities work, which produce misleading results, and which remain unverified. A confirmed defect needs a source location and an executable reproducer or failing regression artifact. A limitation is a stated boundary of the implementation; it must not be represented as a successful unsupported analysis. Passing tests are evidence for their exercised cases, not universal correctness or improved agent outcomes.

Use the current local build. Record exact commands, observed results, coverage limits, and counterarguments. Evaluate all public command families and exported query surfaces, with deeper adversarial checks at the boundaries where unknown or incomplete inputs could be reported as success. Do not claim exhaustive correctness of every branch. The integrity skill's five drills are tracked explicitly; unverified members need reasons.

## Checklist

- [x] Inventory public CLI/API surfaces, shipped documentation, ownership boundaries, and test coverage.
- [x] Verify build, packaging, API/type contracts, and full test suite on this audit's source state.
- [x] Audit source health/review: file inventory, metrics/CRAP, duplicates, module ownership, config-only diffs, and dependency roles.
- [x] Audit source navigation and graph evidence: exact reads, search, relationship identity/direction, missing roots, bounds, continuation, and slicing.
- [x] Audit indexed health/quality/cleanup/framework/integrity specialists and their stated evidence strength.
- [x] Audit architecture/impact/planning and source-vs-index freshness behavior.
- [x] Audit configuration, suppressions, setup/uninstall, index lifecycle, watcher/query services, and persisted caches.
- [x] Exercise negative inputs and captured real adapters; recompute representative metrics and compare duplicated concepts.
- [x] Record each confirmed issue with severity, source referents, regression artifact, defense attempt, and recommended fix.
- [x] Write a capability verdict and prioritized remediation list; state unverified areas and retained uncertainty.

## Execution journal

- Started from main at 80c94fb7 with substantial existing uncommitted work from the authorized simplification/scanner project. No reset, commit, publish, or application edits.
- Prior scanner evidence: 5,306 eligible LaunchPoint source files accounted, zero unresolved internal imports, confirmed four-file value cycle and 65 duplication groups; this does not establish every tool capability.
- Read scip-query and scip-integrity-audit skills. Their integrity drills cover negative checker inputs, real adapter samples, primary fallback paths, metric recomputation, and comparisons of duplicate concepts.

## Findings and open evidence gaps

- Confirmed high priority: dependence-slice reports complete while omitting the fallback definition for `input && (value = input)` and `input ? (value = input) : 0`. Local alias writes and nested postfix increments are also omitted with complete coverage. `/tmp/scip-full-audit-library.json`; durable reproducer `benchmarks/full-tool-audit/2026-09-05/library-probes.ts`. Producer: `src/semantic/typescript/local-flow.ts:695-794`, propagated by `src/queries/graph/dependence-slice.ts:163-172`.
- Confirmed: `files` lists tracked-but-deleted files as current. Producer: `src/platform/project-files.ts:828-839`, consumed without existence checks by `src/queries/navigation/files.ts:14-19`. Reproduced in an isolated Git fixture.
- Confirmed on this repository: `code src/runtime/command-kit/help.ts` (nonexistent path) reports matched and returns `CommandDescriptor.helpAfter` from `command-descriptor-types.ts`. Missing paths fall through to symbol resolution at `src/queries/navigation/code.ts:186-189`. Simpler unrelated nonexistent paths correctly remain missing; reproducer must preserve the partially matching path shape.
- Confirmed metric divergence: indexed complexity counts nested-function decisions in the parent and ignores nullish decisions; source health measures these independently. Actual compiler-index fixture also reports three callees for `choose`, which contains no calls. Investigating additive candidate inclusion.
- Confirmed detector noise: test-quality reports a `declare function test(...)` signature as a high-severity assertion-free test in addition to the actual assertion-free invocation. Need AST invocation distinction.
- Product usability: ordinary help omits health/review; full help contains them. 95 public help invocations passed.
- Existing verification completed on unchanged implementation: 2,900/2,900 tests across 337 files, typecheck, lint/API checks, production dependency audit, npm pack dry-run. Logs `/tmp/scip-full-audit-*`. CLI fixture was actually compiled by scip-typescript; command-family probe artifacts are under `/tmp/scip-full-audit-probes`.
- Self-audit is available on the small real-index fixture but unavailable on this large repository with the semantic service stopped; it truthfully returns available=false and oracleCoverage=0. The main repository's test-quality run did not have indexed test files; its empty result is not proof of test quality.
- Confirmed high priority: TLA mapping `traces: ["missing-trace.json"]` yields verify exit 0 and no findings; the same missing file explicitly passed as `--trace` yields exit 1. `src/runtime/query-commands/tla.ts:334-341` deliberately drops mapping trace load errors. Captured in lifecycle artifacts.
- Confirmed: setup smoke table marks the nonexistent `scip-query capability-matrix --json` command pass. Actual invocation exits 1 (unknown command). `src/runtime/project-setup.ts:902-976` infers several pass statuses from readiness rather than executing those operations. Setup's health run invokes indexed health but identifies itself as ordinary health.
- Confirmed: source findings cannot be suppressed on first use (suppress requires index.db). After indexing, a correctly written and config-validated exact suppression still has no effect on default `health --check`, which exits 1 with the same finding and no adjudication disclosure. `/tmp/scip-full-audit-suppression`.
- Confirmed operational blocker: `tla fetch-tools` rejects the current v1.8.0 asset checksum. Expected `237332bdcc79a35c7d26efa7b82c77c85c2744591c5598673a8a45085ff2a4fb`; actual `b658b4e504fdf0b721caf7066320f6b6fe5805f4dd2f717d0e47baba4097205e`. Official GitHub release API independently reports the latter digest, size 4,487,737, updated 2026-09-04. Do not weaken verification or blindly replace the pin. No checker binary was executed; live SANY/TLC adapter verification remains unavailable in this audit.
- Watcher lifecycle confirmed: stale bytes disclosed during cooldown; after restart/edit the poll sequence was stale, stale, stale, stale, fresh and the new symbol appeared in compiler outline. Both task-owned watchers stopped. Setup/uninstall preserved user-authored agent text.
- Packed ESM consumer imported all 77 export paths; declarations present. Initial CommonJS require.resolve probe was invalid for this ESM-only package and was corrected, not filed as a defect.
- Standalone audit assertions currently fail 8/15 checks, including four slice failures, deleted-file inventory, missing-file identity, and two complexity disagreements. Five actual executions of the fixture functions verify the expected behavior independently.

## Final report and repair checklist

Follow-up completed: [individual assessment and revised repair sequence](2026-09-05-full-tool-audit-assessment.md). Use that document for current priorities, acceptance criteria, and qualifications to the original assertions. All ten findings have been assessed; none of the production repairs below is marked complete.

The [full audit report](../benchmarks/2026-09-05-full-tool-audit.md) records ten prioritized finding groups, evidence, counterarguments, and fixes. No production changes were made during this audit. The [standalone probes](../../benchmarks/full-tool-audit/2026-09-05/README.md) preserve the failures for the implementation follow-up.

- [ ] F01: correct/disclose conditional writes, aliases, nested increments, and parser errors in local slices; verify downstream cohesion consumers.
- [ ] F02: keep explicit missing file paths out of fuzzy symbol selection.
- [ ] F07: confine suppression filenames, preserve write/read identity, migrate nested records, and connect source health/review adjudication without an index.
- [ ] F03: replace inferred setup smoke pass statuses with actual execution or clearly named readiness checks.
- [ ] F04: retain mapping and CLI trace load failures identically.
- [ ] F05: share function metrics and separate real calls from candidate chunk neighbors.
- [ ] F06: current file discovery must filter tracked deletions.
- [ ] F08: test-quality must identify invocation callbacks rather than declarations.
- [ ] F09: verify and repair the immutable checker distribution contract without weakening checksum verification.
- [ ] F10: expose health/review in default help and align setup/source/indexed health modes.
- [ ] After fixes: regenerate audit captures, preserve desired assertions, rerun relevant/full checks, and run representative agent outcome evaluations.

Final evidence: the existing suite passed 2,900 tests in 337 files. The new independent audit assertions pass 16/35 and fail 19/35; these failures remain open. The local slice model also reports complete coverage for malformed syntax. Suppression IDs were demonstrated to escape their storage directory inside a disposable fixture, and nested source-finding IDs failed their storage round trip. A flat-ID control confirms source health separately ignores a valid decision. Raw results are archived compactly with hashes.

Handoff: audit artifacts and local links verified; production input hashes unchanged; archive hashes match. Task-owned watchers stopped and disposable repositories/packed consumer removed. No commits or application edits. Continue with the open repair checklist, not a restart of discovery.
