# Profile Identity Coverage Ledger

Date: 2026-07-10
Status: Data collection complete; optimization selection deferred

## Output Contract

Profiling must not change command JSON, findings, indexing artifacts, cache
validity, or normal unprofiled runtime. Work-audit must distinguish exact local
repetition from aggregate subsystem workloads and label uncertainty directly.

## Run History

`docs/benchmarks/runs/2026-07-10-profile-identity-coverage.jsonl`

## Completed Pipeline

1. `profileSpan` records synchronous duration and arbitrary metadata.
2. `writeProfileEvent` adds timestamp, PID, run, command, and cache state.
3. Child processes and persistent Rust/TypeScript services inherit the current
   run and workload identities.
4. Every named event receives a subsystem prefix and subsystem work identity.
5. Consumer evidence and generic evidence-product reads supply exact
   `workIdentity` values.
6. `work-audit` reports exact repetition and aggregate workload observations in
   separate lanes.

## Identity Model

- **Run identity:** one top-level invocation and its child processes.
- **Workload identity:** command/options, scip-query version, and published
  project generation; run-only when project identity is unavailable.
- **Subsystem work identity:** one named span aggregated within one workload.
- **Exact work identity:** the local inputs that determine one computation.

The first three describe execution context at increasing precision. Only the
last one proves local computations are identical across different commands.

## Baseline Findings

- 24,342 span events; 79 distinct names; 13 observed prefixes.
- Exact coverage: 36 events and three names, all consumer evidence.
- The existing exact audit found the same three consumer inputs across health
  and wrapper commands, proving cross-command identity is useful.
- Evidence-product file reads account for 19,566 events but only 240ms. Their
  repetition count is high while their measured cost is currently low.
- TypeScript accounts for 4,487 events and 6,421ms; workload aggregation is
  needed before deciding whether that is repeated initialization, repeated
  per-file work, or necessary distinct work.
- Indexing lacks internal profile spans.

## Measurements

See the run history. All successful command pairs emitted identical bytes and
hashes within each pair. `diff-gate` returned one in the post-change matrix
because it correctly inspected the intentionally dirty instrumentation
worktree; both runs emitted the same result.

### Identity coverage

| Measure | Baseline | Completed data set |
| --- | ---: | ---: |
| Timed spans | 24,342 | 34,824 |
| Distinct observed span names | 79 | 101 |
| Observed subsystem families | 13 | 16 |
| Workload-identified events | 0 | 34,824 (100%) |
| Workload-identified names | 0 | 101 (100%) |
| Exact-identified events | 36 | 28,000 |
| Exact-identified names | 3 | 5 |

The combined set comprises the corrected 14-command persistent-service matrix,
two direct TypeScript-provider runs, a cold/warm indexing run, and a live
service propagation smoke after restarting the project watcher. It exercised
83 of 97 static span names and 18 runtime-generated names. Fourteen conditional
span names did not execute, so no timing claim is made for those branches; the
central event writer still assigns their identity when they do execute.

### Exact repeated work

| Exact span | Repeated groups | Computations | Estimated repeated time |
| --- | ---: | ---: | ---: |
| `consumer-evidence.product` | 3 | 9 | 1,215ms |
| `consumer-evidence.provenance` | 3 | 9 | 628ms |
| `consumer-evidence.classify` | 3 | 9 | 584ms |
| `evidence-product.file.read` | 3,086 | 23,595 | 277ms |
| `evidence-product.project.read` | 1 | 21 | 6ms |

Product/classify/provenance durations are nested and must not be summed. The
large file-read count is real exact repetition, but the entire measured cost is
small; it is not a major optimization target from this data.

### Aggregate repeated workloads

The corrected persistent-service matrix's largest later-run aggregate
observations were `dead.caller-map-supplement` and its nested
`dead.caller-map.per-symbol` at 24,845ms, `diff-gate.check.echo` at 1,466ms,
`candidate-pipeline:complexity-hotspots` at 1,310ms, and
`candidate-pipeline:wrapper-candidates` at 992ms. These identify stages that ran
again against the same command/project workload; they do not claim every local
operation was identical or avoidable.

### Persistent TypeScript service control

| Path | Runtime | Output bytes | SHA-256 | Service requests |
| --- | ---: | ---: | --- | ---: |
| Persistent service | 25,765ms | 1,519,771 | `5a9fffec169d…` | 2,077 |
| Direct provider | 3,216ms | 1,519,771 | `5a9fffec169d…` | 0 |

