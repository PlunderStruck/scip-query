# Global Install Cross-Verification Result

Date: 2026-06-22

## Outcome

The committed analyzer validation build was pushed and installed globally, then exercised from sibling repositories under `/Users/aydansalois/Documents/GitHub`.

- Pushed commit: `5e44ec4` (`Validate analyzer evidence and scoring`)
- Global binary: `/opt/homebrew/bin/scip-query`
- Installed package: `scip-query@0.10.1 -> /Users/aydansalois/Documents/GitHub/scip-query`
- Raw output root: `/tmp/scip-query-validation/2026-06-22-global-install-cross-verification`

The global CLI successfully ran `reindex`, `capability-matrix`, `health --full --json`, `diff-gate --json`, and stack-specific analyzer probes across all sampled repositories. No sampled repository's git status changed after the runs.

## Local Release Verification

Before commit and push:

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm test`: passed 67 test files and 336 tests. The known fixture `git diff --no-index` usage warning still prints, but Vitest exits cleanly.
- `node dist/cli.js reindex`: passed.
- `node dist/cli.js diff-gate --json`: reported only the accepted pre-commit validation warnings.

After commit:

- `node dist/cli.js diff-gate --json`: passed with no changed files and no findings.
- `git push origin main`: pushed `main` from `7aa69e4` to `5e44ec4`.
- `npm install -g .`: completed successfully.
- `scip-query --version`: reported `0.10.1`.

## Cross-Repository Results

| Repository          | Revision    | Detected capability shape                                         | Health score | Diff gate                     | Stack-specific probes                                      | Status effect |
| ------------------- | ----------- | ----------------------------------------------------------------- | ------------ | ----------------------------- | ---------------------------------------------------------- | ------------- |
| `Stable_Management` | `2354b4e38` | TypeScript with semantic provider and `tsc --noEmit` verification | 93           | 95 findings on 53 dirty files | `vue-large-view-pressure`, `vue-composable-candidates`     | unchanged     |
| `Vega_2.0`          | `628885533` | TypeScript plus Python fallback; TypeScript semantic provider     | 77           | clean                         | `react-large-component-pressure`, `passthrough-candidates` | unchanged     |
| `SynthRunnerRust`   | `658a52d`   | Rust graph/source fallback with `cargo check` verification        | 81           | 6 findings on 2 dirty files   | `wrapper-candidates`, `dead --only-dead`                   | unchanged     |
| `agent_chat`        | `a86e71f`   | TypeScript with semantic provider and `npx tsc --noEmit`          | 100          | clean on 3 dirty files        | `vue-component-duplicates`, `recent-duplicates`            | unchanged     |
| `Neon_3D`           | `015b22c`   | TypeScript with semantic provider and `tsc --noEmit` verification | 87.5         | clean on 2 dirty files        | `react-large-component-pressure`, `recent-duplicates`      | unchanged     |
| `scip-python`       | `dbeda89`   | TypeScript plus Python fallback; no Python semantic provider      | 73           | clean on 1 dirty file         | `complexity-hotspots`, `doc-drift`                         | unchanged     |

## Judgments

- Global installation is good: the shell resolved `scip-query` through `/opt/homebrew/bin/scip-query`, and `npm list -g --depth=0 scip-query` points at the pushed checkout.
- Cross-language capability reporting stayed honest: Rust and Python report graph/source fallback and explicitly say no semantic provider is registered, while TypeScript repos report the semantic provider when `ts-morph` can load the project.
- Dirty-repo diff-gate behavior is usable: `Stable_Management` and `SynthRunnerRust` returned nonzero because they have actionable findings, not because the global binary crashed. Clean or already-reviewed dirty states returned zero in `Vega_2.0`, `agent_chat`, `Neon_3D`, and `scip-python`.
- Stack-specific analyzers returned parseable JSON across Vue, React, Rust, TypeScript, and Python-heavy corpora.
- `scip-python` is a useful performance stress case: reindex completed successfully but took several minutes while `scip-python-plus` indexed a large repository (`8,750` documents and `466,601` symbols). This is not a correctness failure, but it is worth keeping as a large-corpus budget benchmark.

## Notable Cross-Checks

- `Vega_2.0` stayed clean after the earlier temporary probes: pre-status and post-status were both empty.
- All six repositories had identical pre-run and post-run git status output.
- `Stable_Management` diff-gate findings were dominated by signal-tier historical/echo work: 30 `echo`, 1 `incomplete-migration`, 2 `co-change-partner`, 15 `doc-reference`, and 47 `baseline` findings.
- `SynthRunnerRust` diff-gate findings were primarily doc-reference checks against `src/app.rs`, plus one `new-dead` finding.
