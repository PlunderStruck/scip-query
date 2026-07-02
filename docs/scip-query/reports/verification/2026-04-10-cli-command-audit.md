# CLI Command Audit

Date: 2026-04-10

## How this audit was done

- Rebuilt the shipped CLI with `npm run build`.
- Reindexed the current repo with `node dist/cli.js reindex`.
- Ran a 52-command smoke pass against the built CLI on this repo.
- Used the direct query tests in [tests/queries.test.ts](/Users/aydansalois/Documents/GitHub/scip-query/tests/queries.test.ts), [tests/queries-advanced.test.ts](/Users/aydansalois/Documents/GitHub/scip-query/tests/queries-advanced.test.ts), [tests/debloat-health.test.ts](/Users/aydansalois/Documents/GitHub/scip-query/tests/debloat-health.test.ts), [tests/cli-contract.test.ts](/Users/aydansalois/Documents/GitHub/scip-query/tests/cli-contract.test.ts), and [tests/scip-cli.test.ts](/Users/aydansalois/Documents/GitHub/scip-query/tests/scip-cli.test.ts) as the main semantic evidence.
- Source-reviewed side-effectful or long-running commands instead of running them when execution would mutate user config or block indefinitely.

## Status legend

- `Verified`: direct test coverage and/or repo behavior matched the command's purpose.
- `Verified (specific input)`: good results for a specific symbol or file, but broad fuzzy matching can still mislead.
- `Smoke ok`: executed successfully on this repo, but no direct semantic test covered it.
- `Source reviewed`: not executed because it mutates user state or runs indefinitely; source looked reasonable.
- `Needs fix`: a concrete correctness or purpose gap was observed.

## Fix codes

- `M1` Symbol disambiguation: commands that resolve the first `%pattern%` match can silently choose a module or unrelated symbol. Main targets: [src/query-support.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/query-support.ts), [src/queries/trace.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/trace.ts), [src/queries/hierarchy.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/hierarchy.ts). Fix by ranking exact leaf-name matches first and erroring or disambiguating on multiple strong matches.
- `M2` Runtime entry-surface awareness: raw dead-code style commands still flag runtime-reachable files such as the CLI, worker, package root, and postinstall entrypoints. Main targets: [src/queries/dead.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/dead.ts), [src/queries/isolated.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/isolated.ts), [src/entry-surfaces.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/entry-surfaces.ts).
- `M3` Test-reference blind spot: the SCIP graph is not seeing the Vitest references that exist in the repo, so test-oriented reports undercount badly. Main targets: [src/queries/test-coverage.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/test-coverage.ts), [src/queries/change-surface.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/change-surface.ts), [src/queries/diff-impact.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/diff-impact.ts), [src/queries/health.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/health.ts).
- `M4` Import-role blind spot: TypeScript import roles are not available in this index, so import-oriented commands do not serve their real purpose on this repo. Main target: [src/queries/imports.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/imports.ts). Fix by adding a TypeScript fallback parser or an explicit unsupported-language result.
- `M5` Similarity/convergence mismatch: function-level similarity still includes module symbols, and `convergence` does not reliably accept the labels that `similar` prints. Main targets: [src/queries/similar.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/similar.ts), [src/queries/convergence.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/convergence.ts), [src/queries/health.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/health.ts).
- `M6` Status path mismatch: `status` checks only the configured cache path, while the rest of the CLI still falls back to project-root `index.db`. Main target: [src/cli.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/cli.ts).
- `M7` Member lookup depends on missing enclosure metadata: `members` relies on `enclosing_symbol`, which is not populated usefully for this repo's index. Main target: [src/queries/members.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/members.ts).
- `M8` Diff impact ignores untracked files: `git diff --name-only HEAD` excludes brand-new files, so the change report is incomplete during active work. Main target: [src/queries/diff-impact.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/diff-impact.ts).

## Command-by-command audit

### Index and navigation

| Command | Status | Notes |
| --- | --- | --- |
| `reindex` | Verified | Rebuilt the repo index successfully from the shipped CLI. |
| `stats` | Verified | Direct fixture test plus live-repo smoke output looked correct. |
| `files` | Verified | Direct fixture test plus live-repo smoke output looked correct. |
| `symbols` | Verified | Direct fixture test plus live-repo smoke output looked correct. |
| `methods` | Verified | Direct fixture test plus live-repo smoke output looked correct for `Watcher`. |
| `refs` | Verified (specific input) | Good on unique symbol names; broad patterns still aggregate all matching symbols. |
| `trace` | Needs fix (`M1`) | `trace reindex` merged `reindex-worker`, `detectLanguages`, `reindex()`, and `getIndexerConfig()` into one trace. |
| `deps` | Verified | Direct fixture test plus live-repo smoke output looked correct. |
| `rdeps` | Verified | Direct fixture test plus live-repo smoke output looked correct. |
| `system` | Verified | Direct fixture test plus live-repo smoke output looked correct. |
| `surface` | Verified | Direct fixture test plus live-repo smoke output looked correct. |
| `outline` | Smoke ok | No concrete bug found in smoke testing. |
| `members` | Needs fix (`M7`) | `members Watcher` and `members ScipDatabase#` both returned nothing even though `methods Watcher` works. |
| `hierarchy` | Needs fix (`M1`) | `hierarchy reindex` returned `src:reindex:install`, which is not what a user asking about `reindex()` likely means. |
| `call-graph` | Needs fix (`M1`) | `call-graph reindex` resolved to the `src:reindex:indexers` module instead of `reindex()`. |
| `code` | Needs fix (`M1`) | `code reindex` showed the `src/reindex/indexers.ts` module, not the `reindex()` function. |
| `complexity` | Needs fix (`M1`) | `complexity reindex` analyzed the `src:reindex:indexers` module, not `reindex()`. |
| `dataflow` | Verified (specific input) | Advanced fixture coverage is good for unique symbols; broad fuzzy matches still inherit `M1`. |
| `slice` | Needs fix (`M1`) | Advanced fixture coverage is good for unique symbols, but `slice reindex` resolved to the wrong module symbol. |
| `affected` | Verified (specific input) | Works for a unique target; should eventually move to the improved matcher from `M1`. |