The persistent service reused its TypeScript projects, but the command issued
2,077 synchronous mailbox requests. At a 5ms requester polling interval, the
transport itself has a repeated round-trip floor before filesystem scheduling
and JSON work. This is a controlled 8.0x same-output difference and the most
important new observation, but the next optimization is intentionally not
chosen in this phase.

After rebuilding and restarting the project watcher, a separate profiled run
confirmed the transport boundary itself. One command run produced 3,788 spans;
2,317 were emitted by the watcher PID with the command's one run/workload
identity. The fresh service created one TypeScript session, reused it 2,076
times, and emitted 2,076 `typescript.references-map.file` spans totaling
3,927ms inside a 29,505ms caller-map stage. The remaining gap is consistent
with repeated mailbox transport and scheduling rather than project analysis.

### Indexing phases

| Run | Total | Fingerprint | Reuse check | Language indexers | Publish | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Cold | 4,854ms | 723ms | 0ms | 3,176ms | 924ms | rebuilt |
| Immediate warm | 354ms | 276ms | 60ms | — | — | reused |

Both runs published/read 325 files and 21,976 symbols. The metadata callback
was rerun after fixing assignment order; `reindex.reuse-check` now reports
`false` for cold and `true` for warm, matching the command result.

### Observer cost

`work-audit` over the 24,188-event corrected broad profile measured
234/217/210/217/215ms: 217ms median and 234ms p95. Paired warm profiling checks
measured approximately 5.5% overhead for `similar`, 5.9% for
`wrapper-candidates`, and 3.2% for direct-provider `dead`, with byte-identical
outputs.

## Decisions

- Accepted: two-tier aggregate/exact identity model.
- Accepted: project-fingerprint uncertainty falls back to run-only identity.
- Rejected: automatically assigning one exact identity to every same-name span;
  this would falsely classify thousands of distinct file operations as repeats.
- Deferred: optimization selection until the post-change matrix is recorded.
- Accepted: centralized workload/subsystem identities for every named event,
  with exact identities kept deliberately narrower.
- Accepted: compatible profile-environment propagation through both persistent
  semantic transports.
- Recorded, not yet planned: replace or batch the 2,077 per-symbol TypeScript
  mailbox round trips in `dead --full` only after a separate attack plan is
  approved.
- Deferred: exact identities for semantic and detector-local computations until
  their true determining inputs can be named without conflating distinct work.

## Verification

- `npm test`: 1,248 tests passed across 181 files.
- `npm run typecheck`, `npm run lint`, and `npm run build`: passed.
- Focused profiling/audit/evidence/transport/reindex verification: 86 tests
  passed; the final Rust consolidation check added 77 passing durable-session,
  session, and readiness tests.
- `scip-query self-audit --json`: 50/50 sampled reference answers matched the
  semantic oracle; callee recall was 1 on the two complete comparable samples.
- `scip-query recent-duplicates --json --full`: no findings.
- `scip-query unused-params --json --full`: no findings.
- `scip-query co-change` for the profiler and TypeScript semantic protocol: no
  historical partners.
- Final `scip-query reindex`: fresh generation reused in 0.5s.
- The health baseline remains intentionally stale and repository-wide: 167
  deltas versus its old snapshot. It predates this indexing campaign and was not
  rewritten by this instrumentation slice.

`diff-gate` reported two blocking co-change signals after the gate correctly
found and prompted consolidation of Rust's private duplicate async profiler.
Both are accepted rather than suppressed:

1. `src/semantic/rust/lsp-session-readiness.ts` historically changes with the
   worker, but this edit only deletes the worker's byte-equivalent private
   timing helper and imports the shared one. It does not change readiness state,
   deadlines, or protocol behavior.
2. `tests/semantic/rust/rust-lsp-session-readiness.test.ts` is unchanged because
   no readiness contract changed; all 34 readiness tests and 43 Rust
   session/durable-session tests pass after the consolidation.

The remaining two gate findings are advisory and accepted: the TypeScript
semantic requester carries a per-command profile environment because its
long-lived service emits semantic spans, unlike the differently purposed index
and Rust LSP requesters; the evidence-cache architecture note's cited reindex
cache-key statement remains correct because this change adds timing spans but
does not change any shard key.
