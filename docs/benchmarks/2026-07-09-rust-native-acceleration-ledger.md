# Rust-Native Acceleration Ledger

Date: 2026-07-09

## Output Contract

A Rust-native acceleration is accepted only if the observable command output is
identical to the TypeScript implementation or a deliberate accuracy correction
is documented before the change is accepted.

A native batch kernel is Rust code that receives many plain-data work items in
one process call. The real referents here are `crates/scip-query-kernels`
commands that read stdin, compute a pure result, and write stdout. Its important
trait is amortization: the process boundary is paid once for enough work that
Rust can plausibly win.

## Current Baseline

Post semantic bulk-read VegaAssistant baseline from
`docs/benchmarks/2026-07-08-full-pass-optimization-ledger.md`:

| Command | Representative runtime | Output hash |
| --- | ---: | --- |
| `complexity-hotspots --json --full` | 8.2s | `f13288253854` |
| `similar --json --full` | 2.7s | `c2649571d100` |
| `health --full --json` uncached/profiled | 11.3s | `1bed3b9ffbe` |

Final health profile showed `consumer-evidence.product` at about 5.9s
accumulated across six spans:

| Span input | Duration | Definitions | Total files |
| --- | ---: | ---: | ---: |
| wrappers indexed pass | 1.1s | 99 | 389 |
| wrappers semantic pass | 0.3s | 64 | 85 |
| wrappers fallback pass | 0.5s | 64 | 96 |
| stale type pass | 1.3s | 6,483 | 8,133 |
| stale semantic pass | 1.9s | 6,022 | 5,986 |
| stale fallback pass | 0.7s | 6,006 | 6,909 |

Run history for this campaign:
`docs/benchmarks/runs/2026-07-09-rust-native-acceleration.jsonl`.

## Candidate Evaluation

### Rejected: Native Branch Counting

Reason: a text branch counter does not preserve current AST-backed output.

Temporary VegaAssistant comparison:

- definitions: 20,810
- AST-backed definitions: 20,810
- mismatches: 14,529
- mismatch rate: 69.8%

This is not a valid acceleration target unless Rust also replicates the current
Tree-sitter AST semantics.

### Candidate: Consumer Evidence Classification

Reason: the data is already normalized by TypeScript, the loop is pure once file
usage and re-export evidence are collected, and final health spends repeated
time in `consumer-evidence.product`.

Acceptance target:

- native-on and native-off outputs match for targeted fixtures;
- VegaAssistant full health hash stays `1bed3b9ffbe72061bf9bebd095da78abcde3e6b841bab0faee6617a9dd6fa81b`;
- representative `consumer-evidence.product` or nested classification span
  improves enough to offset one native process call;
- if the native process does not beat TypeScript after measurement, keep the
  Rust kernel only as a benchmarked rejected experiment or disable integration.

## Measurements

VegaAssistant measurements used built `dist/cli.js` and the release Rust helper
at `target/release/scip-query-kernels`. Health runs moved the health-report
cache out of the way before each run while keeping lower-level evidence caches
warm.

| Scenario | Mode | Runtime | Output hash | Decision signal |
| --- | --- | ---: | --- | --- |
| `health --full --json` | TypeScript/default | 9.995s | `1bed3b9ffbe72061bf9bebd095da78abcde3e6b841bab0faee6617a9dd6fa81b` | baseline after validator fix |
| `health --full --json` | Rust opt-in | 9.954s | same | wall clock within noise; not material |
| `health --full --json` | default after opt-in gate | 11.493s | same | native skipped with `nativeReason: "opt-in-required"` |
| `health --full --json` | Rust opt-in after gate | 11.055s | same | wall clock faster than pair, but span data still not enough |
| `wrapper-candidates --json --full` | TypeScript/default | 3.759s | `ef127328fce08e2bb143deb3a8a95f5109b2544b5938188fa8aa23c51a9ab79e` | direct output guard |
| `wrapper-candidates --json --full` | Rust opt-in | 3.815s | same | slower |
| `stale-abstractions --json --full` | TypeScript/default | 1.459s | `77b755e057e0f96af2624d4ded12ef4df8a30f7ccf060cfd911ae91ebcd6405b` | direct output guard |
| `stale-abstractions --json --full` | Rust opt-in | 1.496s | same | slower |

Profile-span totals for the paired post-validator health run:

