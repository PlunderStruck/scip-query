# Accuracy Calibration

Date: 2026-06-05

## What Accuracy Means Here

A command is accurate when its reported claim survives comparison with source evidence. For example, `dead` is accurate only when a reported symbol has no real production references after accounting for indexer gaps, source fallback, framework entry points, generated code, and language-specific dispatch.

A false positive is a reported claim contradicted by source evidence. A false negative is a missed claim that source evidence shows should have been reported. A judgment call is a true structural smell whose fix depends on design intent rather than graph evidence alone.

## Calibration Runs

### SynthRunnerRust

`dead --min-loc 5 --skip-barrels` originally reported Rust data members as safe-to-delete dead code:

- `audio:BrowserAudioDiagnostics:last_track_index`
- `pool:EntityPoolStats:runtime_alloc_total`

Source inspection showed these are struct fields, not callable dead code. Rust field references are under-indexed, and rust-analyzer can assign broad enclosing ranges to member symbols. The default `dead` command should therefore exclude data members unless `--include-members` is explicitly requested.

Fix added:

- `dead` now keeps default results to top-level values and callable symbols, excluding enclosed data members.
- `tests/command-accuracy.test.ts` now contains a regression case proving data members are omitted by default but included when `includeMembers` is true.

Post-fix rerun on SynthRunnerRust:

```text
═══ DEAD CODE (1, 6 LOC) ═══
  Zero references anywhere — no cross-file callers AND no same-file uses.
  Safe to delete.

  src/visualizer.rs
    1228-1233  (6 LOC)  visualizer:reset_visualizer_bars()
```

Remaining calibration concern:

- The `FILE-INTERNAL ONLY` section still contains many Rust constants and members with oversized ranges. That is not the same safety claim as dead code, but it makes reports noisy and LOC estimates misleading.

### TypeScript Repositories

Initial attempts to index `meta_harness` and `responses_test` failed at the `scip-typescript` invocation before command accuracy could be measured. That is a calibration blocker rather than a command false positive.

Next step:

- Use `npm run calibrate -- <repo...>` after improving indexer error capture so TypeScript indexing failures include actionable stderr and project context.
