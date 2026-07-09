# Durable Rust Session Identity and Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to execute this plan task by task.

**Goal:** Make opt-in durable Rust semantic sessions reuse compatible live
rust-analyzer state across CLI commands while producing the same ordered
reference and callee evidence as a fresh session on scip-query,
SynthRunnerRust, and VegaAssistant.

**Architecture:** Keep compiler-session identity separate from per-request
policy, use rust-analyzer's opt-in `experimental/serverStatus` notification as
the readiness barrier, and fail closed from the durable helper to the existing
per-command worker and then to the existing one-shot resolver. The per-command
worker remains the default until the exact multi-corpus calibration passes.

**Tech Stack:** TypeScript, Node.js worker threads and filesystem mailbox,
rust-analyzer LSP, Vitest, SQLite, scip-query compiler-resolved evidence, and
the existing JSONL benchmark ledger.

## Global Constraints

- Work directly on `main`; preserve every unrelated dirty-worktree change.
- Use red-green TDD for each behavior change. Do not write production behavior
  before the focused failing test has demonstrated the missing contract.
- Keep `SCIP_RUST_SEMANTIC_DURABLE_SESSION` opt-in. Do not change default
  routing in this slice.
- Do not add a schema migration, progress-token parser, semantic fixed-point
  probe, or a second semantic-provider abstraction.
- Do not weaken semantic accuracy: ordered reference payload, ordered callee
  payload, incomplete-reference count, and command output are acceptance
  inputs, not advisory metrics.
- A readiness failure must cross the worker boundary as an error. It must not
  be converted into an empty but apparently available semantic response.
- Every wait and replay must remain inside an explicit deadline. There is no
  unbounded durable retry.
- Before every commit, inspect `git diff --cached --name-only`; stage only the
  files named by that task. Several production and test files already contain
  campaign work, so never discard or rewrite unrelated changes.
- Before completion, run `scip-query reindex && scip-query diff-gate --json` as
  required by the repository instructions.

---

## Current Evidence and Change Surface

The durable session is the running rust-analyzer process, its loaded project
graph, and its compiler caches. What distinguishes that state from a request
is that reference, callee, signature, and import-definition requests with
different time budgets can all use the same loaded program.

The current implementation conflates these two kinds of input:

- `createDurableRustSessionIdentity()` includes request timeout, diagnostics
  timeout, settle delay, concurrency, and reference retry timeout.
- `DurableRustSessionHost.handle()` shuts down its worker on any identity-key
  difference.
- `openNewDefinitionDocuments()` and `openNewSourceDocuments()` treat one
  diagnostics notification plus a fixed sleep as readiness.
- `RustAnalyzerLspClient.waitForDiagnostics()` proves only that one URI has
  published diagnostics; it does not prove that background analysis is idle.

This matches both rejected calibration results:

- VegaAssistant changed request policy within one command, repeatedly
  invalidated the helper, and produced a slower second run with fewer facts.
- SynthRunnerRust preserved reference evidence but fresh sessions
  deterministically missed 23 callee facts across three rows, even after the
  fixed first-session settle.

**SCIP sources:**

- `scip-query plan-context src/semantic/rust/lsp-session.ts`
- `scip-query code createDurableRustSessionIdentity`
- `scip-query code DurableRustSessionHost`
- `scip-query code openNewDefinitionDocuments`
- `scip-query code openNewSourceDocuments`
- `scip-query code waitForDiagnostics`
- `scip-query change-surface src/semantic/rust/lsp-session.ts --json --full`

`lsp-session.ts` has 18 external consumers and a medium-risk public surface.
The implementation therefore extends the existing
`RustAnalyzerSessionRequester` seam instead of changing provider APIs.

## Reuse Audit

| Need                         | Reuse                                                          | Reason                                                                                                 |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Semantic transport selection | `RustAnalyzerSessionRequester`                                 | It is already the synchronous boundary shared by semantic and import-definition work.                  |
| Per-command fallback         | `createWorkerRustAnalyzerSessionRequester()`                   | It already owns the accepted worker lifecycle, request parsing, and bounded synchronous response.      |
| Final fallback               | `RustAnalyzerSessionResolver` one-shot catch path              | It already recovers when a requester throws; durable failover should feed this path, not duplicate it. |
| Compiler invalidation        | `fingerprintProjectFiles()` and `rustSemanticEngineIdentity()` | They already identify source/Cargo state and rust-analyzer binary/version.                             |
| Cross-command ownership      | Existing durable mailbox and helper                            | Only its request metadata, environment handling, and host policy need hardening.                       |
| Readiness signal             | rust-analyzer `experimental/serverStatus`                      | It reports `health`, `quiescent`, and `message` from the server that owns background compiler work.    |

One new module, `src/semantic/rust/lsp-session-readiness.ts`, is justified. It
contains the small deadline/readiness policy that otherwise would be buried in
the 700+ line worker and be difficult to unit test without starting
rust-analyzer.

## Testability Contract

