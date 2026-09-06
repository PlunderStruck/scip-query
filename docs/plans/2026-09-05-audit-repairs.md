# Audit repairs

Status: all ten assessed findings repaired and verified. Work remains uncommitted on main, preserving the earlier simplification/scanner changes. The [final report](../benchmarks/2026-09-05-audit-repairs.md) records evidence and remaining limitations.

The [assessment](2026-09-05-full-tool-audit-assessment.md) defines the evidence and acceptance criteria. Historical audit artifacts remain unchanged; generate new evidence for repaired code.

## Implementation checklist

- [x] F07 storage: safe names, logical record identity, contained writes/reads, old nested records, conflict preservation.
- [x] F02: explicit file intent cannot fall through to unrelated fuzzy symbols, including legacy API.
- [x] F01: conditional writes, aliases, expression mutations, parse-error coverage; downstream slice consumers.
- [x] F04: all declared trace input errors survive deduplication.
- [x] F05: proven call counts; shared/versioned TS/JS function metrics.
- [x] F06: current-file results exclude tracked deletions without breaking diff inventories.
- [x] F07 source workflow: no-index suppression creation, explicit adjudication and gating, preserve raw findings.
- [x] F03: correct setup commands and separate operation results from readiness.
- [x] F08: parsed test-call discovery excludes declarations and preserves supported cases.
- [x] F10: source health/review discoverability and setup-mode alignment.
- [x] F09: verify intended checker artifact provenance, repair distribution, exercise actual checker adapters without weakening the checksum guard.
- [x] Final: fresh probes, regression/full tests, type/lint/API checks, source review and fresh diff impact, cheaper-model evaluation where available.

## Constraints and preservation

Storage: retain record identity, immutable first writes, revision-based replacement checks, and explicit handling of legacy/conflicting records. Never interpret an ID as write authority outside the suppression directory. Source suppression policy must expose accepted/expired/invalidated/review-required decisions; saving a valid record alone is not acceptance.

Analysis: keep direct call evidence separate from candidates. Limit unsupported flow claims instead of presenting incomplete results as complete. Current working-tree inventories and historical Git inventories have different uses. Optional formal checking must remain independent of first-use scanning.

Testing: reproduce concrete failures with independent behavior assertions; do not require a particular JSON property name or disappearance of raw suppressed findings. Metric equality applies only to the adopted shared metric contract. Reuse existing test fixtures and filesystem mutation/concurrency helpers after reading their contracts.

## Progress

- Started from the assessed ten findings and unchanged recorded production inputs. Historical audit artifacts remain unchanged.
- Implemented F07 safe storage names, nested legacy discovery/in-place revision checks, conflict disclosure, and symlink rejection; all 27 storage tests pass (8 new cases). Source suppression adjudication and no-index CLI creation now pass library and CLI regressions, including evidence changes reopening findings.
- Implemented F02 explicit path handling in both code APIs and F06 current-file filtering; new 10-case locator tests and existing lossless sensor tests pass.
- Implemented F01 expression-statement branches and explicit unsupported coverage for aliases, nested increments/decrements and parse errors. All 16 slice tests pass. Cohesion now scopes coverage to each callable and preserves orchestration explanations alongside limitations; all 6 existing cohesion tests pass.
- F05 uses the shared source function metric for matched TS/JS functions and reports compiler-resolved calls separately from candidate targets. The standalone library audit passes all 18 assertions, the focused metric regression passes, and a real compiler-indexed fixture confirms zero resolved callees for call-free functions and preserved actual calls.
- F04 retains all declared trace input errors; four CLI cases pass (mapping, explicit, duplicate spelling, malformed). F08 parsed invocation discovery passes all 17 tests and the real-index declaration probe.
- F03 setup publishes valid commands and distinguishes operation results from readiness; 21 setup tests pass. F10 exposes health/review/context in default help and labels optional indexed setup health accurately; help tests and CLI probe pass.
- F09 uses stable upstream v1.7.4 after verifying published checksum and release-commit provenance. Live production download/cache validation, corrupted-byte rejection, real SANY parsing, and TLC valid/invalid invariant checks all pass. All 13 new integration probes pass.
- First full run: 2,932 passed, 3 failed. Failures were two old callee-count expectations (updated to assert resolved and candidate counts separately) and the new private query module missing from the test registry. Follow-up: all 143 tests across those files and the changed flow/suppression consumers pass.
- Typecheck and lint (including build, API and skill links) pass. The API acceptance records required new result fields as a breaking construction-contract change; existing result fields remain.
- Source review caught two newly introduced imports bypassing the established source file boundary; corrected both. Fresh review reports no introduced/worsened architecture violation. Reviewed remaining complexity signals; extracted shared increment recognition and separated parsed test-call recognition from traversal. Complex existing compiler/storage decision paths remain visible for review, without adding waivers.
- Refreshed the compiler index and ran indexed health to warm semantic consumers. Corrected one remaining recovery hint to name `health --indexed --full` explicitly. Final impact validation is in progress.
- Expanded integration witnesses to missing explicit CLI files and unreadable traces. A missing lookup's JSON transport exits successfully but explicitly reports zero matches, one missing entry, and no source results; the probe checks that behavior rather than imposing a new exit-code contract.
- Final full suite and a GPT-5.6 Sol medium dependency-direction trial (initial edit plus maintenance change) are running. Trial artifacts: `/tmp/scip-repair-sol-medium-dependency`; do not imply an agent-benefit comparison from this single treatment run.
- Sol medium completed both stages and passed independent checks. The follow-up did not refresh its index and disclosed the gap. This remains a benchmark workflow limitation. Durable trial results and patches are in `benchmarks/full-tool-audit/2026-09-05/repairs/`.
- Added assignment-created aliases to the explicit unsupported cases. The running full suite had already loaded old production code, so it failed that new test; the fresh targeted run passes all 81 tests. Source/tests are now frozen for one final full run.
- Final lint/API/build, typecheck and all 15 integration checks pass. The final library capture passes all 18 assertions. Source review reports no introduced/worsened architecture violations. Explicit full rebuild of TypeScript/Rust/Python succeeds and status reports fresh; both impact methods complete for the selected roots. The impact result still discloses unattributed hunks, so it is not proof of exhaustive change effects.
- Final frozen-source suite: **2,936 tests passed in 339 files** (299.32 seconds). Final downstream flow/consumer set: 81 passed. Fresh checker download and all 15 integration checks passed against the final build. Audit fixture and trial worktrees were removed; the checkout-local watcher was stopped. No commit or publication performed.
