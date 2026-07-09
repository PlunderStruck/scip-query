# Durable Rust Session Identity and Readiness Design

Date: 2026-07-09

Status: Approved and implemented through version 2; post-open barrier corrected
after the 2026-07-09 built-runtime smoke

## Goal

Make the opt-in durable Rust semantic transport preserve one compatible
rust-analyzer compiler state across CLI processes without returning different
semantic evidence from a fresh session and a reused session.

Completion requires three outcomes:

1. Per-request execution policy no longer invalidates compatible compiler
   state.
2. A fresh durable session waits for observed rust-analyzer readiness instead
   of sleeping for an assumed interval.
3. SynthRunnerRust and VegaAssistant pass the recorded cold, warm,
   invalidation, and reverse-order controls with identical semantic payloads
   and a meaningful warm-session speedup.

The per-command worker remains the default until all three outcomes are
verified.

## Definitions

A compiler session is one running rust-analyzer process plus the project graph,
source state, toolchain state, and analysis caches it has loaded. What
distinguishes it from a request is that many different reference, callee,
signature, and import-definition operations can use the same loaded compiler
state.

Compiler-session identity is the collection of inputs whose change can make
that loaded state represent a different program: canonical project root,
Rust/Cargo content, rust-analyzer binary and version, semantic worker build,
and environment consumed when rust-analyzer starts.

Request policy is the collection of controls that changes how one semantic
operation runs without changing the program rust-analyzer has loaded. It
includes request and diagnostics timeouts, concurrency, reference retry
timeout, profiling thresholds, requested semantic products, and SCIP
occurrence routing.

Readiness is an observed rust-analyzer state in which the server reports that
its background compiler work is quiescent. Quiescent means the server reports
no pending background analysis; this is stronger than receiving diagnostics
for one file and is fundamentally different from waiting an assumed number of
milliseconds.

Fail-closed fallback is a transport decision that refuses to trust an
unverified durable session and replays the operation through the existing
per-command worker. The existing one-shot semantic resolver remains the final
fallback if the per-command worker also fails.

## Evidence Behind the Design

`scip-query code createDurableRustSessionIdentity` shows that the current key
includes request timeout, diagnostics timeout, settle delay, concurrency, and
reference retry timeout. `scip-query code DurableRustSessionHost` shows that
any key difference shuts down and recreates the worker. This explains the
intra-command invalidations recorded on VegaAssistant.

`scip-query code openNewDefinitionDocuments` shows that readiness currently
means waiting for one diagnostics notification per opened document and then
sleeping for `settleDelayMs`. `scip-query code waitForDiagnostics` shows that a
diagnostics notification only marks one URI as diagnosed. This explains why a
fixed first-session wait can finish before call-hierarchy evidence stabilizes
on SynthRunnerRust.