| Mode | `consumer-evidence.classify` total | `consumer-evidence.product` total | Native behavior |
| --- | ---: | ---: | --- |
| TypeScript/default | 1.693s | 5.024s | native disabled |
| Rust auto-attempt | 1.821s | 5.227s | native used on the three large batches |

Final opt-in-gated profile:

| Mode | `consumer-evidence.classify` total | `consumer-evidence.product` total | Native behavior |
| --- | ---: | ---: | --- |
| TypeScript/default | 1.748s | 5.821s | `nativeReason: "opt-in-required"` |
| Rust opt-in | 1.846s | 5.565s | native used on the three large batches |

Conclusion: the Rust classifier is output-equivalent, but the one-shot
JSON/subprocess boundary does not materially beat the TypeScript path. The
largest classification batch measured 0.970s in TypeScript/default and 0.976s
with Rust opt-in after accounting for payload preparation and subprocess I/O.
The direct detector commands were slightly slower with opt-in Rust.

### Codex Rust-Heavy Corpus

Corpus: `/Users/aydansalois/Documents/GitHub/codex/codex-rs`.

Index note: `reindex --allow-partial` reused TypeScript, Rust, and Python SCIP
shards and skipped C because `scip-clang` failed. The resulting SQLite index
has 72,166 symbols across 2,473 files. `status` still reports stale because the
project fingerprint differs, so treat these as a Rust-heavy partial-index
measurement rather than a pristine clean-index run.

Output hashes stayed identical in every default/opt-in pair.

| Scenario | Mode | Runtime | Output hash | Signal |
| --- | --- | ---: | --- | --- |
| `health --full --json` | default, first pair | 28.880s | `f9049f603f8e76a3711953e8e4dbd1005aa80c0476e4f6ba2e04522c067c19f6` | includes colder lower-level evidence/cache work |
| `health --full --json` | Rust opt-in, first pair | 16.603s | same | faster, but second-run cache warmth contributes |
| `health --full --json` | Rust opt-in, reverse warm pair | 15.291s | same | warm comparison |
| `health --full --json` | default, reverse warm pair | 15.253s | same | effectively tied |
| `wrapper-candidates --json --full` | default | 8.240s | `5731a8ac9ffed81dab587faccced2668d99d76bba7ccce004e55089010c419bd` | direct detector |
| `wrapper-candidates --json --full` | Rust opt-in | 8.348s | same | slightly slower |
| `stale-abstractions --json --full` | default | 2.899s | `2d78229ab2b2e0a3497389e797ba6e33588947ccfc749933f9af27bc1d8c7bfc` | direct detector |
| `stale-abstractions --json --full` | Rust opt-in | 2.962s | same | slightly slower |

Consumer-classification profile totals:

| Health run | `consumer-evidence.classify` total | `consumer-evidence.product` total | Interpretation |
| --- | ---: | ---: | --- |
| default, first pair | 8.752s | 26.754s | cold evidence/file-usage work makes TS classification look expensive |
| Rust opt-in, first pair | 3.481s | 12.501s | Rust used on large batches; also benefits from warmed lower-level caches |
| Rust opt-in, reverse warm pair | 3.265s | 11.520s | native used, warm state |
| default, reverse warm pair | 3.070s | 11.300s | TypeScript fallback is slightly faster once evidence caches are warm |

Codex conclusion: on a Rust-heavy codebase, the Rust classifier can reduce an
apparently cold classification span, but the advantage disappears in controlled
warm comparisons because TypeScript is no longer doing expensive evidence
preparation. Full health is dominated by other phases such as
`complexity-hotspots`, `wrapper-candidates`, and semantic cache scans. This
reinforces the decision to keep `consumer-classify` opt-in and focus the next
Rust acceleration on a larger contiguous phase or a lower-overhead native
boundary.

## Decisions

- Keep the native boundary optional with TypeScript fallback.
- Reuse `crates/scip-query-kernels`.
- Do not package native binaries in this slice.
- Do not change detector thresholds or full/bounded semantics.
- Keep `consumer-classify` opt-in behind `SCIP_QUERY_NATIVE_CONSUMER_CLASSIFY=1`
  rather than enabling it automatically when a binary exists.
- Treat this as a boundary result, not a Rust result: Rust is correct here, but
  the boundary is too expensive for this kernel. The next Rust acceleration
  should either move a larger contiguous phase native-side or remove the
  helper-process cost with a persistent worker, in-process native module, or
  daemon-shaped design.
