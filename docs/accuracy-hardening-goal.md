# Accuracy Hardening Goal

Make scip-query's command answers reliable across languages and repositories by separating smoke tests from source-backed accuracy checks, fixing lookup/call-graph gaps found by real repos, and labeling heuristic results as candidates rather than exact facts.

## Scope

- Keep CI changes out of scope for now.
- Add committed test coverage that runs locally with `npm test`.
- Keep real-repo calibration optional because those repositories exist only on some machines.
- Prefer fixes that improve the shared indexing/query machinery over tuning output for one repository.

## Deliverables

1. Source-backed command accuracy coverage:
   - Add fixture/oracle tests for exact commands such as `symbols`, `code`, `refs`, `trace`, `call-graph`, `complexity`, `dataflow`, and `slice`.
   - Cover TypeScript, Python, Rust, and mixed-index behavior where practical.
   - Assert against source facts: definition text, expected files, expected callees/callers, and line-bounded code snippets.

2. Optional real-repo calibration harness:
   - Add a script that can run against local repositories when they exist.
   - Reindex each repo into a temporary cache.
   - Run source-backed checks for selected known symbols.
   - Print clear PASS/FAIL output with the command and evidence.
   - Never require these private/local repositories in normal test runs.

3. Indexer reliability taxonomy:
   - Preserve the existing fail-closed behavior for failed languages.
   - Keep `--allow-partial` as the explicit opt-in for incomplete mixed-language indexes.
   - Repair malformed SCIP definition occurrences before SQLite conversion when that can be done without inventing symbol metadata.
   - Keep conversion failures actionable and specific.

4. Lookup and call-graph accuracy:
   - Fix path-qualified lookup ranking such as `src/app.rs/run` so it prefers symbols defined in that file.
   - Keep exact call graph facts precise while still recovering real callable edges from SCIP mentions when AST extraction misses them.
   - Add regression tests for Rust qualified path calls.

5. Heuristic output labeling:
   - Label heuristic commands as candidates in CLI output.
   - Make the distinction visible for `similar`, `similar-files`, `similar-chains`, `extract-candidates`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, `complexity-hotspots`, and `drift`.
   - Avoid implying those commands are exact compiler facts.

6. Performance guardrails:
   - Add an optional local performance/calibration path that records durations and index sizes.
   - Do not fail normal tests on private-repo timing.

## Acceptance Criteria

- `npm test` passes.
- `npm run typecheck` passes.
- `npm run build` passes.
- The optional calibration script passes on at least one TypeScript repo, one Python repo, and one Rust repo when those repos exist locally.
- Path-qualified Rust lookup resolves `src/app.rs/run` to `app:run()`, not an unrelated `run`-named test.
- `call-graph main` in the Rust fixture reports the qualified `app:run()` callee.
- Heuristic command output includes explicit candidate/disclaimer language.