| Behavior                | Test seam                                        | Injected dependencies                                 | Contract                                                                                       |
| ----------------------- | ------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Status protocol         | `RustAnalyzerLspClient` with `ScriptedTransport` | LSP frames and close/error events                     | Only a newer, valid, healthy quiescent status resolves a waiter.                               |
| Deadline arithmetic     | `waitForRustAnalyzerReadiness()`                 | clock and fake client                                 | The remaining budget is positive and never exceeds the absolute request deadline.              |
| Worker phase policy     | readiness helpers plus fake client               | generation, statuses, opened-document count           | Fresh waits after initialize and open; reused/no-new-docs does not wait; reused/new-docs does. |
| Identity partition      | `createDurableRustSessionIdentity()`             | project, engine, worker, and environment fingerprints | Compiler inputs change the key; request policy does not.                                       |
| Environment replacement | `applyWorkerEnvironment()`                       | isolated `process.env` keys                           | Removed managed keys are deleted before the current command environment is applied.            |
| Durable failover        | `createFailoverRustAnalyzerSessionRequester()`   | primary and fallback requesters                       | One primary failure replays once and permanently latches to the per-command requester.         |
| Final fallback          | `RustAnalyzerSessionResolver` fake requesters    | durable failure plus worker failure                   | Existing one-shot resolution still runs.                                                       |
| Runtime accuracy        | SQLite payload snapshots and profile JSONL       | cache reset and helper lifecycle                      | All five controls have identical evidence/output and zero incomplete references.               |

---

### Task 1: Add the rust-analyzer server-status protocol and explicit LSP request budgets

**Files:**

- Modify: `src/semantic/rust/lsp-client.ts:1-260`
- Modify: `src/semantic/rust/lsp-batch-worker.ts:19-408`
- Modify: `tests/semantic/rust/rust-lsp-client.test.ts`
- Modify: `tests/semantic/rust/rust-lsp-batch-worker.test.ts`

**SCIP sources:** `scip-query code RustAnalyzerLspClient`, `scip-query code
referencesWithCompletion`, `scip-query code calleesForDefinition`, and
`scip-query code signatureForDefinition`.

#### Step 1: Write failing LSP status tests

Extend the existing `ScriptedTransport` tests with these cases:

1. `initialize()` advertises:

   ```ts
   capabilities: {
     experimental: { serverStatusNotification: true },
   }
   ```

   Merge this with caller-supplied capabilities; do not replace unrelated
   initialization capabilities.

2. A non-quiescent status followed by a newer `{ health: 'ok', quiescent:
true }` resolves `waitForQuiescence(afterGeneration, timeoutMs)`.
3. A quiescent status observed before `afterGeneration` does not satisfy the
   waiter.
4. Unrelated and malformed notifications do not satisfy the waiter.
5. `health: 'warning'` and `health: 'error'` reject with a typed readiness
   error whose public message does not include source text.
6. Timeout, transport close, and transport error reject and remove all
   readiness waiters.

Add timeout-option assertions for `definition`, `prepareCallHierarchy`,
`outgoingCalls`, and `hover`, matching the existing `references` option test.

Run the red test:

```bash
npx vitest run tests/semantic/rust/rust-lsp-client.test.ts
```

Expected failure: the client does not advertise or track server status, and
four request methods do not accept per-request options.

#### Step 2: Implement status generations and waiters

Add these public shapes near `RustAnalyzerRequestOptions`:

```ts
export interface RustAnalyzerServerStatus {
  health: 'ok' | 'warning' | 'error';
  quiescent: boolean;
  message?: string;
}

export class RustAnalyzerReadinessError extends Error {}
```

Add a monotonically increasing status generation and waiter collection. The
client API is:

```ts
serverStatusGeneration(): number;
waitForQuiescence(
  afterGeneration: number,
  timeoutMs: number,
): Promise<RustAnalyzerServerStatus>;
```

In `dispatchMessage()`:

- recognize only `experimental/serverStatus` notifications;
- validate the entire payload before incrementing the generation;
- reject current waiters immediately on valid warning/error health;
- resolve a waiter only when `generation > afterGeneration`, health is `ok`,
  and `quiescent === true`;
- leave unrelated/malformed notifications unable to establish readiness.

Use the existing `rejectPending()` close/error path to reject readiness
waiters too. Clear waiter timers on every resolve or reject.

Allow every semantic request method to accept the same optional request
options already supported by `references()`:

```ts
definition(params, opts: RustAnalyzerRequestOptions = {})
prepareCallHierarchy(params, opts: RustAnalyzerRequestOptions = {})
outgoingCalls(item, opts: RustAnalyzerRequestOptions = {})
hover(params, opts: RustAnalyzerRequestOptions = {})
```

Run the green test:

```bash
npx vitest run tests/semantic/rust/rust-lsp-client.test.ts
```

#### Step 3: Write failing timeout-propagation tests

In `rust-lsp-batch-worker.test.ts`, assert:

- the first reference attempt receives `{ timeoutMs: requestTimeoutMs }`;
- the retry receives `{ timeoutMs: referenceRetryTimeoutMs }`;
- definition, call-hierarchy preparation, outgoing calls, and hover each
  receive the current request timeout.

Update the existing retry expectation from `[undefined, 250]` to the explicit
pair `[requestTimeoutMs, 250]`.

Run the red test:

```bash
npx vitest run tests/semantic/rust/rust-lsp-batch-worker.test.ts
```

Expected failure: only reference retries currently receive an explicit
timeout.

#### Step 4: Thread request options through batch helpers

Add `requestTimeoutMs?: number` to `RustReferenceCompletionOptions`. Pass it to
the first `client.references()` call. Add a request-options parameter to
`calleesForDefinition()` and `signatureForDefinition()`, then pass it through
definition lookup, hierarchy preparation, outgoing calls, and hover retries.

The call sites in both `runWorker()` and the durable session worker must use:

```ts
const requestOptions = { timeoutMs: request.requestTimeoutMs };
```

