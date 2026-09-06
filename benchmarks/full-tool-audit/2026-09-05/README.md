# Full tool audit witnesses

These files support [the audit report](../../../docs/benchmarks/2026-09-05-full-tool-audit.md). They do not change production behavior. Run commands from the repository root.

## Inspect the captured results

`artifacts/library.json` contains source snippets, slice results, executed behavior oracles, metric comparisons, and suppression storage witnesses. `artifacts/assertions.json` contains the combined desired-behavior assertions. The current capture has **19 failures out of 35 assertions**, grouped into the report's findings; the normal 2,900-test suite passed.

`artifacts/raw-results.tar.gz` holds the full CLI results, individual help output, lifecycle results, suppression trials, and verification logs. `artifact-manifest.json` gives archived file sizes and SHA-256 hashes. Data was compressed to avoid adding hundreds of loose result files to the repository's exploration inventory.

```sh
python3 benchmarks/full-tool-audit/2026-09-05/assess-results.py benchmarks/full-tool-audit/2026-09-05/artifacts
```

This returns **1** while the captured defects remain. Assessment of a frozen capture is not a rerun against changed implementation.

## Reproduce against current implementation

```sh
npm run build
./node_modules/.bin/vite-node benchmarks/full-tool-audit/2026-09-05/library-probes.ts /tmp/scip-audit-library-current.json
```

The library runner creates and removes its own fixtures. Its nonzero result represents failed desired-behavior assertions, including incorrect complete slices and suppression storage. It executes only audit-authored source snippets as runtime oracles.

For CLI probes, run `create-fixture.py` and use its printed absolute path as `<fixture>` below. The runner uses that fixture's `.cache` directory and never changes the application repository.

```sh
python3 benchmarks/full-tool-audit/2026-09-05/create-fixture.py
SCIP_QUERY_PROJECT_ROOT=<fixture> SCIP_QUERY_CACHE_DIR=<fixture>/.cache node dist/cli.js reindex --language typescript --allow-expensive-rebuild
python3 benchmarks/full-tool-audit/2026-09-05/run-cli-probes.py <fixture> /tmp/scip-audit-cli-current
python3 benchmarks/full-tool-audit/2026-09-05/lifecycle-probes.py <fixture> /tmp/scip-audit-lifecycle-current
```

The lifecycle runner writes local agent guidance, creates model fixtures, mutates source, and starts/stops the fixture's watcher. It skips global skill/parser installation and verifies that uninstall preserves user-authored guidance. The original 3-second post-edit observation intentionally captured stale semantics during the watcher cooldown; the archived follow-up waited for freshness and confirmed new compiler symbols.

For F07's source-health integration, use the exact command arrays in archived `suppression/runs.json`. Both indexed and first-use cases are retained. The flat `root-complex.ts` finding separates the missing source adjudication from the nested-filename storage defect.

For F09, `scip-query tla fetch-tools` failed against the official release asset. The actual digest and release metadata are captured in `tla-release.json`, and the failure is archived as `fetch-tla.log`. Do not replace the verifier's pin merely to make this probe pass; verify the intended distribution first.

Other verification commands used:

```sh
./node_modules/.bin/vitest run --maxWorkers=1
npm run lint
npm run typecheck
npm run audit:prod
npm pack --dry-run --ignore-scripts --json
```

The packed consumer was tested through ESM imports. CommonJS `require.resolve` does not exercise this package's import-only export conditions and is not a valid substitute. The packed consumer reused the installed `node_modules`; clean installation and other operating systems remain outside this execution record.