### Structural analysis

| Command | Status | Notes |
| --- | --- | --- |
| `dead` | Needs fix (`M2`) | Still reports `src/cli.ts`, `src/reindex-worker.ts`, and `src/index.ts` as dead code. |
| `hotspots` | Smoke ok | No concrete bug found in smoke testing. |
| `fan-in` | Verified (specific input) | Good on specific symbols; broad fuzzy patterns can still aggregate more than one symbol. |
| `fan-out` | Smoke ok | No concrete bug found in smoke testing. |
| `coupling` | Smoke ok | No concrete bug found in smoke testing. |
| `cycles` | Verified | Live-repo smoke plus health verification showed zero cycles as expected. |
| `bottlenecks` | Smoke ok | No concrete bug found in smoke testing. |
| `isolated` | Needs fix (`M2`) | Still reports runtime entrypoints such as `src/postinstall.ts` as isolated. |
| `by-kind` | Smoke ok | No concrete bug found in smoke testing. |
| `kind-counts` | Smoke ok | No concrete bug found in smoke testing. |
| `deep-chains` | Smoke ok | No concrete bug found in smoke testing. |
| `similar` | Needs fix (`M5`) | Top result was module `src:cli` vs module `src:queries:index`, even though the command claims to find similar functions. |
| `similar-files` | Verified | Advanced fixture coverage plus live-repo smoke behaved as intended. |
| `similar-chains` | Smoke ok | No concrete bug found in smoke testing. |
| `extract-candidates` | Smoke ok | No concrete bug found in smoke testing. |
| `wrapper-candidates` | Smoke ok | No concrete bug found in smoke testing. |
| `passthrough-candidates` | Smoke ok | No concrete bug found in smoke testing. |
| `stale-abstractions` | Verified | Advanced fixture coverage plus live-repo smoke behaved as intended. |
| `complexity-hotspots` | Verified | Advanced fixture coverage plus live-repo smoke behaved as intended. |
| `redundant-reexports` | Verified | Debloat regression coverage plus live-repo smoke behaved as intended. |
| `similar-signatures` | Smoke ok | No concrete bug found in smoke testing. |

### Coverage and reports

| Command | Status | Notes |
| --- | --- | --- |
| `test-coverage` | Needs fix (`M3`) | Passing Vitest suites are not reflected in the structural coverage results. |
| `doc-coverage` | Smoke ok | No concrete bug found in smoke testing. |
| `change-surface` | Needs fix (`M3`) | Risk scoring inherits the same missing-test-reference problem and reports 0% test coverage for touched files. |
| `diff-impact` | Needs fix (`M3`, `M8`) | It reported 0% test coverage for changed symbols and did not include brand-new untracked files. |
| `drift` | Verified | Advanced fixture coverage plus live-repo smoke behaved as intended. |
| `health` | Needs fix (`M3`, `M5`) | The report still inherits undercounted test coverage and the module-level `similar` noise. |
| `convergence` | Needs fix (`M5`) | `convergence src:cli src:queries:index` returned `One or both symbols not found`, so it is not round-tripping the output shape from `similar`. |

### Imports

| Command | Status | Notes |
| --- | --- | --- |
| `imports` | Needs fix (`M4`) | `imports src/cli.ts` reported no imports because the TypeScript index did not expose role `2` import mentions. |
| `imported-by` | Needs fix (`M4`) | Returned empty output for plausible imported symbols in this TypeScript repo. |
| `unused-imports` | Needs fix (`M4`) | Depends on the same missing import-role data, so its TypeScript results are not trustworthy. |

### Runtime and utility commands

| Command | Status | Notes |
| --- | --- | --- |
| `install-skills` | Source reviewed | Reasonable orchestration in source; not executed because it mutates user home directories. |
| `check-deps` | Verified | Correctly reported `scip CLI: installed` on this machine. |
| `init` | Source reviewed | Reasonable source; not executed to avoid writing config into the repo during the audit. |
| `watch` | Source reviewed | Reasonable source; not executed because it is intentionally long-running. |
| `status` | Needs fix (`M6`) | Reported `Exists: no` while `stats` immediately succeeded using the project-root `index.db`. |

## What should be fixed first

1. `M3` Test-reference blind spot. It currently distorts `test-coverage`, `change-surface`, `diff-impact`, and `health`.
2. `M1` Symbol disambiguation. It currently distorts `trace`, `hierarchy`, `call-graph`, `code`, `complexity`, and some `slice`/`dataflow`/`affected` flows on non-unique inputs.
3. `M2` Runtime entry-surface awareness in `dead` and `isolated`. These commands still overstate deletion safety.
4. `M5` Similar/convergence cleanup. It is still mixing modules into a function-oriented workflow.
5. `M6` and `M8` are smaller but high-value fixes because they remove obvious user confusion in `status` and `diff-impact`.

## Bottom line

The CLI is in a better state than before this pass, but it is not yet accurate across the whole surface. The strongest commands today are the file-based graph queries and the newly tested advanced analyses. The weakest areas are test-aware reporting, import-aware reporting on TypeScript, runtime-entrypoint handling in deletion-style reports, and broad fuzzy symbol lookup.