Do not use the timeout stored in the client constructor for a reused semantic
operation. The constructor default remains only the initialization/default
safety net.

Run:

```bash
npx vitest run \
  tests/semantic/rust/rust-lsp-client.test.ts \
  tests/semantic/rust/rust-lsp-batch-worker.test.ts
npm run typecheck
```

#### Step 5: Commit Task 1

```bash
git add \
  src/semantic/rust/lsp-client.ts \
  src/semantic/rust/lsp-batch-worker.ts \
  tests/semantic/rust/rust-lsp-client.test.ts \
  tests/semantic/rust/rust-lsp-batch-worker.test.ts
git diff --cached --name-only
git commit -m "feat: observe Rust analyzer server readiness"
```

---

### Task 2: Make durable worker readiness deadline-based and phase-aware

**Files:**

- Create: `src/semantic/rust/lsp-session-readiness.ts`
- Create: `tests/semantic/rust/rust-lsp-session-readiness.test.ts`
- Modify: `src/semantic/rust/lsp-batch-worker.ts:19-34`
- Modify: `src/semantic/rust/lsp-session.ts:39-48`
- Modify: `src/semantic/rust/lsp-session-worker.ts:1-620`

**SCIP sources:** `scip-query code sessionForPaths`, `scip-query code
openNewDefinitionDocuments`, `scip-query code openNewSourceDocuments`, and
`scip-query code handleMessage`.

#### Step 1: Write failing pure readiness-policy tests

The new test file uses a fake readiness client and injected clock to prove:

- remaining time is `deadlineMs - now()` and is passed to the client;
- an expired or zero budget throws `RustAnalyzerReadinessError` immediately;
- initialization waits for a generation newer than the checkpoint taken
  before `initialize`;
- a post-open barrier sends an ordered analyzer-status request after `didOpen`
  and diagnostics;
- an unchanged generation after that round trip accepts only a retained
  healthy quiescent status, while a changed generation still requires newer
  healthy quiescence;
- zero opened documents skip the post-open barrier;
- a user settle delay runs after observed quiescence, never before it;
- client timeout, warning/error health, and close errors normalize to a typed
  readiness error.

Run:

```bash
npx vitest run tests/semantic/rust/rust-lsp-session-readiness.test.ts
```

Expected failure: the module does not exist.

#### Step 2: Implement the small readiness policy module

Define a structural client interface so tests do not construct a transport:

```ts
export interface RustAnalyzerReadinessClient {
  serverStatusGeneration(): number;
  waitForQuiescence(afterGeneration: number, timeoutMs: number): Promise<RustAnalyzerServerStatus>;
}

export async function waitForRustAnalyzerReadiness(
  client: RustAnalyzerReadinessClient,
  afterGeneration: number,
  deadlineMs: number,
  now: () => number = Date.now,
): Promise<void>;
```

Also expose one post-open helper that takes `openedDocumentCount`. It returns
without waiting when the count is zero and otherwise calls the core barrier.
Keep the explicit settle sleep injectable and run it only after the readiness
promise resolves.

Run the new test until green.

#### Step 3: Add one absolute readiness deadline to worker requests

Add optional `readinessDeadlineMs?: number` to both
`RustReferenceWorkerRequest` and `RustImportDefinitionWorkerRequest`. It is an
absolute timestamp, not a duration, so initialization, document opening, and
semantic operations share one caller-bounded budget.

Do not require this field. The existing per-command worker omits it and keeps
its accepted diagnostics-plus-settle behavior.

#### Step 4: Integrate readiness in session creation and document opening

For a request with `readinessDeadlineMs`:

1. Take `client.serverStatusGeneration()` before `initialize()`.
2. Initialize and send `initialized` through the existing client method.
3. Wait for a newer healthy quiescent generation.
4. Before sending any new `didOpen`, take another generation/status snapshot.
5. Open documents and keep the existing per-URI diagnostics wait.
6. If at least one document was newly opened, send a deadline-bounded,
   read-only `rust-analyzer/analyzerStatus` request. If the status generation
   changed, require newer healthy quiescence; if it did not change, require
   the retained checkpoint status to remain healthy and quiescent.
7. If `settleDelayMs > 0`, sleep only after the status-stability barrier.
8. Run references, callees, signatures, or import-definition operations with
   their explicit request timeouts from Task 1.

For a reused session with no new documents, do not wait for another status.
For a reused session with new source or definition documents, perform the
post-open status-stability barrier.

Make `openNewDefinitionDocuments()` and `openNewSourceDocuments()` return the
number of newly opened documents so this decision is explicit and testable.

#### Step 5: Preserve readiness failures across the worker boundary

The current worker maps broad semantic errors to `emptyResponse()`. Narrow the
catch policy:

```ts
if (error instanceof RustAnalyzerReadinessError) {
  writeWorkerError(responsePath, error.message);
  return;
}
```

Keep the existing empty-response behavior for the non-readiness cases that
already depend on it. This typed error is what activates durable-to-worker
failover in Task 4.

Run:

```bash
npx vitest run \
  tests/semantic/rust/rust-lsp-session-readiness.test.ts \
  tests/semantic/rust/rust-lsp-batch-worker.test.ts \
  tests/semantic/rust/rust-lsp-session.test.ts
npm run typecheck
```

#### Step 6: Run parameter/migration checks and commit

