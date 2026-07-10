# Rust-Native Consumer Evidence Classification

Date: 2026-07-09

## Goal

Move one measured full-mode hot loop into Rust without changing command output.
The first candidate is consumer evidence classification: turning definition
consumer-file provenance plus per-file import/use facts into real,
re-export-only, and import-only consumer buckets.

A Rust-native slice here means Rust code behind a narrow TypeScript boundary:
TypeScript still owns command orchestration, SQLite access, source evidence,
semantic providers, and user-facing output; Rust receives one batch of plain
data and returns one batch of classified results.

## Current State

`docs/benchmarks/2026-07-08-full-pass-optimization-ledger.md` records the
post-bulk-read baseline: VegaAssistant `health --full --json` is about 11.3s
uncached/profiled, with `consumer-evidence.product` accumulating about 5.9s
across six spans.

`node dist/cli.js plan-context consumerEvidenceProduct` shows
`consumerEvidenceProduct()` in `src/queries/internal/consumer-evidence.ts` is
used by locality, stale-abstractions, wrapper-candidates, and not-implemented.
Those feed health through wrapper and stale-abstraction summaries.

`node dist/cli.js plan-context classifyDefinitionConsumers` shows the scoring
unit calls `leafName()`, `isReExportOnlyConsumer()`, and
`isImportOnlyConsumer()` for each consumer file. This loop is a candidate for
batching because it is pure once TypeScript has collected file usage and
re-export facts.

`node dist/cli.js plan-context computeFileLeafUsageFromAst` shows file import
usage is already cached as `consumer-file-usage`. The Rust boundary should
reuse that evidence, not reparse source.

Rejected candidate: branch estimation. A temporary VegaAssistant comparison
against current AST-backed branch counts found 14,529 mismatches across 20,810
definitions, about 69.8%. A text-only Rust branch counter would change
`complexity-hotspots` output, so it is not acceptable for this slice.

## Reuse Audit

Reuse `crates/scip-query-kernels` instead of adding a second Rust crate. The
crate already hosts native kernel experiments and has a tested CLI binary
boundary.

Reuse the existing TypeScript consumer evidence product for provenance, cached
file usage, source evidence, and fallback behavior. The Rust kernel should only
replace the pure classification loop after those inputs are prepared.

Reuse TypeScript fallback behavior if the Rust binary is unavailable, exits
non-zero, or returns invalid JSON. The public command contract must not depend
on a locally built native binary.

Do not move Tree-sitter parsing, SQLite reads, semantic provider calls, or full
detector orchestration into Rust in this slice.

## Testability Design

| Behavior | Test seam | Dependencies to inject | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Rust classification matches TypeScript classification | `classifyDefinitionConsumersNative()` against fixture inputs | native runner function | payload shaping and result conversion | child process wrapper | same partitions and file classifications as TypeScript fallback |
| Rust kernel accepts a batch and returns deterministic JSON | `cargo test -p scip-query-kernels` and native Vitest | stdin/stdout fixture | Rust classifier | CLI binary | output rows preserve input definition order and consumer-file order |
| Full commands preserve output | VegaAssistant hash reruns | built `dist/cli.js` plus optional native binary | command result hash | CLI execution | identical hashes for `health --full --json`, `wrapper-candidates --full`, and `stale-abstractions --full` where measured |

## Design Phases

### 1. Split consumer-evidence profile spans

- [x] **File**: `src/queries/internal/consumer-evidence.ts:95-236`
- **Source**: `node dist/cli.js plan-context consumerEvidenceProduct`; `node dist/cli.js plan-context classifyDefinitionConsumers`
- **What**: `consumer-evidence.product` is one coarse span that includes provenance collection and per-definition classification.
- **Change**: add nested profile spans for provenance collection and classification with cardinality: definitions, source file edges, consumer-file checks, import-only count, re-export-only count.
- **Testability**:
  - Test seam: existing consumer evidence tests and profile JSONL inspection.
  - Injected dependencies: none.
  - Pure core: no behavior change.
  - Side-effect shell: profile event write only when profiling is enabled.
  - Contract: output hash unchanged.
- **Validation**: VegaAssistant `health --full --json` profile shows the split spans with the same output hash.
- **Why**: choose Rust only if classification is materially expensive after provenance is isolated.

### 2. Add Rust batch classifier behind the existing kernel crate

- [x] **File**: `crates/scip-query-kernels/src/lib.rs` and `crates/scip-query-kernels/src/main.rs`
- **Source**: `find crates/scip-query-kernels -maxdepth 3 -type f`; `tests/native/symbol-leaf-kernel.test.ts`
- **What**: the crate currently exposes only `leaf-name`, and the benchmark ledger says that tiny helper is too small to pay for process overhead.
- **Change**: add a `consumer-classify` command that reads one JSON payload from stdin and returns classification rows. Use borrowed strings where practical, `serde` for the boundary, and no panics on malformed input.
- **Testability**:
  - Test seam: Rust unit tests for classifier fixtures plus native Vitest invoking the binary.
  - Injected dependencies: stdin JSON only.
  - Pure core: Rust `classify_consumers` over in-memory structs.
  - Side-effect shell: CLI command parses stdin and writes stdout/stderr.
  - Contract: deterministic JSON, stable order.
