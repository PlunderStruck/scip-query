# Semantic Command Calibration

Date: 2026-07-08

## Goal

Calibrate scip-query's read-only command surface after adding Rust semantic
support. Done means the calibration records which commands run, which commands
fail, how long they take on representative repositories, whether full mode uses
semantic evidence, whether Rust semantic caches are warm, and which claims are
still unproven.

## Definitions

A command calibration is a measured run of a CLI command against a named
repository, with its inputs, exit code, runtime, output hash, parsed output
summary, and profile spans recorded. Its purpose is to prove command behavior
with evidence instead of relying on local memory.

A read-only command is a CLI action whose normal execution does not intentionally
modify source files, config files, hooks, skills, indexes, or suppressions. This
calibration runs read-only commands only.

A mutating command is a CLI action whose purpose is to change local project
state, such as indexing, setup, cleanup application, hook installation,
suppression writes, watch mode, or uninstall. These commands are excluded from
the first exhaustive semantic calibration and must be covered by a separate
dry-run/sandbox calibration.

A semantic profile span is a recorded timed section from scip-query's built-in
profiler. Its concrete referents here are JSONL rows such as
`rust.semantic.session.request`, `rust.semantic.import-definitions.session.request`,
`semantic.references.cache-scan`, `semantic.callees.cache-scan`, and
`evidence-product.project.read`.

A foreground-unusable command is a command that cannot be trusted in an
interactive human workflow because it reached the calibration timeout instead of
returning a result. In this run the concrete timeout was 180 seconds per command
iteration.

A warmup-sensitive command is a command whose first run is materially slower
than its second run against the same repository, because caches or language
tooling state become available after the first run. The calibration treats this
as useful only when the warm run is fast enough for the command's intended use.

## Corpus

| Repo          | Purpose                                                      | Notes                                                                                           |
| ------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| scip-query    | Small mixed TypeScript/Rust repo and the product under test. | Fresh complete index after `node dist/cli.js reindex`.                                          |
| VegaAssistant | Medium mixed TypeScript/Rust/Python app.                     | Fresh complete index from earlier calibration.                                                  |
| codex-rs      | Large Rust-heavy workspace.                                  | Indexed with `RUSTUP_TOOLCHAIN=stable`; partial index has TypeScript/Rust/Python and skipped C. |

## Run History

Machine-readable run history:

- `docs/benchmarks/runs/2026-07-08-semantic-command-calibration.jsonl`

Profile sidecars are stored outside the repo by default and their paths are
recorded in each run row.

## Harness

The repeatable harness is:

```bash
node scripts/semantic-command-calibration.mjs --iterations 2 --timeout-ms 180000
```

Useful scoped runs:

```bash
node scripts/semantic-command-calibration.mjs --list
node scripts/semantic-command-calibration.mjs --repo scip-query --iterations 1
node scripts/semantic-command-calibration.mjs --command health-json,health-full-json,diff-gate-json
```

The harness captures:

- repo and working directory;
- command id and argv;
- iteration number;
- duration, exit code, timeout, signal;
- stdout/stderr byte counts and stdout hash;
- JSON parse status and normalized result summary;
- semantic/cache profile counts and top spans.

## Command Matrix

The first matrix covers safe read-only/query commands, including status,
capability, navigation, graph, cleanup-analysis, health, benchmark, and semantic
inspection commands. It intentionally excludes:

- `reindex`
- `augment-sources`
- `augment-vue`
- `cleanup-apply`
- `install-skills`
- `setup-hooks`
- `init`
- `suppress`
- `setup`
- `setup-agent`
- `setup-ci`
- `twin-ab`
- `uninstall`
- `watch`
- `tla`

Those excluded commands need a separate sandbox/dry-run calibration because they
change project state or require a dedicated model/spec fixture.

The first full run below still included `twin-ab`. That was useful evidence:
`twin-ab` generated `tests/generated/twin-ab/semanticEvidenceProduct-vs-semanticReferences.test.ts`
on its first scip-query run and then refused to overwrite it on the second run,
so future harness runs exclude it from the read-only matrix.

## First Full Run

Run:

```bash
node scripts/semantic-command-calibration.mjs --iterations 2 --timeout-ms 180000 --out docs/benchmarks/runs/2026-07-08-semantic-command-calibration.jsonl
```

Commit: `e6b71b5c52c9`

Raw rows: one manifest plus 570 command runs. The run covered three
repositories, 95 command ids, and two iterations per command.