```bash
scip-query unused-params
scip-query incomplete-migration
git add \
  src/semantic/rust/lsp-session-readiness.ts \
  src/semantic/rust/lsp-batch-worker.ts \
  src/semantic/rust/lsp-session.ts \
  src/semantic/rust/lsp-session-worker.ts \
  tests/semantic/rust/rust-lsp-session-readiness.test.ts
git diff --cached --name-only
git commit -m "feat: gate durable Rust work on quiescence"
```

---

### Task 3: Partition compiler identity from request policy and replace managed environment exactly

**Files:**

- Modify: `src/semantic/rust/durable-session.ts:1-470`
- Modify: `src/semantic/rust/durable-session-server.ts:1-90`
- Modify: `tests/semantic/rust/rust-durable-session.test.ts`

**SCIP sources:** `scip-query code createDurableRustSessionIdentity`,
`scip-query code rustSessionAnswerAffectingEnvironment`, `scip-query code
applyWorkerEnvironment`, and `scip-query code DurableRustSessionHost`.

#### Step 1: Rewrite identity tests red

Replace the test that expects `settleDelayMs` to change the key. Use a table to
prove that all of these preserve one compiler-session key:

- request timeout;
- diagnostics timeout;
- settle delay;
- concurrency;
- reference retry timeout;
- requested references/callees/signatures flags;
- profiling output and thresholds; and
- SCIP occurrence routing.

Keep separate tests proving that these change the key:

- canonical project root;
- Rust source or Cargo fingerprint;
- rust-analyzer path or version;
- semantic worker build fingerprint;
- `HOME`, `PATH`, `CARGO_*`, `RA_*`, and `RUST*` startup values.

Add host tests proving that compatible policy shapes reuse one requester and
forward the current request values unchanged, while a compiler-key change
shuts down the old requester before replacement.

Add environment tests proving that a managed key present in command A and
absent in command B is deleted before B runs. Include one compiler key and one
transient `SCIP_RUST_*`/profile key.

Run:

```bash
npx vitest run tests/semantic/rust/rust-durable-session.test.ts
```

Expected failure: request policy still changes identity, `SCIP_RUST_*` is in
the compiler environment, and stale managed keys survive.

#### Step 2: Define the version-2 mailbox contract

Bump:

```ts
export const DURABLE_RUST_SESSION_PROTOCOL_VERSION = 2;
```

Remove `initialSettleDelayMs` from both durable request variants. The durable
requester creates a copied worker request containing:

```ts
{
  ...request,
  readinessDeadlineMs,
  settleDelayMs: explicitDurableSettleDelayMs,
}
```

Set:

```ts
readinessDeadlineMs = now + Math.max(1, timeoutMs - 1_000);
```

The final 1,000ms is response margin for worker serialization and mailbox
publication. Use the injected requester clock, not a second direct
`Date.now()` call.

When `SCIP_RUST_SEMANTIC_SETTLE_MS` is absent, the durable settle value is
zero. When it is explicitly set to a valid nonnegative integer, honor it after
quiescence. Invalid values use zero and are covered by tests. Per-command
settle selection is unchanged.

#### Step 3: Narrow the identity and split environment roles

Rename `rustSessionAnswerAffectingEnvironment()` to
`rustCompilerSessionEnvironment()` and include only sorted:

```text
HOME, PATH, CARGO_*, RA_*, RUST*
```

The identity contains protocol, canonical root, project fingerprint, engine
identity, worker fingerprint, and this compiler startup environment. It must
not inspect worker request policy or `SCIP_RUST_*` routing.

Keep a separate full `currentWorkerEnvironment()` for values the helper must
apply before every request. Its managed-key predicate includes:

```text
HOME, PATH, CARGO_*, RA_*, RUST*, SCIP_RUST_*, SCIP_QUERY_PROFILE,
SCIP_QUERY_PROFILE_OUT, and SCIP_QUERY_PROFILE_MIN_MS
```

Before applying the current map, delete every managed key currently in
`process.env`; then apply the provided non-null values. This prevents a
request-only setting from leaking from one CLI process to the next.

Apply the environment before comparing/creating the worker exactly as the
host does now. Because compiler startup values are part of the key, a changed
startup value still invalidates before a request can use stale compiler state.

#### Step 4: Run focused tests and build packaging

```bash
npx vitest run tests/semantic/rust/rust-durable-session.test.ts
npm run typecheck
npm run build
```

The build is mandatory here because the helper and worker build fingerprints
are part of identity and protocol invalidation.

#### Step 5: Run postchecks and commit

```bash
scip-query recent-duplicates
scip-query co-change src/semantic/rust/durable-session.ts
git add \
  src/semantic/rust/durable-session.ts \
  src/semantic/rust/durable-session-server.ts \
  tests/semantic/rust/rust-durable-session.test.ts
git diff --cached --name-only
git commit -m "fix: separate Rust session identity from policy"
```

---

### Task 4: Add one-way durable-to-worker failover

**Files:**

- Modify: `src/semantic/rust/lsp-session.ts:484-624`
- Modify: `tests/semantic/rust/rust-lsp-session.test.ts`
- Modify: `tests/semantic/rust/rust-durable-session.test.ts` only if profile
  disposition assertions belong with the mailbox tests

**SCIP sources:** `scip-query code
createConfiguredRustAnalyzerSessionRequester`, `scip-query code
createWorkerRustAnalyzerSessionRequester`, and `scip-query code
RustAnalyzerSessionResolver`.

#### Step 1: Write failover tests red

Specify `createFailoverRustAnalyzerSessionRequester(primary,
fallbackFactory)` with fake requesters:

