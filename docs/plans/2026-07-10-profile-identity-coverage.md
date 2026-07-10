# Profile Identity Coverage

Date: 2026-07-10
Status: Complete

## Goal

Give every timed subsystem an identity and collect broad repeated-run evidence
before choosing another optimization. This phase does not select or implement a
speedup.

A workload identity is a compact fingerprint of one top-level command, its
options, the running scip-query version, and the published project generation
that command reads. It identifies the same command-level input state across
processes and later runs. An exact work identity is narrower: it fingerprints
the local inputs that determine one computation, so it can prove the same work
occurred even in two different commands.

Every timed span will receive a subsystem work identity derived from its span
name and workload identity. Repeated calls bearing that identity are aggregated
inside each run before runs are compared. This is essential: 4,000 file-cache
reads are one observed subsystem workload, not 3,999 proven duplicates.

## Current State

- **Source:** `scip-query status --capabilities`; the index is fresh and both
  TypeScript and Rust semantic providers are available.
- **Source:** `scip-query plan-context src/instrumentation/profile.ts --json`
  and `scip-query refs profileSpan`; `profileSpan` is a high-risk shared
  surface with 62 external consumers. There are 82 call sites in 22 source
  files.
- **Source:** `scip-query code writeProfileEvent --json`; every profile event
  already receives command, cache state, PID, and a run identity, but there is
  no command-input identity shared by every span.
- **Source:** `scip-query code projectEvidenceFingerprint --json`; the existing
  evidence fingerprint identifies published index metadata, indexed languages,
  and completeness status. It is the reuse target for project identity.
- **Source:** `scip-query plan-context src/runtime/profile-work-audit.ts --json`;
  the audit already has a pure analyzer and renderer, so workload coverage and
  aggregation belong there rather than in a second reporting path.
- **Source:** the baseline matrix in
  `docs/benchmarks/runs/2026-07-10-profile-identity-coverage.jsonl`; 14 repeated
  commands produced 24,342 span events and exercised 79 distinct names. Only
  36 events across the three consumer-evidence names had exact identities.
- Indexing is a real uncovered subsystem: `src/reindex/index.ts` has no
  `profileSpan` calls even though `reindex()` owns fingerprinting, locking,
  whole-index reuse, language indexers, and publication.

## Reuse Audit

- Extend `src/instrumentation/profile.ts`; do not create a parallel profiling
  context or event writer.
- Reuse `projectEvidenceFingerprint()` for published project identity. When it
  is unavailable, use a run-only workload identity that cannot match later
  runs; uncertainty must reduce coverage, not create false repetition.
- Extend `auditProfileWork()` and `renderProfileWorkAudit()`; keep exact rows
  backward-compatible and add separately labeled aggregate workload rows.
- Reuse the evidence-product wrappers to add exact identities for generic file
  and project cache reads once, rather than editing every product owner.
- Add an async counterpart to `profileSpan` for reindex phases; the current
  synchronous helper records only promise creation, not asynchronous work.

## Testability Design

| Behavior | Test seam | Dependencies to inject | Pure core | Side-effect shell | Contract |
|---|---|---|---|---|---|
| Stable command/project workload identity | profiling unit test | environment and supplied project fingerprint | identity hashing | environment inheritance | same command/version/fingerprint matches; any changed part differs |
| Honest fallback without project identity | profiling unit test | absent fingerprint | run-only decision | generated run ID | different runs cannot match |
| Every span receives subsystem identity | `profileSpan` and `profileAsyncSpan` tests | clock/output file | subsystem-name and identity derivation | JSONL append | sync/async success and failure events carry the same context fields |
| Aggregate repeated workload reporting | audit unit fixture | profile event array | per-run aggregation and ranking | JSONL reader/text renderer | repeated calls aggregate within a run; only later runs become workload observations |
| Exact cache-read identity | evidence-product tests | fixture database/cache payload | cache-key identity | SQLite read/deserialization | equal kind/path/hash/project inputs match; changed inputs differ |
| Reindex phase visibility | reindex reliability tests and profiled smoke | existing fake indexers/filesystem fixtures | existing reindex decisions unchanged | lock/indexer/publication phases | profiling off preserves behavior; profiling on records real async durations |

## Implementation Phases

### 1. Add inherited workload and subsystem identities

- [x] **File:** `src/instrumentation/profile.ts`, `src/runtime/cli.ts`, and
      `tests/runtime/profile.test.ts`
- **Source:** `scip-query code writeProfileEvent --json`, `scip-query code
  profileRunId --json`, and `scip-query code projectEvidenceFingerprint --json`
- **Change:** Initialize a workload identity before command execution, inherit
  it through worker environments, and stamp every named span with a cached
  subsystem work identity. Add `profileAsyncSpan` with the same event contract.
- **Validation:** focused profile tests, multi-process health smoke, typecheck.

### 2. Report coverage and aggregate repeated workloads

- [x] **File:** `src/runtime/profile-work-audit.ts` and
      `tests/runtime/profile-work-audit.test.ts`
