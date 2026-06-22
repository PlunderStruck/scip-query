Make `scip-query health` run the complete health pass by default, and record the default policy for every other public command that exposes `--full`. Done means `health` no longer requires muscle-memory `--full` for authoritative aggregate counts, compatibility `--full` remains accepted, baseline ratchets stay operationally bounded, and the validation record states which other commands should remain capped by default.

## Evidence

- `scip-query plan-context handleHealth --json` shows `handleHealth()` in `src/runtime/commands/command-handlers.ts` forwards the user-supplied `full` flag into `runIsolatedHealthReport()`.
- `scip-query code 'runIsolatedHealthReport' -C 120` shows the top-level health report runs each phase through `runHealthPhaseProcess()`, which only forwards `--full` to hidden phase workers when `opts.full` is true.
- `scip-query code 'healthPhase' -C 80` shows both `health()` and `healthPhase()` call `withHealthRun(db, opts.full === true, ...)`, so omitted `full` currently means bounded health budgets.
- `scip-query code 'healthBudget' -C 80` shows the bounded budget caps candidate scans and result counts on large indexes, while full mode removes scan and result caps.
- `scip-query code 'definedLimitOption' -C 80` shows standalone list/top commands already treat explicit `--full` as unbounded and reject ambiguous `--full --limit`.
- The generated `docs/COMMAND_REFERENCE.md` public command table lists every visible command that exposes `--full`; those commands are mostly detail, top-N, candidate, or planning commands rather than aggregate scores.
- `scip-query co-change src/runtime/commands/command-handlers.ts --json` and `scip-query co-change src/queries/health/health.ts --json` report no committed co-change partners for the edited files.

## Plan

1. [x] Change health query semantics so `health(db)` and `healthPhase(db, phase)` default to full mode, while callers can still opt into bounded behavior with `full: false`.
2. [x] Change the visible CLI `health` command to pass full mode by default; keep `--full` accepted for compatibility and leave hidden phase worker behavior explicit for direct debugging.
3. [x] Update large-index health warnings so they say full mode is enabled, not that the user necessarily supplied `--full`.
4. [x] Update health tests so bounded behavior is requested explicitly, then add CLI contract coverage that the health handler forwards full mode by default.
5. [x] Update live docs/skills and regenerate `docs/COMMAND_REFERENCE.md` if descriptor help changes.
6. [x] Add a validation record evaluating default behavior for the rest of the public `--full` command surface.
7. [x] Verify with focused tests, full lint/typecheck/tests/build, post-change scip-query checks, `scip-query reindex`, and `scip-query diff-gate`.
