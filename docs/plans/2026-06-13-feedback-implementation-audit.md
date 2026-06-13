# Feedback Implementation Audit

Date: 2026-06-13

This audit records what is actually implemented after the GPT 5.5 Pro trust feedback, the follow-up performance feedback, and the Vega_2.0 validation pass.

A capability matrix is a project-readiness report that names each detected language and states which evidence-producing or verification mechanisms can operate on that language. Its real-world referents are rows such as TypeScript and Python in `scip-query capability-matrix --json`; its essential role is to prevent users from treating graph indexing, source fallback evidence, semantic evidence, heuristic detectors, and compiler verification as if they had identical support everywhere.

## Trust Feedback Status

| Item | Status | Evidence |
|---|---|---|
| Stable JSON output for every command | Partially implemented | JSON exists for `health`, `diff-gate`, `cleanup-plan`, `config-validate`, `doctor`, `status`, `capabilities`, and `capability-matrix`. Generic row/list commands still do not all expose stable JSON. |
| Finding metadata: evidence, location, confidence, severity, stable ID | Mostly implemented for diff-gate findings | `diff-gate --json` returns stable IDs, check names, severity, evidence, confidence, file/symbol fields, why, remediation, related files, and suppression hints. Some non-diff-gate command outputs still use their older shapes. |
| Cleanup patch/apply | Implemented | `cleanup-plan --patch` and `cleanup-apply` are descriptor-backed, documented, and covered by tests. |
| Precise language capability matrix | Implemented | `capabilities` and `capability-matrix` now include a per-language `matrix`; `status --json` embeds it; README documents the language-support split. |
| Cleanup verification labels | Implemented enough for current verification behavior | Verification reports detected checkers, uncovered files, baseline errors, dirty overlap, and batch status, so users can tell what was actually compiler-checked. |
| Stale index detection | Implemented | `status --json` and `doctor --json` report `fresh`, `stale`, `missing`, or `unknown` from index metadata and source fingerprints. |
| Structured suppressions | Partially implemented | Config supports structured suppressions with IDs/reasons/expiry, and diff-gate checks honor them. Dedicated suppression-management commands are not implemented. |
| Package docs | Implemented | `package.json` includes `docs/**/*.md`. |
| CI initializer | Implemented | `setup-ci` writes or dry-runs a GitHub Actions workflow. |
| Strict config validation | Implemented | Invalid `.scipquery.json` now fails loudly, and `config-validate`/`doctor` expose diagnostics. |

## Performance Feedback Status

Implemented query-local performance slices:

- Item 5: bulk SQL and exact path lookup improvements for `diff-impact`.
- Items 6 and 7: diff-plan reuse and inverted candidate indexing for `incomplete-migration`.
- Item 8: cached source line arrays through `getSourceLines()`.
- Item 9: indexed-first/Git-first source file sets.
- Item 10: document-scoped `buildChunkCalleeMap()` fallback evidence.
- Item 11: reusable definition line-owner index.
- Item 14: stale semantic callee deletes deduped per file/hash.
- Item 15: cached TypeScript semantic definition lookup.
- Item 19: exact bounded top-K retention for `similarAll()`.
- Item 20: source-shape token index for fallback similarity.

Planned but not implemented performance architecture slices:

- Item 1: Git-blob-backed freshness instead of hashing every file.
- Item 2: per-language incremental reindexing.
- Item 3: merge and sanitize SCIP in one protobuf pass.
- Item 4: per-language SQLite or attached databases.
- Item 12: lazy TypeScript semantic projects by tsconfig.
- Item 13: persisted semantic reference evidence.
- Item 16: persisted Git-history-derived facts.
- Items 17 and 18: health execution strategy and shared corpora.

These are recorded in `docs/plans/2026-06-13-performance-remaining-architecture-plans.md` because they change persisted indexing, cache, or execution contracts rather than replacing repeated local work with equivalent indexed lookup.

## Validation Snapshot

Local `scip-query` validation:

- `npm test`: 56 test files, 278 tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- Focused matrix tests: `tests/project-readiness.test.ts` and `tests/cli-contract.test.ts` passed.

Vega_2.0 validation:

- `reindex --force`: indexed TypeScript and Python in 41.4s on the final pass.
- `status --json`: fresh, 93,032 symbols, 1,663 files, TypeScript and Python detected.
- `capability-matrix --json`: TypeScript reports semantic and `tsc --noEmit` verification; Python reports SCIP/source fallback support but no semantic provider and no detected Python checker.
- `stats`, `outline`, `diff-impact`, `incomplete-migration`, `cleanup-plan --json`, `cleanup-plan --verify`, and `health --json`: ran successfully.
- `diff-gate --json`: exited 1 with real findings in Vega's current dirty diff, not a tool failure.

## Honest Remaining Work

The feedback is not literally exhausted. The two largest remaining trust gaps are stable JSON for every legacy command shape and first-class suppression-management commands. The largest remaining performance gaps are the reindex/cache architecture slices listed above.
