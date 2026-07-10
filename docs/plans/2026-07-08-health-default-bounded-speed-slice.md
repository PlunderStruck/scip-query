# Health Default Bounded Speed Slice

Date: 2026-07-08

## Goal

Make `scip-query health` usable again on large repositories by restoring the
bounded default health path, while keeping `scip-query health --full` as the
explicit exhaustive mode. Done means the CLI no longer forces `full: true` for
ordinary health runs, large-index default health emits the existing budget
warning, timed-out default phases are explicitly deferred, and the old
exhaustive behavior remains available with `--full`.

## Current State

`handleHealth()` currently calls `runIsolatedHealthReport({ full: true })` for
every visible health command, regardless of whether the user supplied `--full`.
Source: `node dist/cli.js code handleHealth -C 8`.

`healthBudget()` already has the desired split: large-index bounded mode uses a
candidate scan cap, result caps, bounded git history, and semantic enrichment
off; full mode removes those caps and emits an unbounded warning. Source:
`node dist/cli.js code healthBudget -C 10`.

`runIsolatedHealthReport()` is consumed by the visible health command and setup
health. Source: `node dist/cli.js refs runIsolatedHealthReport --json`.

The 2026-07-08 command calibration showed `health --json` and
`health --full --json` timed out twice on VegaAssistant and codex-rs because the
visible default was the full path. Source:
`docs/benchmarks/2026-07-08-semantic-command-calibration.md`.

After restoring bounded default health, codex-rs returned in about 21 seconds,
but VegaAssistant still hit the 180 second cap. Individual hidden health phase
measurements showed VegaAssistant default `twin-drift` timed out at 70 seconds
and `complexity-hotspots` took about 42 seconds, while most other bounded phases
returned quickly.

## Reuse Audit

No new health-budget mechanism is needed. The existing `healthBudget()` bounded
path is the intended reuse target.

No new scheduler is needed for this slice. `runIsolatedHealthReport()` already
runs phases through the isolated analysis scheduler.

No new CLI option is needed. The existing `--full` option is the right explicit
exhaustive switch.

## Testability Design

| Behavior                                                           | Test seam                                                             | Dependencies to inject          | Pure core                                        | Side-effect shell      | Contract                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------ | ---------------------- | -------------------------------------------------------------------------- |
| Visible health forwards user `--full` instead of forcing full mode | command-handler source contract test and health CLI smoke             | CLI option map                  | `booleanOptionValue(opts, 'full')` decision      | `handleHealth()`       | default `health` passes `full: false`; `health --full` passes `full: true` |
| Bounded default health remains honest on large indexes             | existing `healthBudget()` tests and Vega smoke                        | fake large DB / real Vega index | existing `healthBudget()`                        | isolated phase workers | warning discloses cap and `--full` escape hatch                            |
| Slow default health phases do not block the whole report           | `healthPhaseTimeoutMs()` and `deferredHealthPhaseResult()` unit tests | env timeout value               | timeout selection and deferred payload synthesis | child process runner   | default mode defers timed-out phases; `--full` remains strict              |

## Design Phases

### 1. Restore the visible health option contract

- [x] **File**: `src/runtime/commands/command-handlers.ts:249`
- **Source**: `node dist/cli.js code handleHealth -C 8`
- **What**: `handleHealth()` hardcodes `full: true`.
- **Change**: Pass `full: booleanOptionValue(opts, 'full')`.
- **Testability**: Update the CLI contract test that currently expects
  `full: true`.
- **Validation**: `npm test -- tests/runtime/cli-contract.test.ts`.
- **Why**: This unlocks the existing bounded health budget without changing the
  query layer.

### 2. Update the command descriptor wording

- [x] **File**: `src/runtime/commands/command-descriptors.ts:98`
- **Source**: `sed -n '88,108p' src/runtime/commands/command-descriptors.ts`
- **What**: `--full` is documented as a compatibility no-op.
- **Change**: Describe `--full` as the explicit unbounded/exhaustive health
  mode.