- **Source:** `scip-query plan-context src/runtime/profile-work-audit.ts --json`
- **Change:** Add subsystem coverage and repeated-workload rows while preserving
  the exact-work rows. Aggregate every same-span event inside a run before
  comparing runs, and label these rows as observations rather than avoidable
  time.
- **Validation:** exact/different input fixtures, repeated-event aggregation,
  legacy-profile fixture, CLI text/JSON smoke.

### 3. Add exact generic cache-read identities

- [x] **File:** `src/storage/evidence-products.ts` and
      `tests/storage/evidence-cache.test.ts`
- **Source:** `scip-query refs profileSpan` and the two wrapper spans at
  `src/storage/evidence-products.ts:199-260`.
- **Change:** Fingerprint the actual file/project evidence read key only while
  profiling is active. Keep cache hit/miss as result metadata; the timed work is
  the read/deserialization operation itself.
- **Validation:** fixture reads with equal and changed keys, output parity,
  profiling-overhead comparison.

### 4. Cover indexing phases

- [x] **File:** `src/reindex/index.ts` and
      `tests/reindex/reindex-reliability.test.ts`
- **Source:** `scip-query plan-context reindex --json` and `scip-query code
  runFreshReindex --json`.
- **Change:** Time fingerprinting, lock acquisition, whole-index reuse,
  language indexing, and publication with the shared sync/async profiler.
  Preserve the existing lock/cleanup safety envelope.
- **Validation:** whole-index reuse, shard-reuse, fresh publication, failure
  cleanup tests, and profiled warm/cold smokes.

### 5. Collect the coverage matrix

- [x] **File:**
      `docs/benchmarks/runs/2026-07-10-profile-identity-coverage.jsonl` and
      `docs/benchmarks/2026-07-10-profile-identity-coverage-ledger.md`
- **Source:** the pre-edit 14-command profile matrix.
- **Change:** Repeat the same commands, add warm/cold reindex, compare output
  bytes/hashes, and report exact-identity coverage separately from aggregate
  workload coverage. Do not choose the next optimization in this phase.
- **Validation:** every observed span name has a subsystem identity; run-only
  events cannot match across runs; the audit runtime remains a minor fraction
  of measured command time.

## Stress-Test Findings

- Nested spans overlap, so neither exact rows nor workload rows may be summed
  indiscriminately.
- A repeated aggregate workload is evidence that a stage ran again against the
  same top-level inputs. It is not proof that every internal operation was
  identical or safely cacheable.
- Published project identity is appropriate for analysis commands. Reindex
  phase rows describe work relative to the previously published generation;
  the reindex fingerprint span remains the source of truth for changed source
  inputs.
- Profiling remains opt-in. Identity hashing and maps must not add normal CLI
  cost when `SCIP_QUERY_PROFILE` is disabled.
- Health workers and Rust/TypeScript service workers must inherit rather than
  recompute the parent identity.

## Ship Order

1. Workload identity and sync/async span contract.
2. Audit aggregation and coverage report.
3. Generic exact evidence-read identities.
4. Reindex phase spans.
5. Broad measurements, verification, and documentation.

All steps are additive and reversible. No cache schema, command result, or
detector behavior changes in this phase.

## Completion Evidence

- The combined broad, direct-provider, live-service, and cold/warm indexing
  profiles contain 34,824 timed spans across 101 distinct names and 16 observed
  subsystem families. All 34,824 events and all 101 names have both workload and
  subsystem work identities.
- Five span names have exact local identities: the three consumer-evidence
  phases and generic file/project evidence reads. This is intentionally less
  than aggregate coverage; an aggregate workload is not proof of identical
  local computation.
- Long-lived Rust and TypeScript services now apply the requesting command's
  profile environment. The final 14-command matrix has exactly 14 run IDs and
  no run ID maps to more than one command.
- A live check after restarting the project watcher produced 3,788 spans under
  one run ID. The watcher process emitted 2,317 of them with the requesting
  command's identity, proving the mailbox propagation outside the unit seam.
- The matrix exercised 83 of 97 statically named spans plus 18 runtime-generated
  names. The 14 unobserved names are conditional branches within already
  observed Rust, TypeScript, semantic, and dead-code subsystems. Centralized
  stamping gives them an identity when they execute, but this corpus supplies
  no timing claim for them.
- Cold indexing rebuilt 325 files / 21,976 symbols in 4,854ms: fingerprint
  723ms, language indexers 3,176ms, publication 924ms. The immediate warm
  reindex reused the publication in 354ms: fingerprint 276ms and reuse check
  60ms.
- A controlled same-output comparison found a new transport-level observation:
  `dead --json --full` took 25,765ms through the persistent TypeScript service
  and 3,216ms through the direct provider, an 8.0x difference with the same
  1,519,771-byte SHA-256 output. The service handled 2,077 mailbox requests for
  that command. This phase records the fact and deliberately does not select a
  remedy.
- Focused verification passed 86 tests covering profiling, the audit, evidence
  reads, both persistent semantic transports, and reindex reliability. Final
  verification passed 1,248 tests across 181 files, typecheck, lint, build, and
  a fresh no-change reindex. Two diff-gate co-change signals are accepted in the
  ledger with targeted readiness/session-test evidence.