1. A successful primary handles semantic and import requests without creating
   fallback.
2. The first primary throw shuts down primary, creates one fallback, and
   replays the exact original request once with the exact original timeout.
3. Later semantic and import requests go directly to the same fallback; the
   durable primary is never retried in that CLI process.
4. Concurrent method ordering is irrelevant because the public requester is
   synchronous, but shutdown remains idempotent.
5. If fallback throws, the error propagates to `RustAnalyzerSessionResolver`.
6. The existing resolver test proves durable failure plus worker failure still
   invokes the one-shot semantic/import path.
7. `createConfiguredRustAnalyzerSessionRequester(..., '1')` returns the
   failover requester; undefined/false still returns only the per-command
   worker.

Run:

```bash
npx vitest run tests/semantic/rust/rust-lsp-session.test.ts
```

Expected failure: configured durable routing currently returns the durable
requester directly and cannot latch to a per-command worker.

#### Step 2: Implement the failover requester

Export the focused wrapper:

```ts
export function createFailoverRustAnalyzerSessionRequester(
  primary: RustAnalyzerSessionRequester,
  fallbackFactory: () => RustAnalyzerSessionRequester,
): RustAnalyzerSessionRequester;
```

On the first primary error:

- capture a sanitized reason category (`readiness`, `timeout`, `helper`, or
  `request`) without source or environment values;
- call primary shutdown once;
- latch `failedOver = true` before replay;
- lazily create the fallback;
- replay that same method call once.

Do not catch fallback errors. They must reach the existing resolver catch so
the one-shot implementation remains the final fallback.

Emit the existing profile event shape with disposition `worker-fallback` and
the sanitized reason. Do not add full error stacks to benchmark JSONL.

Update configured selection to construct:

```ts
createFailoverRustAnalyzerSessionRequester(factories.durable(), factories.worker);
```

The fallback factory must be lazy so a healthy durable process does not create
a per-command worker.

#### Step 3: Verify and commit

```bash
npx vitest run \
  tests/semantic/rust/rust-lsp-session.test.ts \
  tests/semantic/rust/rust-durable-session.test.ts
npm run typecheck
scip-query wrapper-candidates
git add \
  src/semantic/rust/lsp-session.ts \
  tests/semantic/rust/rust-lsp-session.test.ts
git diff --cached --name-only
git commit -m "fix: fail closed from durable Rust sessions"
```

If `rust-durable-session.test.ts` changed, include it in the explicit `git add`
only after reviewing its staged diff.

---

### Task 5A: Correct post-open readiness for status-change notifications

This task was added after the first built version-2 smoke. That smoke measured
186.20s and correctly fell back because rust-analyzer 1.92.0 emitted no status
newer than the pre-`didOpen` checkpoint. Official source shows that
`experimental/serverStatus` is emitted only when the structured status
changes; it is not a per-`didOpen` acknowledgement. This task supersedes only
Task 2's requirement for an unconditionally newer post-open generation.

**Files:**

- Modify: `src/semantic/rust/lsp-client.ts`
- Modify: `src/semantic/rust/lsp-session-readiness.ts`
- Modify: `src/semantic/rust/lsp-session-worker.ts`
- Modify: `tests/semantic/rust/rust-lsp-client.test.ts`
- Modify: `tests/semantic/rust/rust-lsp-session-readiness.test.ts`

**Interfaces:**

- Consumes: `serverStatusGeneration()`, `waitForQuiescence()`, and the
  absolute `readinessDeadlineMs` implemented by Tasks 1-3.
- Produces:

  ```ts
  export interface RustAnalyzerServerStatusSnapshot {
    generation: number;
    status: RustAnalyzerServerStatus;
  }

  RustAnalyzerLspClient.serverStatusSnapshot(): RustAnalyzerServerStatusSnapshot | null;
  RustAnalyzerLspClient.analyzerStatus(opts?: RustAnalyzerRequestOptions): Promise<string>;
  ```

- `waitForRustAnalyzerPostOpenReadiness()` accepts the pre-open snapshot,
  performs the ordered read-only round trip, and returns only when status is
  proven healthy/quiescent inside the existing deadline.

- [ ] **Step 1: Write failing client protocol tests**

Add tests proving `analyzerStatus()` sends
`rust-analyzer/analyzerStatus` with `{}` and the current deadline, returns the
string response, and exposes a defensive latest status snapshot. Mutation of
the returned object must not alter the client's retained state.

Run:

```bash
npx vitest run tests/semantic/rust/rust-lsp-client.test.ts
```

Expected: FAIL because both APIs are absent.

- [ ] **Step 2: Write failing post-open policy tests**

Add tests with a structural fake client for:

1. checkpoint healthy/quiescent, analyzer-status round trip succeeds,
   generation unchanged -> pass without `waitForQuiescence`;
2. generation advances to non-quiescent during the round trip -> call
   `waitForQuiescence(checkpoint.generation, remainingMs)` and require its
   newer healthy/quiescent result;
3. checkpoint absent, error-health, or non-quiescent -> typed readiness
   failure;
4. round-trip request failure/timeout -> typed readiness failure;
5. unchanged generation but retained status becomes error or non-quiescent ->
   typed readiness failure;
6. zero newly opened documents -> no round trip.

Also prove that warning health remains pending while non-quiescent and is
accepted once quiescent. Error health remains fail-closed.

Run:

```bash
npx vitest run tests/semantic/rust/rust-lsp-session-readiness.test.ts
```