| Repo          | Rows | Exit 0 before timeout | Timeout rows | Timeout command ids | Non-timeout nonzero rows | JSON parse failures |
| ------------- | ---: | --------------------: | -----------: | ------------------- | -----------------------: | ------------------: |
| scip-query    |  190 |                   189 |            0 | none                |                        1 |                   4 |
| VegaAssistant |  190 |                   172 |           16 | 8 command ids       |                        2 |                   4 |
| codex-rs      |  190 |                   176 |           12 | 6 command ids       |                        2 |                   4 |

The JSON parse failures were expected for text-only outputs:
`status --capabilities` and `check-deps`. The non-timeout nonzero rows were all
from `twin-ab`, which is now excluded from the read-only matrix.

### Timeout Findings

| Repo          | Commands that timed out on both iterations                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scip-query    | none                                                                                                                                                        |
| VegaAssistant | `diff-gate-json`, `complexity-hotspots-full`, `self-audit-json`, `health-json`, `health-full-json`, `bench-json`, `twin-drift-json`, `not-implemented-json` |
| codex-rs      | `similar-full`, `recent-duplicates-full`, `complexity-hotspots-full`, `self-audit-json`, `health-json`, `health-full-json`                                  |

The timeout class is not "Rust is slow" and not "the whole CLI is slow." Most
symbol/file/navigation commands returned in sub-second or low-single-second
time. The repeated timeout class is broad detector work over many symbols:
full similarity, full recent duplicate search, full complexity, self-audit, and
health aggregation.

### Slowest Completed Commands

| Repo          | Command                       | Iteration 1 | Iteration 2 | Interpretation                                                          |
| ------------- | ----------------------------- | ----------: | ----------: | ----------------------------------------------------------------------- |
| VegaAssistant | `similar-full`                |      167.1s |       60.3s | Warmable, but still too slow for foreground use.                        |
| codex-rs      | `passthrough-candidates-full` |       74.4s |       19.6s | Warmable broad detector.                                                |
| codex-rs      | `wrapper-candidates-full`     |       66.4s |       25.5s | Warmable broad detector.                                                |
| VegaAssistant | `cleanup-plan-verify-json`    |       60.7s |        6.8s | Strong warmup win; plausible as explicit verification, not a cold hook. |
| codex-rs      | `dead-full`                   |       59.5s |       16.8s | Warmable Rust cleanup analysis.                                         |
| VegaAssistant | `complexity-hotspots-default` |       42.3s |       41.7s | Not meaningfully warmable; needs algorithm/index work.                  |
| codex-rs      | `complexity-hotspots-default` |       20.2s |       20.0s | Not meaningfully warmable; same family as Vega.                         |

### Warmup Findings

The largest useful cold-to-warm improvements were:

| Repo          | Command                    | Iteration 1 | Iteration 2 | Ratio |
| ------------- | -------------------------- | ----------: | ----------: | ----: |
| VegaAssistant | `imports-file-full`        |       10.0s |       0.22s | 45.1x |
| codex-rs      | `dead-default`             |       37.6s |       1.83s | 20.5x |
| VegaAssistant | `stale-abstractions-full`  |       23.5s |       1.70s | 13.9x |
| VegaAssistant | `dead-default`             |       13.6s |       1.42s |  9.6x |
| VegaAssistant | `cleanup-plan-verify-json` |       60.7s |        6.8s |  8.9x |
| codex-rs      | `system-module`            |        4.6s |       0.57s |  8.0x |

This supports a durable warm-state design: a setup or background daemon can make
some Rust semantic operations feel fast after initial project preparation. It
does not solve commands like `complexity-hotspots-default`, whose second run was
still effectively as slow as the first.

### Health Findings

`health` currently has 22 phases in
`src/queries/health/health.ts`: one `overview` phase plus 21 actual checks.

On scip-query, health was fast and stable:

| Command                | Iteration 1 | Iteration 2 | Score |
| ---------------------- | ----------: | ----------: | ----: |
| `health --json`        |       180ms |       166ms |    89 |
| `health --full --json` |       169ms |       183ms |    89 |

On VegaAssistant and codex-rs, both `health --json` and
`health --full --json` timed out twice. The profile spans show different
dominant causes:

- VegaAssistant health was dominated by `similar.all-count`,
  `similar.callee-index.resolve`, and semantic callee/reference cache scans.
- codex-rs health was dominated by `candidate-pipeline:wrapper-candidates`,
  `candidate-pipeline:passthrough-candidates`, `consumer-evidence.product`, and
  semantic callee/reference cache scans.

