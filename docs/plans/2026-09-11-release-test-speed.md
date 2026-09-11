# Reduce release test latency

## Existing path and evidence

The release coordinator (`scripts/npm-release.ts:runLocalPreflight`) executes
type checks, the production dependency audit, `npm test`, and lint. Lint owns
the production build, API contract check, and downstream compilation. The
coordinator subsequently packs both packages and verifies their identities.
Keep that single release owner and every existing validation gate.

The 0.26.0 preparation passed 3,941 tests in 429 files in 403.46 seconds on
a 14-core, 48-GiB Mac. `npm test` hardcodes two Vitest workers; unrestricted
workers previously produced load-related timeouts. Measure a four-worker
ceiling before selecting a replacement default.

Two especially expensive CLI suites (`code-cli-contract.test.ts` and
`search-cli-contract.test.ts`) invoke `vite-node` for every subprocess,
repeatedly compiling the CLI source. Together they consumed 95 seconds of
test-file execution in the recorded run. Other CLI suites already exercise
`dist/cli.js` using Node directly. Reuse that production entry point and keep
the actual subprocesses, fixtures, assertions, and error-path checks.

The indexed `context scripts/npm-release.ts` lookup did not resolve this
script. Source reads and the coordinator's command-order tests establish the
relevant path; missing graph results are not evidence of absent consumers.

## Implementation and checks

1. Benchmark the unchanged suite with four workers, without rebuilding or
   editing test inputs during that run. Retain durations and failures.
2. Retain the two-worker default. The four-worker experiment failed and saved
   only 10%; increasing concurrency is not the accepted implementation.
3. Invoke the compiled CLI in the two slow source-loader suites. Move the
   existing lint/build preflight before tests so a clean release checkout
   always tests the freshly built artifact. Update the existing command-order
   regression and add a failed-build check that prevents tests and publication.
4. Reduce disposable SQLite journal churn in the generated read-proof tests,
   keeping the separate writer/reader and every committed edit checkpoint.
   Enable Node's compilation cache only for test children through the shared
   command runner's environment option. Use the release's existing temporary
   directory owner for cleanup, preserve explicit cache controls, and disable
   caching when V8 coverage is requested. Run the changed CLI, coordinator,
   and read-proof cases, then the complete suite. Keep all test cases,
   assertions, timeouts, process isolation, and release failure behavior.
5. Record before/after timings, run required quality checks, and commit the
   change. Update the prepared release checkout only after verifying that no
   npm release process is active there; retain its earlier verification record.

No skipped-suite, cached-pass, retry-until-green, or publication bypass is part
of this change. Test scheduling is the allocation of independent test files
to worker processes; it changes when checks run, not what establishes a pass.

## Results

- Unchanged four-worker trial: 364.95 seconds, 3,940 passed / 1 failed. Seed
  20260918 in `database-read-proof.test.ts` exceeded 5 seconds; no assertion
  mismatch was reported. The user also reported that seed timing out. Do not
  treat this experiment as a passing release run.
- The unchanged read-proof suite passed alone in 4.38 seconds of test execution;
  the failing seed took 416 ms. Switching the disposable writer from per-commit
  rollback journal creation/deletion to SQLite WAL reduced the suite to 1.63
  seconds. It still checks 10 seeds, 100 histories per seed, and 20 committed
  edits per history through the separate real reader.
- Node's compiled-code cache reduced repeated built-CLI help startup from
  roughly 270 ms to 130 ms after its first load in a small local experiment.
  This caches compiled modules, not outcomes. Its implementation and coverage
  limitation are documented in the [Node module API](https://nodejs.org/api/module.html#module-compile-cache).
- Changed CLI, read-proof, and release-coordinator tests: 101 passed across
  four files in 9.89 seconds, without the release compilation cache. Eight
  added coordinator cases cover failure ordering, cache ownership/cleanup,
  explicit cache/coverage controls, and environment propagation to a real child.
- Source review reports no findings or blocking findings. The final clean
  release run will retain complete timing and validation evidence in
  `.scipquery/releases/0.26.0-fast-preparation/`; earlier preparation records
  remain separate and unchanged.