Expected: FAIL because the existing helper unconditionally waits for a newer
generation and has no ordered request/status snapshot.

- [ ] **Step 3: Implement the client APIs**

Add the public snapshot type and return a copied status value:

```ts
serverStatusSnapshot(): RustAnalyzerServerStatusSnapshot | null {
  const latest = this.latestServerStatus;
  return latest
    ? { generation: latest.generation, status: { ...latest.status } }
    : null;
}

async analyzerStatus(opts: RustAnalyzerRequestOptions = {}): Promise<string> {
  return this.request<string>('rust-analyzer/analyzerStatus', {}, opts);
}
```

Use the existing request budget/deadline machinery; do not add a timer or
special transport path.

- [ ] **Step 4: Implement the ordered status-stability policy**

Extend the structural client with `serverStatusSnapshot()` and
`analyzerStatus()`. The post-open helper must:

```ts
if (openedDocumentCount === 0) return;
assertUsableQuiescent(checkpoint.status);
await client.analyzerStatus({ deadlineMs });
assertRustAnalyzerReadinessBudget(deadlineMs, now, 'during post-open synchronization');
const latest = client.serverStatusSnapshot();
if (!latest) throw new RustAnalyzerReadinessError('rust-analyzer status is unavailable after document open');
if (latest.generation === checkpoint.generation) {
  assertUsableQuiescent(latest.status);
} else {
  await waitForRustAnalyzerReadiness(client, checkpoint.generation, deadlineMs, now);
}
await waitForRustAnalyzerDelayWithinDeadline(settleDelayMs, deadlineMs, now, settle);
```

If `analyzerStatus()` needs a shorter explicit timeout, calculate it from the
same absolute deadline. Do not accept a generation lower than the checkpoint,
error health, or non-quiescent status, and do not use a fixed implicit delay.
A quiescent warning is accepted and its health level is recorded in readiness
profile metadata; exact runtime calibration remains mandatory.

- [ ] **Step 5: Wire snapshots through both open-document paths**

In `openNewDefinitionDocuments()` and `openNewSourceDocuments()`, capture the
status snapshot immediately before the first new `didOpen` and pass it to the
post-open helper after diagnostics. Preserve zero-new-document fast paths,
typed invalidation, explicit settle placement, and per-command behavior when
`readinessDeadlineMs` is absent.

- [ ] **Step 6: Verify and commit the correction**

```bash
npx vitest run \
  tests/semantic/rust/rust-lsp-client.test.ts \
  tests/semantic/rust/rust-lsp-session-readiness.test.ts \
  tests/semantic/rust/rust-lsp-session.test.ts \
  tests/semantic/rust/rust-durable-session.test.ts
npm run typecheck
npm run lint
npm run build
scip-query reindex
scip-query diff-gate --json
git add \
  src/semantic/rust/lsp-client.ts \
  src/semantic/rust/lsp-session-readiness.ts \
  src/semantic/rust/lsp-session-worker.ts \
  tests/semantic/rust/rust-lsp-client.test.ts \
  tests/semantic/rust/rust-lsp-session-readiness.test.ts
git diff --cached --name-only
git commit -m "fix: synchronize Rust post-open readiness"
```

---

### Task 5: Prove the built protocol with a real rust-analyzer smoke test and the local corpus

**Files:**

- Modify only if a real failure reveals a missing contract: targeted source
  and test files from Tasks 1-4
- Create benchmark profiles under:
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-*.profile.jsonl`
- Do not update the ledger yet unless the smoke/local result changes the
  implementation decision

#### Step 1: Run the complete focused test set

```bash
npx vitest run \
  tests/semantic/rust/rust-lsp-client.test.ts \
  tests/semantic/rust/rust-lsp-batch-worker.test.ts \
  tests/semantic/rust/rust-lsp-session-readiness.test.ts \
  tests/semantic/rust/rust-lsp-session.test.ts \
  tests/semantic/rust/rust-durable-session.test.ts
npm run build
```

#### Step 2: Exercise the built helper on scip-query

Use the built CLI and enable profiling. Run an evidence-cold/session-cold then
evidence-cold/session-warm pair. Clear only semantic evidence between runs and
retain the helper for the warm control.

Acceptance before spending minutes on external corpora:

- cold profile contains `created` and observed readiness;
- warm profile contains `reused` and no initialization/open-document work;
- reference and callee payload digests match;
- incomplete references are zero;
- stdout SHA-256 matches;
- warm wall time is lower than cold wall time.

If readiness is unsupported by the installed rust-analyzer, the profile must
show `worker-fallback`, output must still be correct, and the durable path is
not eligible for external acceptance. Diagnose before proceeding; do not hide
the fallback as a successful reuse result.

#### Step 3: Fix only evidence-backed smoke failures

For any unexpected status ordering or timeout, invoke `scip-debug`, add the
smallest reproducing test, observe it fail, then implement the fix. Repeat the
local pair until it meets every condition.

Commit a smoke-derived fix separately with its reproducing test. Do not commit
profile artifacts alone at this checkpoint.

---

### Task 6: Run the exact five-control calibration on SynthRunnerRust and VegaAssistant

**Files:**

- Modify:
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis.jsonl`
- Create ten final profile files under `docs/benchmarks/runs/`
- Modify:
  `docs/benchmarks/2026-07-09-ts-rust-indexing-analysis-ledger.md`

**Corpora:**

