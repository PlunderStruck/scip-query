# Durable Rust Default and Rollout Closure

Date: 2026-07-10
Status: Complete
Parent: [`2026-07-09-automatic-incremental-indexing-roadmap.md`](./2026-07-09-automatic-incremental-indexing-roadmap.md)

## Outcome

Make the already-calibrated durable rust-analyzer transport the default while
retaining the per-command worker as both an explicit opt-out and an automatic
failover. Decline narrower Rust cache keys and new native ports that do not
meet their correctness or measured-boundary gates.

A **durable Rust session** is a demand-started local compiler-service process
for one canonical repository whose distinguishing behavior is that it keeps
rust-analyzer's ready project state after the requesting CLI process exits. A
**per-command worker** is the bounded fallback process whose defining behavior
is that it owns compiler state for only one CLI lifetime. The durable route
does not replace the worker: helper startup, readiness, timeout, protocol,
version, or request failure permanently latches that command to the worker and
replays the exact request once.

The default helper sleeps in the ordinary operating-system sense: no helper
exists until a semantic request needs one, a live helper exits after ten clean
idle minutes by default, and the next request recreates it from the current
project identity. `status` reports `durable/stopped`, `durable/live`, or
`durable/stale`, including live PID and heartbeat in JSON. Set
`SCIP_RUST_SEMANTIC_DURABLE_SESSION=0` to select the per-command worker. An
unrecognized value fails safely to the worker and is reported invalid.

## Acceptance Evidence

The default switch changes only transport selection. The underlying durable
route had already passed source/Cargo/compiler/build/environment invalidation,
readiness-v2 ordering, bounded completion retry, crash/stale-heartbeat recovery,
atomic mailbox, concurrent-owner lock, response-cache, opt-out, and exact
multi-corpus payload tests.

Fresh evidence controls after the switch:

| Corpus | Route | Cold | Warm | Output |
| --- | --- | ---: | ---: | --- |
| scip-query | per-command worker | 7.436s | — | `d8706ecc…` |
| scip-query | durable default | 6.068s | 3.724s | `d8706ecc…` |
| SynthRunnerRust | per-command worker | 21.227s | — | `3d9caaf2…` |
| SynthRunnerRust | durable default | 18.414s | 1.226s | `47291cda…` |
| SynthRunnerRust | packed 0.15.0 durable default | 18.688s | — | `47291cda…` |

Local cold improved 18.4%; SynthRunnerRust cold improved 13.3%. The default
therefore passes the no-more-than-5% cold-regression gate as well as the warm
gate. The Synth output change is an accepted accuracy correction, not a speed
exception: the worker reproduced the historically incomplete fresh-session
callee payload, while durable readiness and completion retry produced the
already accepted 3,117 reference facts and 2,564 callee facts with zero
incomplete Rust references. The packed install started its own packaged helper,
reported it live, and reproduced the accepted hash.

Readiness-v2 and complete-response calibration already proved the same durable
payloads on VegaAssistant: 83.860s to 41.933s forward warm and 80.970s to
46.310s reverse warm, with exact reference/callee digests and no worker
fallback. Because the default switch invokes that identical route, another
multi-minute compiler experiment would repeat rather than strengthen the
transport evidence.

## Deliberate Non-Changes

Rust semantic reference rows remain keyed by the complete Rust project
fingerprint. A complete reference answer is the set of every source location
that names one definition; its essential dependency is project-wide because
any Rust file can add a new import or call even when no prior dependency edge
connects it. The Phase 2 graph therefore cannot prove a narrower key complete.
Changing this key was rejected rather than risking silent missing references.

No new native kernel ships. AD-7 requires a CPU-bound slice to occupy at least
10% of command wall time and then improve the command by at least 5% or its
span by at least 20% with exact output. The prior `consumer-classify` helper
did not improve warm end-to-end time, and the remaining large spans combine
SQLite evidence validation, decoding, fallback row loading, and source-range
correction rather than one qualified pure kernel. Rewriting the CLI or these
mixed boundaries in Rust would add packaging/ABI surface without accepted
performance evidence.

## Verification and Rollback

- Focused transport, durable lifecycle, and status suites: 73 passed.
- Final repository verification: 177 test files / 1,218 tests, typecheck,
  lint, build, package dry-run, packed-install smoke, reindex, and diff-gate
  all passed. The final diff gate reported zero findings and zero advisories.
- Status exposes selected transport, live state, fallback, validity, and the
  exact opt-out.
- `SCIP_RUST_SEMANTIC_DURABLE_SESSION=0` restores the previous worker default
  without changing cache schemas or command APIs.
- Every durable request retains automatic worker failover; a whole reindex
  remains the graph/storage repair oracle.

## Roadmap Result

The campaign's automatic freshness service, affected-set proofs, persistent
TypeScript semantics, incremental SCIP documents, atomic SQLite generations,
large-shard overlays, and durable Rust default are all accepted. Further Rust
ports or narrower semantic identities require a new measured plan rather than
continuing this completed roadmap by inertia.