- **Testability**: Descriptor text is covered by format/typecheck and command
  reference generation consumers.
- **Validation**: `npm run typecheck`.
- **Why**: The user-facing contract must match the restored runtime behavior.

### 3. Record the policy pivot

- [x] **File**: `docs/benchmarks/2026-07-08-semantic-command-calibration.md`
- **Source**: `docs/benchmarks/2026-07-08-semantic-command-calibration.md`
- **What**: The calibration currently says large-repo health timed out.
- **Change**: Add a follow-up note that the first speed slice restores bounded
  default health and leaves full health exhaustive.
- **Testability**: Documentation-only.
- **Validation**: `npx prettier --check docs/benchmarks/2026-07-08-semantic-command-calibration.md`.
- **Why**: Keeps the calibration ledger tied to the code decision it caused.

### 4. Add default phase timeout and deferred results

- [x] **File**: `src/runtime/isolated-analysis-runner.ts`
- **Source**: `sed -n '1,120p' src/runtime/isolated-analysis-runner.ts`
- **What**: Child JSON workers have no timeout option.
- **Change**: Add `timeoutMs` support and a typed timeout error.
- **Testability**: Timeout policy is exercised through `cli-support` unit tests.
- **Validation**: `npm test -- tests/runtime/cli-support.test.ts`.
- **Why**: A single slow default phase should not make ordinary health unusable.

### 5. Defer timed-out default health phases

- [x] **File**: `src/runtime/cli-support.ts`
- **Source**: `node dist/cli.js plan-context runIsolatedHealthReport --json`
- **What**: `runIsolatedHealthReport()` fails the whole report when any child
  task fails or hangs.
- **Change**: Give non-full health phases a default 30 second timeout; on timeout
  synthesize a zero-pressure phase result and add a warning. Keep `--full`
  strict.
- **Testability**: Unit-test timeout resolution and deferred payload shape.
- **Validation**: VegaAssistant `health --json` returns instead of timing out.
- **Why**: This preserves full-mode accuracy while making ordinary health useful.

## Stress-Test Findings

Purpose: preserve the complete health run for users who ask for `--full`.

Blast radius: visible health command, setup health only if it passes `full`
explicitly, and documentation. `project-setup.ts` already passes `{ full: true,
json: true }`, so setup keeps the existing exhaustive behavior.

Valid intermediate state: phase 1 alone compiles and restores the runtime
contract; phase 2 updates help text.

Failure: bounded default health can miss uncapped candidate counts or deferred
slow phases, but it emits warnings and points users at `--full`.

Human experience: ordinary `health` should return instead of timing out; users
can still choose the expensive exhaustive path.

## Post-Implementation Measurements

Measured after the bounded/default contract fix and default phase timeout were
built into `dist/cli.js`.

| Repo          | Command                | Result | Runtime | Score | Deferred phases                     |
| ------------- | ---------------------- | ------ | ------: | ----: | ----------------------------------- |
| scip-query    | `health --json`        | ok     |    2.9s |    89 | none                                |
| scip-query    | `health --full --json` | ok     |    1.5s |    89 | none                                |
| VegaAssistant | `health --json`        | ok     |   30.3s |    60 | `twin-drift`, `complexity-hotspots` |
| codex-rs      | `health --json`        | ok     |   20.2s |    66 | none                                |

VegaAssistant is the important regression guard for this slice: the same command
previously timed out at 180 seconds in the calibration harness. It now returns a
partial but explicit report at the default 30 second phase deadline.

This is not the final performance destination. It makes default health usable
while preserving exhaustive `--full`; the next speed slices should remove the
need to defer `twin-drift` and `complexity-hotspots`.

## Verification

- `npm test -- tests/runtime/cli-contract.test.ts tests/runtime/cli-support.test.ts`
- `npm run typecheck`
- `npm run lint`
- `node dist/cli.js health --json`
- VegaAssistant smoke: `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js health --json`
- codex-rs smoke with `RUSTUP_TOOLCHAIN=stable`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`