```text
/Users/aydansalois/Documents/GitHub/SynthRunnerRust
/Users/aydansalois/Documents/GitHub/VegaAssistant
```

#### Step 1: Define one reproducible cache reset

For each corpus, derive the default cache directory from the canonical path:

```bash
CORPUS=/absolute/corpus/path
PROJECT_HASH=$(printf '%s' "$CORPUS" | shasum -a 256 | cut -c1-12)
CACHE_DIR="$HOME/.cache/scip-query/projects/$PROJECT_HASH"
EVIDENCE_DB="$CACHE_DIR/evidence.db"
```

Before every measured command:

```bash
sqlite3 "$EVIDENCE_DB" \
  "DELETE FROM semantic_references;
   DELETE FROM semantic_callees;
   DELETE FROM project_evidence WHERE kind = 'health-semantic-prewarm';"
rm -f "$CACHE_DIR/health-report-cache.json"
```

Do not delete `index.db`; these controls isolate semantic evidence and live
compiler state, not indexing time.

Stop the detached helper before a session-cold control by reading its
repository/build-scoped `server.json`, terminating the recorded live PID, and
waiting for death before removing stale server state. Never kill by process
name or use a broad `pkill`.

#### Step 2: Run five controls per corpus

Use the same built scip-query artifact and this command shape:

```bash
SCIP_RUST_SEMANTIC_DURABLE_SESSION=1 \
SCIP_QUERY_PROFILE=1 \
SCIP_QUERY_PROFILE_OUT=/absolute/profile.jsonl \
/Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js \
  health --full --json
```

Run in this order for each corpus:

1. `session-cold`: baseline environment, helper absent.
2. `session-warm`: baseline environment, helper retained.
3. `identity-invalidated`: helper retained, add `RA_LOG=warn` to change a real
   compiler-startup identity input without changing source.
4. `reverse-warm-first`: keep `RA_LOG=warn` and retain the invalidated helper.
5. `reverse-cold-second`: keep `RA_LOG=warn`, stop the helper immediately
   before the command.

The expected dispositions are `created`, `reused`, `invalidated`, `reused`,
and `created`. Any `worker-fallback` is an accuracy-preserving diagnostic run,
not a passing durable calibration.

#### Step 3: Snapshot every result before the next reset

After each command, record:

```bash
sqlite3 -batch -noheader "$EVIDENCE_DB" \
  "SELECT relative_path, symbol, payload
     FROM semantic_references
    ORDER BY relative_path, symbol;" | shasum -a 256

sqlite3 -batch -noheader "$EVIDENCE_DB" \
  "SELECT relative_path, symbol, payload
     FROM semantic_callees
    ORDER BY relative_path, symbol;" | shasum -a 256

sqlite3 "$EVIDENCE_DB" \
  "SELECT count(*), coalesce(sum(json_array_length(payload)), 0)
     FROM semantic_references;
   SELECT count(*), coalesce(sum(json_array_length(payload)), 0),
          sum(CASE WHEN json_array_length(payload) > 0 THEN 1 ELSE 0 END)
     FROM semantic_callees;"
```

Also capture wall time, exit code, stdout SHA-256, profile path, session
disposition, initialization/open-document spans, and every profile field that
reports incomplete reference materialization. Preserve the ordered payload
snapshots or their digests before the next cache reset.

#### Step 4: Apply the acceptance gate exactly

Each corpus passes only if all five controls have:

- exit code zero;
- identical stdout SHA-256;
- identical ordered reference digest and fact count;
- identical ordered callee digest, fact count, and nonempty-row count;
- zero incomplete references;
- the expected session disposition;
- no hidden worker fallback; and
- a warm-session wall-time improvement that remains present in the reverse
  comparison.

Treat “meaningful” as both warm controls being at least 20% faster than their
corresponding cold controls. Record the raw times even if the threshold fails.
Do not average away a reversed-order regression.

If SynthRunnerRust fails, stop before Vega and diagnose. If Synth passes but
Vega fails, keep all Vega diagnostic rows and reject default routing. Do not
change the acceptance condition after observing results.

#### Step 5: Record the result without rewriting history

Append new JSONL records. Do not edit or delete the earlier rejected records.
Each summary row includes corpus, git head, dirty state, command, environment
identity label, control order, duration, disposition, row/fact counts,
digests, incomplete count, stdout digest, profile path, and accepted boolean.

Update the ledger's durable-session section with:

- the version-2 identity/readiness design;
- the ten-control result table;
- exact digests and speed comparisons;
- fallback occurrences, if any; and
- the routing decision.

Only state that durable routing is eligible to become default if both corpora
pass all conditions. This plan itself does not change the default.

#### Step 6: Validate benchmark artifacts and commit

```bash
node -e "const fs=require('fs'); for (const line of fs.readFileSync('docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis.jsonl','utf8').trim().split(/\n/)) JSON.parse(line);"
npx prettier --write \
  docs/benchmarks/2026-07-09-ts-rust-indexing-analysis-ledger.md
npx prettier --check \
  docs/benchmarks/2026-07-09-ts-rust-indexing-analysis-ledger.md
scip-query doc-drift
git add \
  docs/benchmarks/2026-07-09-ts-rust-indexing-analysis-ledger.md \
  docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis.jsonl \
  docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-*-durable-readiness-*.profile.jsonl
git diff --cached --name-only
git commit -m "docs: calibrate durable Rust session readiness"
```

Use exact profile filenames in `git add` if the shell pattern would stage an
older campaign artifact.