- **Validation**: `cargo test -p scip-query-kernels`; native Vitest fixture.
- **Why**: one process boundary amortized across thousands of definition-consumer checks is the smallest plausible Rust win.

### 3. Wire optional native classification with fallback

- [x] **File**: `src/queries/internal/consumer-evidence.ts:95-236`
- **Source**: `node dist/cli.js plan-context classifyDefinitionConsumers`
- **What**: TypeScript currently classifies one definition at a time and can always compute a correct result without Rust.
- **Change**: build a batch payload after provenance collection and file-usage/re-export facts are available; call the native classifier when `SCIP_QUERY_NATIVE_CONSUMER_CLASSIFY=1` is set and a built binary is discoverable; validate the response shape; fall back to TypeScript on any miss or failure.
- **Testability**:
  - Test seam: exported/internal native wrapper with injected runner.
  - Injected dependencies: native runner, binary path resolver.
  - Pure core: payload assembly and response validation.
  - Side-effect shell: child process invocation.
  - Contract: native and fallback produce identical `DefinitionConsumerEvidenceMap`.
- **Validation**: targeted consumer evidence tests, wrapper/stale-abstraction tests, and native-on/off fixture tests.
- **Why**: optional native keeps npm and CI behavior safe while enabling measured local speedups.

### 4. Benchmark and decide

- [x] **File**: `docs/benchmarks/2026-07-09-rust-native-acceleration-ledger.md`
- **Source**: `docs/benchmarks/2026-07-08-full-pass-optimization-ledger.md`; new run history.
- **What**: current accepted full-mode hashes are known; Rust must preserve them.
- **Change**: record before/after timings, profile spans, output hashes, and any rejected native attempts.
- **Testability**:
  - Test seam: run history records.
  - Injected dependencies: none.
  - Pure core: documented comparison.
  - Side-effect shell: benchmark commands.
  - Contract: same hashes, faster representative run, or rejected with reason.
- **Validation**: VegaAssistant `health --full --json`, `wrapper-candidates --json --full`, and `stale-abstractions --json --full` before/after.
- **Why**: the goal is a measured Rust win, not merely Rust code in the repo.

**Result**: the Rust classifier preserved output hashes but did not materially
beat the TypeScript path through a one-shot JSON subprocess. It remains as an
opt-in measured kernel. The default path stays TypeScript to avoid a small
regression on direct detector commands.

## Stress-Test Findings

Purpose: Rust should remove CPU time in a stable hot loop, not add a fragile
native dependency to command orchestration.

Blast radius: `consumerEvidenceProduct()` feeds locality, stale-abstractions,
wrapper-candidates, not-implemented, and health. Native output must match the
TypeScript map shape exactly.

Valid intermediate state: profile spans can land independently. The native
kernel can land independently with tests. The TypeScript integration must keep
fallback as the default when the binary is absent.

Failure: missing Cargo, missing binary, malformed JSON, child process timeout,
or invalid native rows must degrade to TypeScript fallback and emit profile
metadata rather than failing the command.

Concurrency: the kernel is stateless per process invocation. Existing evidence
cache writes remain TypeScript-owned.

Data integrity: no persisted cache schema changes are planned in this slice.

Human experience: no new required setup step. If the native binary is not built,
users get current behavior.

## Verification

- [x] `cargo test -p scip-query-kernels`
- [x] `npm test -- tests/native/symbol-leaf-kernel.test.ts tests/queries/cleanup/stale-abstractions-accuracy.test.ts tests/queries/cleanup/twin-drift.test.ts`
- [x] `npm run typecheck`
- [x] `npm run build`
- [x] VegaAssistant before/after output hashes and profile spans
- [x] `npm run lint`
- [x] `node dist/cli.js reindex`
- [x] `node dist/cli.js diff-gate --json`

Postchecks also ran: `recent-duplicates --json --full` and
`unused-params --json --full` returned zero findings. Full
`wrapper-candidates` and `passthrough-candidates` returned existing repository
candidates outside this Rust classifier slice; `diff-gate --json` reported no
current-diff findings.

## DEFER

- Native Tree-sitter branch counting: rejected for this slice because text
  branch counts do not match current AST-backed output.
- Cross-command native daemon: useful later, but the current question is whether
  one batch kernel can beat the TypeScript path. The measured answer for this
  classifier is no; a daemon or in-process native boundary is the next design
  question before enabling Rust by default for this class of kernel.
- Packaging native binaries for npm: required before broad release, but this
  slice can prove the local acceleration contract first.