rust-analyzer exposes an opt-in `experimental/serverStatus` notification with
`health`, `quiescent`, and `message` fields. Its protocol definition is in
[`crates/rust-analyzer/src/lsp/ext.rs`](https://github.com/rust-lang/rust-analyzer/blob/master/crates/rust-analyzer/src/lsp/ext.rs).

## Considered Approaches

### 1. Server-status quiescence with identity partitioning — selected

Advertise rust-analyzer's server-status capability, track status generations,
and wait for a healthy quiescent notification after initialization and after
new documents are opened. Keep only compiler-state inputs in the durable
identity. Apply request policy explicitly to each operation.

This approach uses the server's own statement about background compiler work,
preserves one process across compatible request shapes, and fails closed when
the signal cannot prove readiness.

### 2. LSP progress-token tracking — rejected

Track `$/progress` tokens such as loading, roots scanned, and indexing, then
continue when all observed tokens end.

This is observable, but token names and phase ordering are rust-analyzer
implementation details. Phases can restart, and an unobserved token cannot be
distinguished from an unsupported signal. The resulting barrier would be more
version-sensitive than server status.

### 3. Semantic fixed-point probing — rejected

Repeat selected reference or callee queries until two payload hashes match.

This does not prove that unprobed definitions are stable, adds substantial
work to every fresh session, and can accept the same incomplete answer twice.
It is useful as a benchmark oracle, not as production readiness.

## Architecture

### Compiler identity

`DurableRustSessionIdentity` will retain:

- protocol version;
- canonical project root;
- fingerprint of Rust sources and common Cargo inputs;
- resolved rust-analyzer path and version;
- semantic worker build fingerprint; and
- startup environment: `HOME`, `PATH`, `CARGO_*`, `RA_*`, and `RUST*`.

The identity will not contain:

- request timeout;
- diagnostics timeout;
- settle delay;
- concurrency;
- reference retry timeout;
- profiling environment;
- requested product flags; or
- SCIP occurrence routing.

SCIP occurrence routing remains part of semantic evidence/cache identity where
it already protects output invalidation. Removing it from compiler-session
identity only means that changing routing does not restart a compatible
rust-analyzer process.

The full worker environment is still applied before each request. If a startup
environment value changes, the compiler key changes and the host recreates the
worker before applying the request. If only request policy changes, the host
reuses the worker and applies the new policy to that operation.

### Per-request policy

Every LSP operation will receive its timeout explicitly. Reference queries,
definition queries, call-hierarchy preparation, outgoing-call queries, and
hover queries must not inherit the timeout of whichever request happened to
create the session.

Concurrency and retry settings already belong to the worker request and remain
there. Diagnostics and readiness timeouts are operation bounds, not compiler
identity. Deadline-readiness sessions disable native editor diagnostics because
scip-query never consumes them; otherwise they can occupy rust-analyzer's worker
pool ahead of the ordered status request. The per-command worker retains its
accepted diagnostics-plus-settle behavior. The ordered request remains bounded
by both its ordinary request timeout and the absolute readiness deadline.
Profiling keys remain transient worker environment.

### Readiness protocol

The client will advertise:

```json
{
  "experimental": {
    "serverStatusNotification": true
  }
}
```

`RustAnalyzerLspClient` will validate and record each
`experimental/serverStatus` notification with a monotonically increasing
generation and retain the latest validated status. An initialization waiter
receives a minimum generation and a deadline. It resolves only after a newer
status reports `quiescent: true` without `health: "error"`.

The built-runtime smoke established a narrower post-open contract. The
installed rust-analyzer 1.92.0 emitted a healthy quiescent status after
initialization but did not emit another status after `didOpen`. This matches
rust-analyzer's implementation: the main loop compares `current_status()` with
`last_reported_status` and sends `experimental/serverStatus` only when the
structured status changes. The extension is a state-change notification, not
a per-operation acknowledgement.

The VegaAssistant smoke established a second health distinction. Its
13-project workspace reports `health: "warning"` because some package build
scripts fail, then reports `quiescent: true`. A warning status is a completed
compiler state with a declared limitation; unlike `health: "error"`, it does
not mean the server is nonfunctional. The existing per-command path already
produces its baseline evidence under that warning. Durable readiness therefore
waits through non-quiescent warnings and accepts a quiescent warning while
recording the health level in the profile. Exact five-control payload parity
remains the gate that determines whether reusing that state changes semantic
evidence.

Post-open readiness therefore combines status observation with an ordered,
read-only round trip. A status-stability round trip is a
`rust-analyzer/analyzerStatus` request sent after `didOpen` and diagnostics;
what distinguishes it from a delay is that its response proves the server
processed the earlier notifications on the same LSP connection. If no status
generation changed during that ordered work, the previously observed healthy
quiescent status remains authoritative. If the generation did change, the
client must observe a newer healthy quiescent status before continuing.

Fresh-session flow:

1. Record the current status generation.
2. Send `initialize` and `initialized`.
3. Wait for a newer healthy quiescent status.
4. Record another status generation.
5. Open the requested project documents.
6. Skip the diagnostics wait because native diagnostics are disabled for this
   deadline-readiness session.
7. Send a deadline-bounded `rust-analyzer/analyzerStatus` request after the
   document-open notifications.
8. If the status generation advanced, require a status newer than the
   pre-open checkpoint that is quiescent and not error health. If it did not
   advance, require the retained status at the checkpoint to remain quiescent
   and not error health.
9. Run semantic operations.

Reused-session flow:

- If the request opens no new documents, run immediately.
- If it opens new documents, repeat the post-open diagnostics and ordered
  status-stability barrier.

The implicit durable-session settle delay is removed. When the user explicitly
configures a settle delay, durable mode honors it after observed quiescence as
an additional experiment; the delay never substitutes for the readiness
barrier and never enters compiler-session identity. The per-command path keeps
its existing settle behavior.

### Failure handling

The readiness barrier rejects when:

- no valid server-status notification arrives before the bounded deadline;
- no healthy quiescent status exists before the post-open checkpoint;
- the ordered analyzer-status request fails or crosses the deadline;
- the status reports error health;
- the process exits;
- the response is malformed; or
- a changed status does not return to healthy quiescence before the deadline.

The durable requester already attempts helper liveness recovery. If it still
throws, a failover requester replays the same operation through one
per-command worker and latches to that worker for the rest of the current CLI
process. A later CLI process may try durable mode again. If the per-command
worker fails, the resolver's existing one-shot fallback handles the operation.

The replay remains bounded. The durable readiness budget leaves response
margin inside the caller's existing batch deadline; fallback does not create
an unbounded retry loop.

Profile events distinguish `created`, `reused`, `invalidated`, and
`worker-fallback`, including the readiness failure reason without embedding
source contents or full environment values. Readiness spans also record
`health: "ok"` or `health: "warning"` so a warning-backed calibration remains
visible.

## Test Design

All behavior changes use red-green TDD.

### Identity tests

- Changing timeout, diagnostics, settle, concurrency, retry, profiling, product
  flags, or SCIP routing preserves the compiler-session key.
- Changing project source/Cargo fingerprint, rust-analyzer path/version,
  worker build, `PATH`, `HOME`, `CARGO_*`, `RA_*`, or `RUST*` changes the key.
- The host reuses one requester across compatible request policies and applies
  the current policy to every request.
- A true compiler-key change shuts down the old requester before replacement.

### LSP client tests

- Initialization advertises server-status support.
- Malformed and unrelated notifications do not satisfy readiness.
- Non-quiescent followed by healthy quiescent resolves the correct waiter.
- `rust-analyzer/analyzerStatus` is sent as a deadline-bounded read-only
  ordering request.
- A post-open round trip with an unchanged generation accepts only a retained
  healthy quiescent status.
- A post-open round trip with an advanced generation still requires a newer
  healthy quiescent status.
- A warning waits until quiescent and then resolves; error health rejects.
- Timeout and transport close reject all readiness waiters without leaks.
- Per-operation timeout options reach every LSP request method.

### Worker and failover tests

- A fresh session waits for newer healthy quiescence after initialization and
  uses the ordered status-stability barrier after opening documents.
- A reused session with no new documents does not wait again.
- A reused session with new documents performs diagnostics and the ordered
  status-stability barrier.
- An explicitly configured settle delay runs after observed quiescence without
  changing compiler-session identity.
- Unsupported/timed-out readiness replays through the per-command worker once
  and latches to it for the process.
- Durable failure followed by per-command failure still reaches the existing
  one-shot fallback.
- Helper crash, stale heartbeat, wrong protocol, and build invalidation remain
  covered by the existing durable-session tests.

### Runtime calibration

For each corpus, clear semantic references, semantic callees, the prewarm
marker, and the health report cache before every measured command.

Run:

1. evidence-cold/session-cold;
2. evidence-cold/session-warm;
3. explicit compiler-identity invalidation;
4. reverse warm-first;
5. reverse cold-second.

Acceptance requires:

- identical ordered semantic-reference payload digests;
- identical ordered semantic-callee payload digests;
- zero incomplete references;
- matching command output;
- profiles that prove the expected session disposition; and
- a meaningful warm-session wall-time improvement on both SynthRunnerRust and
  VegaAssistant.

If a corpus reports warning health, every accepted control must remain
payload-identical and the ledger must state the warning category. Warning
health never relaxes the digest, incomplete-reference, output, or performance
requirements.

Failed and diagnostic runs remain in the JSONL history. Only measurements that
pass every accuracy condition can support default routing.

The first version-2 local smoke is a required rejected diagnostic. It measured
186.20s, observed initialization readiness, timed out for 176.267s waiting for
an unpromised newer post-open status, then recorded `worker-fallback`. It
produced zero incomplete references but no durable `created` disposition, so
no warm run was eligible. The corrected status-stability barrier must pass a
new local cold/warm pair before external controls begin.

## Non-Goals

- Do not make durable mode the default before calibration passes.
- Do not replace rust-analyzer with SCIP occurrence heuristics.
- Do not change semantic cache schemas unless implementation evidence proves it
  necessary.
- Do not parse rust-analyzer progress-token names.
- Do not broaden this slice into general Rust reference-provider optimization.

## Verification Contract

Before completion:

- targeted durable identity/readiness/failover tests pass;
- the full test suite passes;
- lint, typecheck, and build pass;
- all five controls pass on both corpora;
- the benchmark ledger and JSONL history contain the final results;
- `scip-query reindex` leaves a fresh index; and
- `scip-query diff-gate --json` exits zero, with advisory findings explained.
