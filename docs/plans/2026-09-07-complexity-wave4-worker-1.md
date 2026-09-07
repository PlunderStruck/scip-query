# Complexity wave 4 — worker 1

Baseline `1d028fc1`. Exclusive ownership replaces prior waves and is defined by `/tmp/complexity-wave4-worker-1-targets.json`. Other workers edit separate files; no build, reindex, commits, VM actions, package/policy/threshold/suppression changes.

## Targets and plan

- src/queries/cleanup/co-change.ts:coChange — coChange: cyclomatic 18, cognitive 22.
- src/queries/cleanup/doc-drift.ts:docsCitingFiles.<callback:profileSpan:1> — docsCitingFiles.<callback:profileSpan:1>: cyclomatic 15, cognitive 27.
- src/queries/internal/consumer-evidence.ts:computeFileLeafUsageFromAst — computeFileLeafUsageFromAst: cyclomatic 14, cognitive 27.
- src/queries/quality/complexity.ts:countBranchesFromRegex — countBranchesFromRegex: cyclomatic 15, cognitive 27.
- src/queries/quality/slice-cohesion.ts:containerAccesses — containerAccesses: cyclomatic 12, cognitive 27.
- src/runtime/query-commands/cleanup/handlers.ts:handleDocDrift.<callback:dbCommand:0> — handleDocDrift.<callback:dbCommand:0>: cyclomatic 15, cognitive 27.
- src/runtime/query-commands/navigation.ts:sourceInspectionSections — sourceInspectionSections: cyclomatic 18, cognitive 14.
- src/source/facts/behavior-skeleton.ts:collectBehaviorCandidates — collectBehaviorCandidates: cyclomatic 18, cognitive 15.
- src/symbols/graph/member-call-targets.ts:indexServiceReceivers.<callback:walk:1> — indexServiceReceivers.<callback:walk:1>: cyclomatic 18, cognitive 13.
- src/symbols/leaf-symbol-index.ts:pickAstCallCandidate — pickAstCallCandidate: cyclomatic 17, cognitive 27.
- src/queries/cleanup/test-quality.ts:testQuality — testQuality: cyclomatic 13, cognitive 26.
- src/queries/quality/slice-cohesion.ts:modelBody — modelBody: cyclomatic 17, cognitive 22.

All complete target implementations read through scip-query and every cursor drained before START. Refactor coherent responsibilities: co-change pair classification; per-document citation screening/assembly with profiling counts; AST cursor advancement retaining import depth and native cursor traversal; regex match counting retaining every language fallback; body unit/alias model assembly and per-unit container collection; doc and inspection rendering; behavior candidate range/signal collection; service receiver declaration/callback forms; member/direct candidate precedence; per-file test-quality collection. Preserve ordering, defaults, finite limits, error/cleanup contracts, concrete element types and same invocation state. Avoid introducing call-argument-size bounds.

## Verification and results

All twelve targets completed across eleven source files. Exact diffs reviewed against `1d028fc1`. No API, policy, suppression, threshold, package, build or index changes. Existing tests provide focused coverage; no shared tests edited and no new regression file needed.

### Preserved contracts

- Co-change retains history/pairs calls before availability/zero-limit returns, partner-mode threshold relaxation, file filtering before scan budget, structural checks and classification order, and finding limit after each accepted pair.
- Documentation scanning retains tracked-file order, all profiling increments, path screening, citation context and claim limits of three, line references, and cited-file sorting.
- Consumer evidence retains native cursor traversal, import-depth increments/decrements on entry/ascent, leaf sets and null-tree behavior; it does not materialize a native node per visit.
- Complexity regex fallback keeps every universal, Python, Rust, Ruby and Go pattern byte-for-byte, original language precedence, comment/string stripping and match counting.
- Slice-cohesion retains statement units, predicate stack and guards, try-handler dependencies, alias/container/state-setter collection, callee spans, hook/enclosing range order, and closure summary after full model creation. Per-unit container access keeps writes, closure reads/writes, passed containers and state writes in order.
- Doc drift and inspection rendering keep messages, optional fields, four-item subject/reference limits, section order, stopping/coverage defaults and newline behavior.
- Behavior candidate range selection preserves source read order, exact callable versus covering-node fallback, receipt limits, signal ordering, source fact calls, and text overrides. Service receiver and symbol candidate helpers retain declaration/callback traversal, alias uniqueness, member import/implicit/local-owner precedence, direct import precedence and generic candidate identity.
- Test-quality retains file sort/scan limit, one-hop assertion vocabulary, skipped/grouping behavior, independent assertion/mock findings, and final per-list truncation. No new argument-size bound was introduced.

### Checks

216 tests passed across 15 existing source-focused test files:

- slice-cohesion (6), slice-cohesion-coverage (4), test-quality (18), co-change-tiers (3), co-change-locale-exemption (1), co-change-partner-labels (6), doc-drift (6), consumer-evidence (1), source-backed-accuracy (14), source-evidence (35), system-map (63), cli-contract (43), complexity (1), function-complexity-contract (6), metric-contracts (9).
- Owned-file ESLint, Prettier check and `git diff --check` passed.
- Source scans: `/tmp/complexity-wave4-worker1-health-final.json` and `/tmp/complexity-wave4-worker1-review-final.json`; selected metrics `/tmp/complexity-wave4-worker1-metrics.json`. All 99 measured changed target/helper/callback records are <=10 cyclomatic and <=15 cognitive. Concurrent lanes were editing during scans, so this is an owned-file assertion, not aggregate completeness.

Target metrics (cyclomatic/cognitive):

- coChange: 10/9
- docsCitingFiles.<callback:profileSpan:1>: 4/3
- testQuality: 5/4
- computeFileLeafUsageFromAst: 8/13
- countBranchesFromRegex: 5/4
- containerAccesses: 3/3
- modelBody: 10/12
- handleDocDrift.<callback:dbCommand:0>: 7/6
- sourceInspectionSections: 3/0
- collectBehaviorCandidates: 5/4
- indexServiceReceivers.<callback:walk:1>: 2/1
- pickAstCallCandidate: 2/1

### Freeze and limits

Source and tests frozen. All worker test/scan processes have exited. Root owns final combined source type checking, build, API/full-suite verification and diff impact. No builds, reindex, commits, VM actions or agent benchmarks run by this worker.

## Type-review follow-up and refreeze

Root combined type checking found that the extracted co-change helpers used `CoChangePairEvidence`, which omits fields carried by actual Git pair records. Both helper parameters now use `GitCoChangePair`, derived from the concrete `gitEvidenceProduct().coChangePairs()` collection element. No runtime behavior changed.

After correction: `tsc --noEmit` passed; all 10 affected co-change tests across three files passed again; co-change ESLint/Prettier/whitespace checks passed. Scoped health/review exports `/tmp/complexity-wave4-worker1-cochange-health.json` and `/tmp/complexity-wave4-worker1-cochange-review.json` retain target/helper complexity within limits.

Worker 3 wave 4 full-diff review completed read-only with no concrete findings. Checked release sequencing/durable state and error finalization, carrier/HTTP traversal and proof identity, Rust response acceptance, extension fallback, Cargo diagnostics, legacy disposition, Git rename/add identity, migration filters/lazy candidate work, and source-range closure bounds. No worker 3 files edited or tests run for the review. All processes exited; lane refrozen.