So health is not calibrated yet for large mixed/Rust-heavy repos. It needs
per-phase budgets, partial reports, and durable cached shared inputs before it
can be a reliable foreground score there.

2026-07-08 speed slice follow-up: the first implementation step restored the
visible CLI contract so default `scip-query health` uses the existing bounded
large-index budget, while `scip-query health --full` remains the explicit
exhaustive mode. The raw calibration rows above still describe the pre-fix
behavior, where the CLI forced full mode for ordinary health runs.

The same speed slice also added a default per-phase health deadline. In ordinary
health mode, a phase that exceeds the deadline is deferred with a warning and a
zero-pressure phase payload; in `--full` mode, the phase remains strict and the
error is not swallowed.

Post-fix smoke measurements with warm indexes:

| Repo          | Command                | Result | Runtime | Score | Deferred phases                     |
| ------------- | ---------------------- | ------ | ------: | ----: | ----------------------------------- |
| scip-query    | `health --json`        | ok     |    2.9s |    89 | none                                |
| scip-query    | `health --full --json` | ok     |    1.5s |    89 | none                                |
| VegaAssistant | `health --json`        | ok     |   30.3s |    60 | `twin-drift`, `complexity-hotspots` |
| codex-rs      | `health --json`        | ok     |   20.2s |    66 | none                                |

The VegaAssistant result is the key foreground-use improvement: default health
previously hit the 180 second calibration timeout and now returns at the 30
second phase deadline with explicit warnings. The deferred phases remain
accuracy debt for the next optimization slice.

### Semantic And Cache Signals

The profile counters prove semantic work is being exercised:

| Repo          | Rust session requests | Rust session ms | Project cache hits / reads | File cache hits / reads |
| ------------- | --------------------: | --------------: | -------------------------: | ----------------------: |
| scip-query    |                    21 |           25.0s |                   88 / 104 |         53,957 / 54,043 |
| VegaAssistant |                   135 |          506.8s |                    79 / 82 |       155,976 / 159,954 |
| codex-rs      |                    75 |          519.6s |                    77 / 79 |       369,814 / 379,341 |

The session-duration totals are profiler span totals, not wall-clock totals;
they can include nested or partial timeout work. They are still useful for
ranking where language-server-backed semantic work is being requested.

### Command Classification From This Run

Interactive-safe today:

- Most status, capability, graph, navigation, symbol-local, file-local,
  `diff-impact`, `incomplete-migration`, `doc-drift`, `unused-params`,
  `duplicate-bodies`, `test-quality`, and `effectiveness` commands.

Explicit/background until optimized:

- `similar --full`
- `recent-duplicates --full`
- `wrapper-candidates --full`
- `passthrough-candidates --full`
- `dead --full`
- `isolated --full`
- `cleanup-plan --verify`

Needs algorithmic work, not just warm LSP state:

- `complexity-hotspots --json`
- `complexity-hotspots --full --json`
- large-repo `health`
- large-repo `self-audit`
- large-repo full duplicate/similarity search

Needs repo-specific investigation:

- VegaAssistant `diff-gate --json`
- VegaAssistant `bench --json`
- VegaAssistant `twin-drift --json`
- VegaAssistant `not-implemented --json`

Needs sandbox calibration:

- `twin-ab`, because it writes a generated test scaffold.

## Questions This Calibration Must Answer

- Do all safe read-only commands complete on scip-query, VegaAssistant, and
  codex-rs?
- Which commands return non-zero by design because the current repo state has
  findings?
- Which commands do not support JSON cleanly despite being in the read-only
  matrix?
- Which commands use semantic evidence in default mode and which require
  `--full`?
- Do Rust semantic caches remove repeat `rust-analyzer` session/import-definition
  requests?
- Does `health` still compute a score in default and full mode?
- Do large-repo commands stay bounded in default mode and become unbounded only
  in full mode?

## Current Status

The first full command behavior/performance calibration is complete and
repeatable. Accuracy calibration is not complete: detector truth still requires
sampling findings from the code, classifying true positives and noise
archetypes, and then tuning thresholds or filing detector bugs.

Next implementation targets:

1. Add health phase timing/budget output so a timed-out health run identifies the
   exact phase instead of forcing users to infer from profile spans.
2. Add candidate indexes for broad duplicate/similarity/wrapper/passthrough and
   complexity-style scans.
3. Make semantic warm state durable across CLI invocations and restarts.
4. Split setup calibration into interactive checks, background warmup, sandboxed
   mutating-command checks, and sampled detector-accuracy review.