---

### Task 7: Reconcile the design status and run full verification

**Files:**

- Modify:
  `docs/superpowers/specs/2026-07-09-durable-rust-session-readiness-design.md`
- Modify this plan only if execution uncovered an accepted deviation
- Verify every production, test, benchmark, and build file touched above

#### Step 1: Reconcile design and implementation

Change the design status from “awaiting written-spec review” to the actual
approved/implemented state. Compare every design section against the diff:

- identity inputs and exclusions;
- explicit request policy;
- status capability and generation semantics;
- initialization and post-open barriers;
- explicit settle placement;
- typed failure and one-way failover;
- calibration contract.

Document any deviation with evidence. Do not silently alter the design after
implementation.

#### Step 2: Run focused and full verification

```bash
npx vitest run \
  tests/semantic/rust/rust-lsp-client.test.ts \
  tests/semantic/rust/rust-lsp-batch-worker.test.ts \
  tests/semantic/rust/rust-lsp-session-readiness.test.ts \
  tests/semantic/rust/rust-lsp-session.test.ts \
  tests/semantic/rust/rust-durable-session.test.ts
npm test -- --run
npm run lint
npm run typecheck
npm run build
```

Record command, exit code, and the final summary. Do not claim a pass from an
earlier run made before the last code edit.

#### Step 3: Run change-shaped SCIP checks

```bash
scip-query incomplete-migration
scip-query recent-duplicates
scip-query unused-params
scip-query wrapper-candidates
scip-query co-change src/semantic/rust/durable-session.ts
scip-query doc-drift
scip-query reindex
scip-query diff-gate --json
```

Fix blocking findings. For advisory findings, record the finding and the
specific reason it is accepted. The pre-existing whole-campaign health
baseline may remain red, but no new blocker from this slice may be ignored.

#### Step 4: Commit final reconciliation

```bash
git add \
  docs/superpowers/specs/2026-07-09-durable-rust-session-readiness-design.md
git diff --cached --name-only
git commit -m "docs: close durable Rust readiness design"
```

If verification required code changes, use a separate red-green fix commit
before this documentation-only commit.

---

## Stress-Test and Failure Policy

- **Unsupported protocol:** If rust-analyzer never emits a valid server status,
  durable readiness times out and the process latches to the per-command
  worker. It does not guess readiness from elapsed time.
- **Unhealthy server:** Warning/error status rejects readiness. The profile
  records only a sanitized category; fallback owns the operation.
- **Status race:** Generation is captured before initialize or `didOpen`, so a
  status emitted during the operation is newer and can satisfy the barrier; a
  status from an earlier phase cannot.
- **Policy churn:** Request settings are forwarded on every operation but
  cannot restart compatible compiler state.
- **Environment churn:** Compiler startup keys invalidate the worker. Removed
  managed request/profile keys cannot leak into later commands.
- **Helper crash/stale state:** Existing liveness recovery is preserved. If it
  cannot recover inside the deadline, failover handles the request.
- **Worker failure after failover:** Error propagates to the existing one-shot
  resolver. There is no durable-worker-durable loop.
- **Deadline exhaustion:** The readiness deadline leaves 1,000ms for response
  publication. Expired readiness fails immediately; it never starts an
  unbounded wait.
- **Data integrity:** The helper keeps only live compiler state. SQLite remains
  the durable semantic evidence store.
- **Reversibility:** Leaving the opt-in unset uses the unchanged per-command
  transport. A failed calibration therefore has a complete, immediate rollback
  path without a schema change.

## Execution and Ship Order

1. LSP status protocol and explicit operation budgets.
2. Worker readiness phases and typed error propagation.
3. Version-2 identity/environment partition.
4. One-way durable-to-worker failover.
5. Built real-server smoke and cheap local paired calibration.
6. SynthRunnerRust five controls, then VegaAssistant five controls.
7. Documentation reconciliation, full verification, reindex, and diff gate.

Do not parallelize Tasks 1-4: each changes the request protocol consumed by
the next. The two corpus calibrations are also sequential because a Synth
failure should prevent unnecessary Vega runtime. Independent review can occur
after each commit, but implementation order stays linear.

## File Summary

**Create:**

- `src/semantic/rust/lsp-session-readiness.ts`
- `tests/semantic/rust/rust-lsp-session-readiness.test.ts`
- final calibration profile artifacts under `docs/benchmarks/runs/`

**Modify:**

- `src/semantic/rust/lsp-client.ts`
- `src/semantic/rust/lsp-batch-worker.ts`
- `src/semantic/rust/lsp-session-worker.ts`
- `src/semantic/rust/lsp-session.ts`
- `src/semantic/rust/durable-session.ts`
- `src/semantic/rust/durable-session-server.ts`
- the five focused Rust semantic test files
- `docs/superpowers/specs/2026-07-09-durable-rust-session-readiness-design.md`
- `docs/benchmarks/2026-07-09-ts-rust-indexing-analysis-ledger.md`
- `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis.jsonl`

**Delete:** none planned.

## Definition of Done

The work is complete only when compatible request shapes reuse one live
rust-analyzer compiler state, fresh initialization waits for newer healthy
quiescence, post-open work passes the ordered status-stability barrier, failure
latches safely to the accepted fallbacks, focused and full verification pass,
and all five controls on both external corpora produce identical ordered
semantic evidence with zero incomplete references and a meaningful
reversed-order warm speedup. Until then, durable routing remains experimental
and per-command routing remains the default.
