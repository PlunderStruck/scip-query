# Wave 3 worker 3 checkpoint

Base: 6fa43612. Plan: complete source implementations read before START. Separate coherent selection, validation, accounting, parsing and cleanup responsibilities while preserving exact predicates, fallback/error precedence, mutation order and bounds. Run focused source/unit-fixture tests, installed formatting/lint and scoped health. No external benchmark, build, reindex or commit. Other workers own different files.

Targets:
- complexity:src/source/ast/ast-runtime.ts:loadGrammar
- complexity:src/source/primitives/file-kind.ts:isStructuralEntryPath
- complexity:scripts/score-detector-labels.ts:scoreLabels
- complexity:src/language-parsers/languages/jvm.ts:parseScalaImportsAst
- complexity:scripts/affected-set-shadow-contract.mjs:runLeafCorpus
- complexity:scripts/codex-exploration-trial-core.mjs:parseCodexJsonl
- complexity:scripts/semantic-command-calibration.mjs:summarizeParsedJson
- complexity:skills/scip-explore/scripts/capture-evidence.mjs:main
- complexity:src/reindex/reindex-activity.ts:summarizeLanguageActivity
- complexity:src/reindex/sqlite-generation-store.ts:collectLocalSqliteGenerations
- complexity:src/runtime/repository-cache-lifecycle.ts:readLease
- complexity:src/analysis/framework-patterns.ts:collectSuppressionExclusions.walk

## Completed changes and preserved contracts

- Grammar loading separates the exact native package map from special module shapes; failed-language/cache precedence and lazy loading remain intact. Entry classification uses the same finite basename set and retains all later path rules.
- Label scoring separates tier resolution from verdict accounting, preserving direct-vocabulary handling, duplicate signal dominance, label order, and null ratios.
- Scala parsing separates selector and bare-import construction, retaining wildcard, rename, empty-prefix, fallback-path, and declaration ordering behavior.
- Corpus execution separates measurement, repair, and error reporting. Mutation state updates immediately after writes; cleanup retains original restoration, final Git-state precedence, error merging, and active-root clearing. No benchmark was launched.
- Codex parsing separates line decoding from ordered event/item accumulation; parse and missing-field error precedence remains unchanged.
- Calibration output uses fixed ordered metric names, retaining exact type checks, graph fallback, key caps, and separately emitted fields.
- Capture orchestration separates output validation, reuse decisions, query execution, and projection persistence; directory/file modes, exclusive writes, command arguments, refusal ordering, and size bounds remain unchanged. Skill text/policy was not changed.
- Language activity separates shard reuse, duration, and fallback-field selection; top-level diagnostics, cache byte preference, fallback fields, and output key order remain intact.
- SQLite collection retains all work under the original lock and release in finally, protected-generation precedence, both retention limits, callback receiver, counters, and telemetry/error behavior.
- Lease parsing separates identity, optional fields, and activity checks without claiming stronger types or changing accepted JSON values.
- Suppression adjacency scans preserve indexed sibling matching, backwards comment/attribute traversal, and pre-order results; no suppression policy changed.

## Validation and limits

- Existing focused Vitest suite: 12 files, 110 tests passed (framework patterns, generation store, cache lifecycle, Codex parser, capture evidence, label scoring, AST node index, source evidence, type container map, reindex activity, debloat health, definition fallback).
- Unique regression suite: `tests/scripts/complexity-wave3-worker-3.test.ts`, 3 tests passed. Isolated function declarations exercise leaf alternating mutation/repair, combined run/cleanup error precedence, and calibration field order/type checks/sparse array lengths. Top-level benchmark scripts are never executed.
- Installed ESLint and Prettier check passed for all 12 owned source/script files and the new test. `git diff --check` passed.
- Scoped health inspected every assigned file. Initial warnings in Scala parsing, corpus orchestration, and one-language activity were resolved by further responsibility splits. Final reports contain no assigned-target or new-helper complexity warnings. Existing unrelated findings remain explicitly out of scope; no suppressions or thresholds changed.
- Metrics artifacts: `/tmp/wave3-worker3-health-0.json` through `-11.json`; final replacements `/tmp/wave3-worker3-health-final-0.json` (JVM), `-1.json` (corpus), `-2.json` (activity). Root will record exact before/after review function metrics and perform combined build/types/API/full-suite/impact checks.
- Source and tests frozen after final lint/format/health; all processes completed. No build, reindex, commit, installation, VM action, or external model benchmark performed.
