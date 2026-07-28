# scip-query — Design-by-Contract Audit

Date: 2026-07-27
Audited revision: `8745d26dc3d10213d74e8d0f370b36d1e178c496`
Audited package version: `0.19.8`
SCIP generation: `fbb09ec86522` (fresh when the review began)

Scope: public query APIs, CLI result and pagination protocols, watcher and Worker state machines, TypeScript mailbox settlement, process-lock observations, semantic availability, diff-impact evidence degradation, cleanup-verification safety checks, SQLite lifecycle ownership, and implementation/interface substitutability.

Method: this was a read-only production-code review. It applied the `design-by-contract` lens and the `scip-audit` evidence discipline. Compiler-resolved `scip-query` results established complete reference sets where the finding depended on symbol identity. Native reads established exact branch ordering, public declarations, tests, and literal behavior. Disposable in-memory or ignored build probes tested runtime and TypeScript behavior. No sub-agents were used. No production code, tests, configuration, or skills were changed.

This report records **nine findings**:

- **4 high-severity findings:** DBC-01 through DBC-04;
- **4 medium-severity findings:** DBC-05 through DBC-08;
- **1 low-severity finding:** DBC-09.

The findings identify behavior permitted by the audited revision. They do not claim every failure has happened in a user session. Runtime probes, existing tests, and source-only failure sequences are distinguished explicitly.

---

## 1. Outcome

The codebase already has several strong contractual boundaries:

- external mailbox data and process-lock records are parsed before use;
- durable Rust responses use explicit success and failure variants;
- diff-gate fails closed when the Git diff itself cannot be computed;
- output transport cursors bind continuations to an invocation and output hash;
- `refs` result cursors bind continuation to an index generation;
- process identity includes birth identity where the platform supplies it;
- the three production classes that implement semantic resolver/provider interfaces return complete key maps for the definitions they accept; no confirmed substitutability violation was found;
- focused tests cover ordinary completion, timeout, shutdown, duplicate Worker responses, malformed coverage counts, output continuation, ambiguous class resolution, and incomplete-migration behavior.

The remaining weaknesses cluster around one rule: **a failed obligation is sometimes converted into an ordinary empty value after the caller has already lost the information needed to recover**.

The highest-risk examples are:

1. a mailbox claim can remain durably inflight after settlement fails, while the live watcher reopens admission;
2. a failed dirty-worktree check is represented as an empty dirty-file set;
3. failed consumer-evidence tiers are represented as empty consumer maps, even when a full diff-gate run later claims complete coverage;
4. an invalid Git base or Git execution failure is represented by the same `null` used for “this file did not exist at the base.”

The type system repeats the same ambiguity at a lower level. Several protocols use a Boolean plus optional fields where the Boolean actually selects a distinct state. TypeScript therefore accepts states that the runtime cannot honestly interpret: complete output with omitted results, incomplete transport output without a continuation, successful Worker output containing only an error, or a valid lock observation without a lock record.

---

## 2. Terms, evidence grades, and severity

A **software contract** is an enforceable agreement at a code boundary that assigns what the caller must establish and what the supplier must deliver. Its real referents in this repository are function signatures, serialized protocol records, callback obligations, resource-lifecycle rules, and command-result coverage. What makes it a contract rather than documentation is that violating it is detected or made impossible before an invalid state can be treated as a valid result.

A **precondition** is a fact the caller must establish before invoking an operation because the supplier is not responsible for manufacturing that fact. Examples here include a positive deadline, a caller-owned output path, or a valid option value. A condition is not a proper caller precondition when the caller cannot observe it without duplicating the supplier's own work.

A **postcondition** is a fact the supplier guarantees after it reports completion. Examples here include a mailbox claim being durably moved to a response or rejection, a `complete: true` result containing no omitted units, and `null` from a base-content lookup meaning the file was genuinely absent rather than that Git failed.

An **invariant** is a fact that must remain true throughout every externally observable state of a component. The `ScipDatabase` invariant is that one wrapper owns one SQLite connection together with one generation-reader lease until `close()` releases both. The mailbox invariant is that every claimed request remains owned until it has been durably settled or made reclaimable.

A **boundary** is a transition where responsibility or representation changes. Worker messages, filesystem mailboxes, CLI JSON, public package exports, callbacks, Git subprocess results, and construction or disposal of a database are boundaries because facts valid on one side cannot be assumed on the other without validation.

A **discriminated union** is a set of object types whose required fields are selected by one literal state tag. It differs from a Boolean plus optional fields because an invalid combination cannot be constructed without escaping the type system.

**Substitutability** is the requirement that an implementation usable through an interface accept every state the interface permits and preserve every result the interface promises. An implementation may accept more or guarantee more; it must not require more or guarantee less.

Evidence grades used below:

- **Runtime-confirmed:** a disposable probe executed the current code and demonstrated the behavior.
- **Type-system-confirmed:** a non-writing TypeScript probe compiled an invalid state with zero diagnostics.
- **Existing-test confirmation:** a checked-in test establishes the named behavior.
- **Source-confirmed ordering:** the current branches establish the complete failure sequence without a missing concurrency or recovery edge.
- **Contract hardening gap:** current producers behave correctly, but a public or central enforcement boundary accepts an invalid state.

Severity:

- **High** means one allowed path can orphan durable work, authorize a destructive action without establishing its safety precondition, or make an evidence gate silently miss relevant code while presenting an ordinary result.
- **Medium** means a central invariant can be bypassed or leaked, a protocol validator accepts contradictory state, or a public API makes expected outcomes indistinguishable from untyped failures.
- **Low** means a misuse compiles and can cause incorrect behavior, but ordinary named callers and current tests make occurrence less likely.

---

## 3. Contract map

| Boundary | Caller obligation | Supplier obligation | Audit result |
| --- | --- | --- | --- |
| Worker response → mailbox settlement | Worker returns the matching request identity before its deadline | Parent retains ownership until completion or rejection is durably written | **Violated:** active/current state is cleared before durable settlement |
| Cleanup plan → verification | Caller supplies a repository and deletion plan | Verifier establishes dirty overlap or reports that it could not | **Violated:** Git-status failure becomes an empty dirty set |
| Semantic/source enrichment → diff impact | Evidence tier attempts consumer discovery | Result discloses whether the tier completed | **Violated:** failure becomes an empty map and only an unstructured stderr warning |
| Git base → historical file content | Caller supplies project root, base, and relative path | `null` means absence; operational failure remains distinguishable | **Violated:** invalid base and Git failure also return `null` |
| Invocation coverage → CLI JSON | Producer supplies counts and resolution state | Validator rejects contradictory completeness claims | **Incomplete:** complete-with-omissions is accepted |
| `ScipDatabase` construction/lifecycle | Caller supplies configuration and eventually calls the wrapper's `close()` | Wrapper exclusively owns and releases connection plus generation lease | **Violated:** initialization can leak; raw connection is public |
| CLI/Worker/watch/lock state types | Producer selects one protocol state | Required fields follow from that state | **Incomplete:** Boolean/optional shapes permit impossible combinations |
| `methods` public API | Caller supplies a class query | Supplier returns matched, missing, or ambiguous outcome in a stable form | **Incomplete:** two ordinary resolution outcomes are generic exceptions |
| Published multi-string helpers | Caller supplies semantically distinct strings | Signature makes their roles difficult to transpose | **Incomplete:** several swaps compile unchanged |

---

## 4. Detailed findings

### DBC-01 — High — Mailbox settlement failure loses live ownership and reopens admission

**Evidence:** runtime-confirmed; source-confirmed ordering; missing regression coverage.

**Contract:**

Once the TypeScript mailbox parent claims a request, exactly one of these must happen before it accepts replacement work:

1. the result is durably completed;
2. the request is durably rejected;
3. the owner stops or explicitly releases the claim so another owner can reclaim it.

Merely recording a fatal message does not satisfy any of the three.

**Code and SCIP relationships:**

- `src/runtime/worker-request-lane.ts:114-139` validates a Worker response, calls `takeActive()` at line 128, and therefore clears `this.active` and its timer before invoking `onComplete` or `onReject`.
- If either callback throws, the catch at lines 137-139 calls only `onFatal`. The lane remains open because `active` is already `null`, `terminating` is `null`, and `closed` remains false.
- `src/runtime/typescript-mailbox-lanes.ts:207-216` implements those callbacks by first calling `takeCurrent(request.requestId)`.
- `takeCurrent` at lines 274-281 clears the durable lane's `current` claim and clears its busy marker before `options.complete(...)` or `options.reject(...)` performs the filesystem settlement.
- A filesystem error from the settlement therefore reaches `WorkerRequestLane.onFatal` only after both in-memory owners have forgotten the claim.
- `src/runtime/watch-server.ts:207-210` implements the fatal handler by recording activity, storing `lastError`, and persisting watcher state. It does not stop the watcher, close admission, release the claim, or retry settlement.
- The bounded mailbox still contains the request in its inflight area. Because its recorded owner process remains live, liveness-based reclamation correctly refuses to steal it.

**Runtime probe:**

A disposable bundle instantiated the audited `WorkerRequestLane`, made `onComplete` throw `"durable settlement failed"`, and emitted a valid matching Worker response:

```json
{"fatal":["durable settlement failed"],"admissionReopenedAfterFailedSettlement":true}
```

This proves the lane-level postcondition failure and reopened admission. The TypeScript mailbox adapter adds the durable inflight orphan described by the source ordering.

**Attempted refutation:**

- Duplicate Worker responses do not repair the claim. The first response increments the lane's settled generation by clearing `active`; later messages are ignored.
- The request deadline does not repair it. Its timer is cleared by `takeActive`.
- Lease expiry does not repair it while the watcher process and process identity remain live.
- `recordMailboxFatal` makes the failure visible but does not change ownership.
- `tests/runtime/worker-request-lane.test.ts` covers exactly-once success, timeout termination, shutdown, and failed Worker termination. It does not make `onComplete` or `onReject` throw.
- `tests/reindex/typescript-index-mailbox.test.ts` proves ordinary exactly-once commit. It does not inject a completion or rejection filesystem failure.

**Consequences:**

- The original caller can wait until its own timeout even though the Worker produced a result.
- The request remains unreclaimable until the watcher exits or is killed.
- The lane can claim and execute a replacement, so the service's in-memory “one active request” assertion no longer corresponds to its durable inflight state.
- Repeated settlement failures can accumulate live-owner inflight records.

**Recommended design:**

- Do not clear `current`, the busy marker, or lane admission until durable settlement returns successfully.
- Model settlement as an explicit state: `processing → settling → idle`; only `idle` accepts.
- If settlement fails, either retry under a bounded policy while retaining ownership, or fail-stop the lane/watcher so process death makes the claim reclaimable.
- If explicit release is chosen, make it a durable mailbox operation with its own success postcondition; do not emulate release by forgetting in-memory state.
- Make `onComplete` and `onReject` return a settlement result or Promise rather than treating arbitrary throwing callbacks as fire-and-forget notifications.

**Required tests:**

- Completion write throws: admission remains closed and the claim remains associated with the lane.
- Rejection write throws: same guarantee.
- A retry succeeds exactly once without duplicate response files.
- A fail-stop path joins the Worker and exits or closes the service before a replacement is admitted.
- A subsequent process can reclaim the claim only after the original owner is observably dead or has durably released it.

**Acceptance condition:** no branch can make the mailbox claim ownerless in memory while its durable owner remains a live process.

---

### DBC-02 — High — Cleanup verification treats failure to inspect the working tree as proof that it is clean

**Evidence:** source-confirmed ordering; missing failure-path test.

**Contract:**

Before cleanup verification authorizes deletion batches, it must establish whether any planned file contains user changes. “No dirty files” is a positive safety conclusion, not a best-effort observation. If Git cannot establish that conclusion, verification must fail closed or explicitly return an unknown state.

**Code:**

- `src/runtime/cleanup-verify.ts:395-410` runs `git status --porcelain`.
- Every thrown condition—nonzero exit, timeout, signal, output overflow, executable failure, or repository error—is caught at line 403 and converted to `[]`.
- `dirtyPlanFiles` at lines 389-393 interprets that empty array as no overlap.
- `verifyCleanupPlan` returns both `dirtyOverlap` and `dirtyWorkingTree` as ordinary arrays at lines 130-136.
- `cleanupVerificationFailures` at lines 490-514 rejects dirty plan files only when `dirtyOverlap.length > 0`. It has no representation for “dirty state could not be inspected.”

**Failure sequence:**

1. A cleanup plan includes `src/a.ts`, which has uncommitted user work.
2. `git status --porcelain` throws.
3. `dirtyWorkingTreeFiles` returns `[]`.
4. The detached worktree and checker run can still succeed, because they validate the clean `HEAD` plus generated deletions, not the user's uncommitted content.
5. `cleanupVerificationFailures` sees no dirty overlap and can authorize the batch.
6. The caller can then apply a deletion whose safety was established against different content.

**Attempted refutation:**

- A general, persistent Git failure may also make `git worktree add` throw, which prevents a result. That does not restore the contract: the status operation has distinct failure modes and occurs separately.
- The returned `dirtyWorkingTree` field does not help because it also receives `[]` from the same fail-open function.
- `allowDirty` is an explicit caller override, but the failure path behaves as if the override were enabled without the caller choosing it.
- `tests/queries/cleanup/cleanup-plan.test.ts` tests that a supplied nonempty `dirtyOverlap` blocks and that `allowDirty` overrides it. It does not test Git-status failure or an unknown dirty state.

**Recommended design:**

- Return a discriminated inspection result such as:

```ts
type WorkingTreeInspection =
  | { kind: 'known'; files: string[] }
  | { kind: 'unavailable'; reason: string };
```

- Propagate `unavailable` into `CleanupVerification`.
- Make `cleanupVerificationFailures` reject `unavailable` unless a separately named unsafe override is explicitly selected.
- Keep `allowDirty` distinct: known-dirty and unknown are different risks.
- Add an injected Git runner so timeout, nonzero exit, and oversized output can be tested deterministically.

**Required tests:**

- Git status nonzero, timeout, signal, and output overflow all produce `unavailable`, never `[]`.
- Checker success cannot turn an unknown dirty state into a verified batch.
- `allowDirty` applies only to known overlap unless an explicit `allowUnknownWorkingTree` policy is added.
- The diagnostic includes the underlying Git failure without leaking uncontrolled output.

**Acceptance condition:** a cleanup batch cannot be reported as safe unless dirty overlap was actually inspected or the caller explicitly accepted an unknown working-tree state.

---

### DBC-03 — High — Consumer-evidence failures become empty maps while a full diff gate can still claim completeness

**Evidence:** source-confirmed ordering; an observed failure class is documented in source; missing structured degradation test.

**Contract:**

An empty consumer set means the evidence tier completed and found no consumers. A thrown evidence computation means the tier did not establish that result. Those states must remain distinguishable through every result that can support a gate pass.

**Code and SCIP relationships:**

- `src/queries/impact/diff-impact.ts:153-179` uses SCIP evidence first, then calls `semanticCallerMap`, then `sourceFallbackCallerEvidenceMap` for definitions still showing zero consumers.
- The source comment at lines 160-163 records an actually observed ts-morph failure class: an internal `resolveErrorCall`/`getTypeOfSymbol` crash on a large generated-contract file.
- Both enrichment calls pass through `safeConsumerMap`.
- `safeConsumerMap` at lines 795-803 catches every error, prints an unstructured stderr warning, and returns `new Map()`.
- `DiffImpactPartial` and `DiffImpactResult` contain changed symbols, consumer entries, attribution notes, and summary counts. Neither has an evidence-tier status or degradation field.
- The complete SCIP reference set shows `diffImpact` is used by `src/queries/impact/diff-gate.ts:264`.
- In `src/runtime/query-commands/impact.ts:319-328`, `diff-gate --full --json` reports `complete: true`, `totalKnown: true`, and `omitted: 0` whenever the gate itself did not fail, regardless of an enrichment exception converted by `safeConsumerMap`.

**Failure sequence:**

1. A changed definition has zero indexed SCIP consumers.
2. Semantic consumer discovery throws.
3. `safeConsumerMap` converts the error to an empty semantic map.
4. Source fallback may also throw and be converted to an empty map, or it may lack the relationship semantic resolution would have found.
5. The definition is processed with zero enrichment consumers.
6. A downstream check can miss a writer, caller, incomplete migration, or new-dead counterexample.
7. A full JSON diff-gate result can still claim complete coverage and no omitted findings.

**Attempted refutation:**

- The stderr warning is useful for a human watching the process. It is not part of the structured result, is not preserved by every embedding, and cannot downgrade `coverage.complete`.
- `diff-impact` itself declares bounded coverage, which limits the strength of its direct output. `diff-gate --full` independently promotes its final finding coverage to complete.
- Catching the enrichment error is reasonable for availability. Returning an ordinary empty proof is not required to preserve availability; a degraded result can continue while remaining explicit.

**Recommended design:**

- Replace `safeConsumerMap` with a result that carries both data and status:

```ts
type EvidenceTierResult<T> =
  | { kind: 'complete'; value: T }
  | { kind: 'failed'; value: T; reason: string };
```

- Propagate failed tier identities into `DiffImpactPartial`, `DiffImpactResult`, and `DiffGateResult`.
- A gate may continue running, but its invocation coverage cannot be `complete: true` when a required tier failed.
- Decide per check whether the correct action is fail-closed, skip-with-reason, or advisory degradation. Encode that decision in the check result rather than in `console.error`.
- Preserve the warning for humans as a rendering of the structured degradation.

**Required tests:**

- Inject a semantic consumer failure and prove the result contains a failed semantic tier.
- Inject a source-fallback failure and prove the same.
- `diff-gate --full --json` must not report complete coverage after either failure.
- A check whose correctness requires the failed tier must fail closed or appear in `skipped` with the exact reason.
- Successful empty maps remain distinguishable as completed evidence.

**Acceptance condition:** no gate pass or complete-coverage claim can be derived from an evidence exception represented as “found nothing.”

---

### DBC-04 — High — Base-content lookup conflates file absence with Git and base-resolution failure

**Evidence:** runtime-confirmed; complete SCIP reference sets; missing failure-path test.

**Contract:**

`BaseContentReader` returns source text or `null`. For callers to treat `null` as “this file is new,” the supplier must reserve `null` for genuine path absence at a successfully resolved base. Invalid base, unavailable Git, timeout, malformed batch output, permission failure, and repository failure are operational failures, not file absence.

**Code and SCIP relationships:**

- `src/queries/impact/diff-impact.ts:308-315` wraps both `resolveGitCommit(projectRoot, base)` and file retrieval in one `try`.
- Its catch returns `null` for every error.
- `fileContentAtResolvedBase` at lines 317-331 also converts every `git show` failure to `null`, not only a missing path.
- `fileContentsAtBase` at lines 356-381 catches any batch-resolution, execution, timeout, buffer, or parse failure and falls back to per-file calls that retain the same ambiguity.
- The complete SCIP reference set for `fileContentAtBase` contains three uses in `diff-impact.ts`, including base-content reading and source-move similarity.
- The complete SCIP reference set for `createBaseContentReader` contains five uses across `diff-gate.ts` and `incomplete-migration.ts`.
- `src/queries/impact/diff-gate.ts:1269-1277` uses that reader for symbol-preexistence decisions.

**Runtime probe:**

Calling the audited built helper with a guaranteed-invalid base returned:

```json
{"invalidBaseResult":null}
```

It did not throw or return an unavailable state.

**Consequences:**

- A helper that did exist at the intended base can be classified as new when base resolution failed.
- Incomplete-migration and recent-helper checks can compare against a fabricated absence.
- Source-move similarity can fall back to an empty string and lower similarity for operational reasons.
- A Git outage becomes semantically indistinguishable from evidence that the requested path was absent.

**Attempted refutation:**

- `diffImpactPlan` separately turns an invalid base into `GIT_DIFF_UNAVAILABLE_NOTE`, and diff-gate fails closed when no diff can be computed. That protects the initial plan path.
- It does not make the lower-level exported helpers honest, and later per-file Git reads can fail after the plan was created.
- The helper is a published package subpath through `scip-query/queries/diff-impact`, so library callers can invoke it independently.
- Existing incomplete-migration tests exercise normal `HEAD` reads. No test gives `createBaseContentReader` an invalid base or injected Git failure.

**Recommended design:**

- Resolve the base exactly once before constructing the reader.
- Use an explicit result:

```ts
type BaseFileContent =
  | { kind: 'present'; content: string }
  | { kind: 'absent' }
  | { kind: 'unavailable'; reason: string };
```

- If preserving the current callback shape is necessary for compatibility, add a strict result-returning API and make the legacy `string | null` wrapper throw on `unavailable`.
- Distinguish Git's missing-object/path response from timeout, invalid ref, executable failure, permission failure, and malformed batch output.
- Bind the reader to the resolved commit identity so repeated reads cannot drift.

**Required tests:**

- Existing file, absent file, invalid base, Git unavailable, timeout, and malformed batch output each produce a distinct expected outcome.
- Batch fallback preserves operational failure instead of turning every requested path into absence.
- Incomplete-migration and diff-gate fail closed or skip explicitly when historical content is unavailable.
- The public compatibility wrapper's exact behavior is documented and API-snapshotted.

**Acceptance condition:** `null` or `absent` can never be produced merely because Git or base resolution failed.

---

### DBC-05 — Medium — Invocation coverage validation accepts “complete” output with omitted results

**Evidence:** runtime-confirmed; type-system-confirmed; contract hardening gap.

**Contract:**

`complete: true` means the invocation returned the whole answer. Therefore `totalKnown` must be true, `total` must equal `returned`, `omitted` must be zero, and no result continuation can remain.

**Code:**

- `InvocationCoverage` at `src/runtime/command-kit/command-descriptor-types.ts:66-84` encodes completeness, known-total state, totals, omissions, omitted identities, and continuation as independently combinable fields.
- `validateInvocationCoverage` at `src/runtime/command-kit/command-execution.ts:377-412` correctly checks nonnegative counts, `total - returned === omitted`, unknown totals, omitted-identity count, and resolution candidate counts.
- It checks only that a complete result knows its total. It does not require zero omissions or forbid a continuation.

**Runtime probe:**

The audited validator accepted this value without throwing:

```ts
{
  complete: true,
  totalKnown: true,
  returned: 3,
  total: 7,
  omitted: 4
}
```

The current hand-written producers found during the audit construct internally consistent complete results. The defect is in the central enforcement boundary and therefore permits a future or embedded producer to publish a false completeness claim.

**Type probe:**

The same contradictory value compiled without diagnostics.

**Existing tests:**

- `tests/runtime/cli-contract.test.ts:420-433` rejects an incorrect subtraction and an omitted-identity count mismatch.
- It does not test complete-with-omissions, complete-with-continuation, or false-complete with returned equal to total.

**Recommended design:**

- Make known completeness a discriminated union, for example:

```ts
type InvocationCoverage =
  | { complete: true; totalKnown: true; returned: number; total: number; omitted: 0; continuation?: never }
  | {
      complete: false;
      totalKnown: true;
      returned: number;
      total: number;
      omitted: number;
      continuation?: ResultContinuation;
    }
  | { complete: false | null; totalKnown: false; returned: number; continuation?: ResultContinuation };
```

- Keep runtime validation because JSON and JavaScript callers are not protected by TypeScript.
- Validate `complete === true ⇒ total === returned ∧ omitted === 0 ∧ continuation === undefined`.
- Decide and document whether `complete: false`, known total, and zero omitted is meaningful. Reject it if no such state exists.

**Required tests:**

- Reject complete with positive omissions.
- Reject complete with a continuation.
- Reject complete with unequal `total` and `returned`.
- Accept every legitimate union member.
- Compile-time tests use `@ts-expect-error` for contradictory combinations.

**Acceptance condition:** neither TypeScript nor runtime validation accepts a complete result that omits any result unit or advertises continuation.

---

### DBC-06 — Medium — `ScipDatabase` cannot fully enforce its connection-and-lease lifecycle invariant

**Evidence:** source-confirmed ordering; complete public export path; missing failure-path tests.

**Contract:**

A constructed `ScipDatabase` owns one opened SQLite connection and one immutable-generation reader lease. Construction either publishes a fully initialized wrapper or releases both resources. After publication, only the wrapper's `close()` ends that ownership, and it releases both exactly once.

**Initialization leak:**

- `src/storage/db.ts:63-66` opens the published generation, assigns the connection and generation, and records `opened.release` in a `WeakMap`.
- Five `pragma` calls at lines 67-71 occur outside the cleanup `try`.
- If any pragma throws, construction aborts before returning an object. The caller has no object on which to call `close()`, while the connection and generation-reader lease remain open.
- The catch at lines 72-79 protects only `assertSafeIndexedDocumentPaths`.
- Even in that catch, `this.db.close()` is not inside a `finally`; if close itself throws, `opened.release()` is skipped.

**Ownership bypass:**

- `src/storage/db.ts:52` exposes `readonly db: Database.Database`.
- `readonly` prevents property reassignment; it does not remove mutating methods such as `close()` and `pragma()`.
- `src/index.ts:3` exports `ScipDatabase` from the package root.
- A library caller can invoke `wrapper.db.close()` directly. That bypasses the wrapper's generation-reader release and leaves its cached statements and lifecycle map inconsistent.
- The complete SCIP reference result for the wrapper shows broad internal use, and the `db` handle is used directly throughout query/storage modules. No public read-only port separates internal SQL access from lifecycle control.

**Attempted refutation:**

- The configured pragmas normally succeed. A constructor's rollback obligation applies precisely to abnormal initialization; rarity does not restore ownership.
- The `WeakMap` prevents outside code from directly stealing the release callback. It also means a caller that closed only the raw connection cannot repair the lease.
- Calling `ScipDatabase.close()` later may release the lease after a raw close, depending on the driver's double-close behavior, but the invariant has already been bypassed and close may throw before the `finally`.

**Recommended design:**

- Enclose every operation after `openPublishedGeneration` in one initialization `try`.
- On failure, close the connection and release the generation reader through nested `try/finally`, guaranteeing release even if close throws.
- Keep the raw driver connection private.
- Expose a narrow read/query port that provides `all`, `get`, and any required prepared-read behavior but omits connection close and mutable pragmas.
- If internal modules need raw prepared statements, use a non-exported internal accessor or split public facade from internal storage implementation.

**Required tests:**

- Inject failure at each pragma and at indexed-path validation; assert connection close and generation release each occur once.
- Inject connection-close failure; assert generation release still occurs.
- Compile-time public API test proves consumers cannot call `db.close()` or mutate pragmas through `ScipDatabase`.
- Wrapper `close()` remains idempotent and releases the lease exactly once.

**Acceptance condition:** every failed construction rolls back both resources, and no package consumer can end or mutate the owned connection outside the wrapper lifecycle.

---

### DBC-07 — Medium — Core protocol states are Booleans plus optionals, so impossible states compile

**Evidence:** type-system-confirmed; current producer inspection; partial runtime guards.

**Contract:**

When one field selects a protocol state, the fields required by that state must be required by the type. A consumer should not need casts, fallback error strings, or repeated optional checks to recover the state that the producer already knew.

**Confirmed examples:**

1. `CliOutputPageEnvelopeV1` in `src/runtime/output-pagination.ts:111-133`
   - `page.complete` is Boolean and `continuation` is optional.
   - The type permits an incomplete page with no continuation and a complete page with one.
   - The audited producer at lines 261-299 constructs the relationship correctly.

2. `WorkerLaneResponse<Result, Status>` in `src/runtime/worker-request-lane.ts:15-21`
   - `ok` is Boolean; `result` and `error` are both optional.
   - The type permits success without a result, failure without an error, or both fields together.
   - The process-boundary guard rejects some invalid combinations, but the consumer still uses `value.result as Result` and a fallback error because the type cannot narrow.

3. `WatchServiceLoopIterationResult` in `src/runtime/watch-server.ts:60-67`
   - `stopped` selects whether `delayMs` exists.
   - The type permits `stopped: false` without a delay and `stopped: true` with one.

4. `WatchServiceStopResult` in `src/runtime/watch-service.ts:177-180`
   - Actual producers return `{ disposition: 'stopped', pid }` or `{ disposition: 'already-stopped' }`.
   - The type permits an already-stopped result with a PID and a stopped result without one.

5. `ProcessFileLockObservation` in `src/platform/process-file-lock.ts:42-49`
   - Actual readers return a valid observation with `raw`, `identity`, `record`, `owner`, and `parsed`; a missing observation contains none.
   - The interface permits `{ state: 'valid' }` with no record or owner.

6. `SemanticAvailability` in `src/semantic/types.ts:5-12`
   - `available` is Boolean while failure reason and dependency state are optional.
   - The type permits unavailable-without-reason and available-with-failure-reason. Rust resolution interfaces repeat the shape.

**Type probe:**

An in-memory `ts-morph` project constructed seven contradictory values:

- complete invocation coverage with four omissions;
- incomplete output page without continuation;
- successful Worker response containing only an error;
- running watch-loop result without a delay;
- already-stopped result with a PID;
- valid lock observation without a record;
- unavailable semantic provider without a reason.

The audited `tsconfig.json` produced **zero diagnostics**.

**Consequences:**

- New producers can accidentally create invalid wire or lifecycle states without a compiler error.
- Consumers add casts and defaults that can hide producer defects.
- Runtime validation is duplicated and uneven: Worker messages have a guard, output pages rely on the producer, and internal watch results rely on convention.
- Contract changes become harder because optional fields do not reveal which state owns them.

**Recommended design:**

- Convert each state machine to a discriminated union using its existing state field.
- Keep wire decoders at process/filesystem boundaries; a TypeScript union is not validation of untrusted JSON.
- Return decoded union values internally so downstream code receives compile-time narrowing.
- Preserve schema version and JSON field compatibility where required. A stricter TypeScript declaration can often be shipped without changing valid serialized output.

**Required tests:**

- Compile-time `@ts-expect-error` cases for every invalid combination.
- Decoder tests reject every invalid wire combination.
- Producer tests assert each valid variant.
- Public declaration snapshot verifies the stricter unions.

**Acceptance condition:** every state-dependent field is required in the state that owns it and forbidden in states where it has no meaning.

---

### DBC-08 — Medium — `methods` turns ordinary symbol-resolution outcomes into untyped exceptions and breaks JSON-mode output

**Evidence:** runtime-confirmed; complete SCIP reference set; existing tests confirm exception behavior.

**Contract:**

Looking up a user-supplied symbol normally has three outcomes: exactly one match, no match, or multiple matches. Missing and ambiguous are ordinary resolution alternatives because the caller cannot establish uniqueness without performing the resolver's work. A public query should represent those alternatives in a stable result or typed error contract.

**Code and public surface:**

- `src/queries/navigation/methods.ts:15-27` declares `methods(...): MethodResult[]`.
- Missing resolution throws a generic `Error`.
- Ambiguous resolution throws another generic `Error` with candidates embedded only in prose.
- `src/queries/index.ts` exports `methods`.
- The package publishes `scip-query/queries`, `scip-query/queries/index`, and `scip-query/queries/methods`.
- The complete SCIP reference set contains the query index and CLI navigation handler.
- The CLI descriptor says ambiguity and missing targets fail explicitly, but the TypeScript return type communicates neither outcome.

**Runtime behavior:**

- Direct invocation of the audited built library threw:

```json
{"threw":"No class definition matched 'definitely-not-a-real-class-dbc-probe'."}
```

- Invoking the audited local CLI with `methods ... --json` exited 1 and wrote only:

```text
error: No class definition matched 'definitely-not-a-real-class-dbc-probe'.
```

The command selected JSON mode but did not return a JSON error envelope.

**Existing tests:**

- `tests/queries/navigation/queries.test.ts:300-304` explicitly expects generic throws for ambiguity and missing resolution.
- The focused suite therefore protects the current behavior rather than the more expressive contract.

**Recommended design:**

- Add an explicit resolution API:

```ts
type MethodsResolution =
  | { kind: 'matched'; methods: MethodResult[]; owner: ResolvedSymbol }
  | { kind: 'missing'; suggestions: SymbolCandidate[] }
  | { kind: 'ambiguous'; candidates: SymbolCandidate[] };
```

- Render missing and ambiguous variants as user-facing errors in human mode.
- In JSON mode, return a versioned JSON envelope containing the variant and a stable nonzero exit code if command semantics require failure.
- For API compatibility, add `resolveMethods` first, migrate the CLI, then deprecate the throwing `methods` wrapper rather than silently changing its return type.
- If exceptions remain, use exported typed error classes with structured candidate fields; a result union is still preferable for routine selection outcomes.

**Required tests:**

- Library tests cover all three variants without parsing error text.
- JSON CLI tests parse missing and ambiguous output as valid JSON and assert stable fields.
- Human CLI tests retain concise remediation.
- API snapshot records the additive migration and eventual deprecation.

**Acceptance condition:** callers can distinguish matched, missing, and ambiguous outcomes without catching `Error` or parsing prose.

---

### DBC-09 — Low — Published helpers accept adjacent semantically distinct primitive arguments

**Evidence:** public declaration inspection; type-level transposition hazard.

**Contract:**

When adjacent parameters have the same primitive type but different semantic roles, a caller can swap them without a compiler error. Public boundaries should group those roles into named fields or distinct validated types when a swap changes the operation rather than merely its ordering.

**Strongest examples in published declarations:**

- `twinAb(db, refA: string, refB: string, outFile: string)` in `src/queries/cleanup/twin-ab.ts:73`
  - `refA` and `refB` are intentionally symmetric.
  - `refB` and `outFile` are not. Swapping them makes symbol resolution consume a path and test rendering consume a symbol reference.
- `fileContentAtBase(projectRoot: string, base: string, relativePath: string)` and `fileContentsAtBase(...)` in `src/queries/impact/diff-impact.ts`
  - all three roles are distinct and published from `scip-query/queries/diff-impact`.
- `symbolPreexistenceChecker(projectRoot: string, base: string, ...)` in `src/queries/impact/diff-gate.ts`.
- `pathMatchesGlob(pattern: string, relativePath: string)` in `src/queries/navigation/files.ts`.

Symmetric pairs such as `coupling(file1, file2)`, `convergence(symbolA, symbolB)`, and the first two `twinAb` references are not findings merely because their types match.

**Recommended design:**

- Prefer named option objects at package boundaries:

```ts
twinAb(db, { refA, refB, outFile });
fileContentAtBase({ projectRoot, base, relativePath });
pathMatchesGlob({ pattern, relativePath });
```

- Use branded/validated types only where values have a reusable invariant, such as resolved Git commit, project-relative path, or absolute output path.
- Introduce overloads or additive `V2` helpers, migrate internal callers, and deprecate positional signatures to avoid an abrupt public break.

**Required tests:**

- Public type tests demonstrate named-field use.
- Runtime validation rejects a non-absolute `outFile` if absolute path remains part of the `twinAb` precondition.
- API snapshots preserve the compatibility plan.

**Acceptance condition:** semantically different path, symbol, pattern, and revision values cannot be transposed at the primary public API without TypeScript identifying the mistake or a boundary validator rejecting it.

---

## 5. Substitutability review

The implementation inventory found:

- `RustAnalyzerSessionResolver` implements `RustReferenceResolver`, `RustCalleeResolver`, `RustSignatureResolver`, and `RustImportDefinitionResolver`;
- `TsMorphSemanticProvider` implements `SemanticProvider`;
- `TsServerSemanticProvider` implements `SemanticProvider`.

No confirmed strengthened precondition or weakened postcondition was found in those implementations.

In particular:

- Rust resolution helpers complete requested definition maps even when a lower evidence tier returns no rows.
- TypeScript provider bulk methods initialize entries for the requested definitions.
- Availability degradation is recorded by providers rather than thrown through every query.

The remaining concern is representational rather than substitutive: `available: boolean` plus optional fields does not make the interface's success and failure variants explicit. DBC-07 addresses that shared contract without alleging that one current provider violates another's behavior.

The inheritance inventory is mostly typed `Error` subclasses. `DiffGateDetectorTimeoutError` extends `IsolatedProcessTimeoutError`; no override was found that accepts fewer inputs or promises less than its base type.

---

## 6. Test assessment

Focused existing suite:

```text
6 test files passed
104 tests passed
```

Files:

- `tests/runtime/worker-request-lane.test.ts`
- `tests/runtime/cli-contract.test.ts`
- `tests/runtime/output-pagination.test.ts`
- `tests/queries/navigation/queries.test.ts`
- `tests/queries/impact/incomplete-migration.test.ts`
- `tests/queries/cleanup/cleanup-plan.test.ts`

`scip-query test-quality --full` reported no assertion-free, skipped, or mock-echo candidates in the three directly scoped test files checked. Its coverage contract was unknown, so that heuristic result is not evidence that the tests are complete.

The passing suite is consistent with the findings because the missing obligations are specific:

| Finding | Existing positive-path coverage | Missing contract test |
| --- | --- | --- |
| DBC-01 | duplicate response, timeout, close, Worker termination failure | completion/rejection settlement callback throws |
| DBC-02 | known dirty overlap blocks; explicit allow-dirty | Git status unavailable must fail closed |
| DBC-03 | normal consumer enrichment | semantic/source tier throws and structured coverage downgrades |
| DBC-04 | normal `HEAD` historical reads | invalid base, Git failure, timeout, malformed batch |
| DBC-05 | arithmetic mismatch and omitted-identity mismatch rejected | complete with omissions or continuation rejected |
| DBC-06 | ordinary wrapper close throughout fixtures | pragma/validation/close failure rollback; raw handle inaccessible |
| DBC-07 | valid producer variants | compile-time invalid variants and decoder rejection |
| DBC-08 | generic exceptions expected | structured library and JSON variants |
| DBC-09 | ordinary positional calls | named API and boundary validation |

---

## 7. Recommended remediation slices

Each slice should land with its tests and documentation. The ordering reflects risk and dependency, not merely finding number.

### Slice 1 — Make mailbox settlement an owned state

Fix DBC-01. This is the only finding that can leave durable work wedged behind a live owner while continuing to accept new work. Add completion and rejection failure tests before changing control flow.

### Slice 2 — Make cleanup dirty inspection fail closed

Fix DBC-02. Introduce `known | unavailable` inspection state and inject the Git runner. Update cleanup verification rendering and any setup/skill language that currently implies dirty overlap is always known.

### Slice 3 — Preserve evidence-tier failure through diff impact and diff gate

Fix DBC-03. Add structured tier status first, then make full-gate coverage derive from it. Decide per check whether degradation blocks or skips. Update JSON documentation because this changes the evidence contract.

### Slice 4 — Separate historical absence from Git failure

Fix DBC-04. Resolve the base once, add an explicit base-content result, migrate incomplete-migration and diff-gate, and preserve compatibility with a deprecated wrapper if necessary.

### Slice 5 — Close the invocation-coverage algebra

Fix DBC-05 and the `InvocationCoverage` part of DBC-07 together. Strengthen both TypeScript and runtime validation. This is a narrow change but must be checked against every custom coverage producer.

### Slice 6 — Convert process and transport protocols to discriminated unions

Finish DBC-07 for output pages, Worker responses, watch-loop results, stop results, process-lock observations, and semantic availability. Keep wire compatibility; add decoders where untrusted data crosses a boundary.

### Slice 7 — Close `ScipDatabase` lifecycle ownership

Fix DBC-06. Roll back every constructor failure, make raw connection access internal, and migrate the 42 current direct internal SQL-access sites through an internal port or accessor. Because `ScipDatabase` is exported from the package root, run the public API snapshot and document compatibility.

### Slice 8 — Add structured methods resolution

Fix DBC-08 additively. Move the CLI to the new union, provide valid JSON failures, then deprecate the old throwing wrapper.

### Slice 9 — Migrate high-risk positional APIs

Fix DBC-09, beginning with `twinAb` and the base-content family. Do not mechanically convert symmetric pairs.

---

## 8. Global acceptance criteria

The design-by-contract remediation is complete when:

1. every accepted mailbox request remains owned until durable settlement or explicit reclaimability;
2. safety and evidence inspections represent failure as failure, never as an empty proof;
3. a complete coverage claim is impossible when any result is omitted or any required evidence tier failed;
4. historical file absence is distinguishable from Git unavailability;
5. all construction failures release every acquired database resource;
6. protocol states require exactly the fields their state tag implies;
7. ordinary symbol-resolution alternatives are machine-readable in both library and JSON CLI use;
8. public, semantically distinct primitive parameters have named roles;
9. the focused tests above pass together with new negative-path and compile-time contract tests;
10. `scip-query diff-gate` either passes or every accepted finding is recorded with a reason.

---

## 9. Verification of this review

Environment:

- `scip-query doctor`: OK; index fresh; TypeScript and Rust indexing, semantic providers, cleanup detectors, cleanup verification, and Git diff gate available.
- The previously established fresh SCIP generation remained valid because this review changed documentation only.

Diff:

- `scip-query diff-impact --json`: one changed file, this review; zero changed symbols and zero affected consumers; the document is not part of the code index.
- `git diff --name-only`: only `docs/reviews/2026-07-27-design-by-contract-audit.md`.
- `git diff --check`: passed.

Postchecks:

- `scip-query co-change docs/reviews/2026-07-27-design-by-contract-audit.md --json --full`: available; 585 commits analyzed; no findings.
- `scip-query doc-drift --json --full`: all 337,383 rendered characters were retrieved through 29 transport pages. The command returned 87 repository-wide heuristic candidates with unknown completeness; that existing broad documentation backlog was not treated as evidence for or against the new source-grounded findings.

Gate:

- `scip-query diff-gate --json`: PASS; nine checks ran; zero blocking or advisory findings. Coverage was bounded by the large-index default analysis budget.

Focused tests:

- six test files passed;
- 104 tests passed;
- no focused test failed.

Refutation attempts:

1. **Settlement may fail but perhaps admission remains closed.** A runtime probe made the completion callback throw. It broke the proposed refutation: the fatal error was recorded and admission reopened. This became DBC-01.
2. **The coverage validator may already reject complete-with-omissions.** A runtime probe passed `complete: true`, `returned: 3`, `total: 7`, and `omitted: 4`. It broke the proposed refutation: the value was accepted. This became DBC-05.
3. **The invalid protocol examples may be rejected by TypeScript.** Seven invalid values were compiled in memory against the repository `tsconfig`; zero diagnostics were produced. This became DBC-07.
4. **The review's source citations may have drifted while it was written.** A final checker resolved 24 unique `src/**` or `tests/**` line citations; every file existed and every cited line was within the current file.
5. **The finding count or tracked scope may not match the summary.** A final checker found sequential DBC-01 through DBC-09 headings, exactly four high, four medium, and one low; Git showed only this review as untracked.

No production behavior was changed by this audit. The only tracked change is this review document.

---

## 10. Remediation closure

The nine findings are closed. Here, “closed” means the violated boundary now
represents every relevant outcome, rejects or safely contains invalid states,
and has a negative-path test that would fail if the original defect returned.

| Finding | Resolution | Verification evidence |
| --- | --- | --- |
| DBC-01 | Mailbox claims remain the live owner's responsibility until completion or rejection is durably written. Settlement failure closes the lane, retains ownership for shutdown, and stops the watcher loop. | Worker settlement-throw tests, TypeScript mailbox tests, watcher fatal-stop tests; commit `f6ec5f3e`. |
| DBC-02 | Worktree inspection returns `known` or `unavailable`. Cleanup fails closed—refuses to claim safety without the required observation—unless `allowUnknownWorkingTree` is explicitly selected. | Nonzero, timeout, signal, and overflow tests plus cleanup rendering tests; commit `7ddb6909`. |
| DBC-03 | Consumer discovery carries a status for each semantic and source-fallback tier. Any failed required tier survives partial merging and makes diff-gate fail closed. | Tier-failure, partial-merge, JSON, CLI, and gate tests; commits `3261d9af` and `5ebe9503`. |
| DBC-04 | Historical lookup returns `present`, `absent`, or `unavailable`; the nullable compatibility wrappers throw rather than convert operational failure into absence. | Invalid-base, Git-failure, malformed-batch, incomplete-migration, and gate tests; commit `df5b54b5`. |
| DBC-05 | Coverage is a discriminated union for complete, bounded incomplete, and unknown results. Runtime validation enforces totals, omissions, identities, and continuations. | Compile-time invalid-state fixture, CLI contract tests, and descriptor registry gate; commit `32f0a845`. |
| DBC-06 | Database construction releases every acquired resource on failure, close is idempotent, and supported consumers receive a query-only port rather than lifecycle-capable raw connection access. | Constructor rollback, lease, close, pragma, validation, and public-consumer tests; commit `ec90abc6`. |
| DBC-07 | Core protocols are tagged unions and untrusted JSON is decoded according to the selected state. Impossible success/error and stopped/continued combinations no longer compile or decode. | Ten focused protocol files, 127 tests, compile-time fixture, API check, and full suite; commit `a13867e0`. |
| DBC-08 | Method lookup reports `matched`, `missing`, or `ambiguous` as structured data. The CLI emits valid JSON for every JSON-mode outcome and uses nonzero status for nonmatches. | Library resolution and human/JSON CLI tests; commit `32c5726e`. |
| DBC-09 | Named option objects are the primary public APIs for role-sensitive arguments; path roles are validated, internal callers use named forms, and source-compatible positional overloads are deprecated. | Six focused files, 104 tests, public compile fixture, API snapshot, complete reference checks, and boundary-refutation tests; commit `4607cc66`. |

### Closure defects found by the full suite

The first complete-suite run failed 14 outcome-ledger tests because their
hand-built `DiffGateResult` fixture predated the required evidence-tier field.
The production result builder already supplied the field, but the public
runtime predicate dereferenced malformed legacy input and threw. The closure
repair now treats absent evidence status as a gate failure, adds a direct
regression test, and gives the fixture two explicit complete tiers.

The same run found a mailbox-retention test whose simulated `nowMs` was
compared with files carrying the machine's real modification time. Once the
calendar moved beyond the test's fixed cleanup date, logically old files
looked new. The test now assigns the simulated creation time to every retained
response and dead-letter file before advancing its clock.

### Whole-repository verification

Exact commands and outcomes:

```text
npx vitest run tests/runtime/diff-gate-outcomes.test.ts \
  tests/queries/impact/diff-gate-fail-closed.test.ts \
  tests/storage/bounded-mailbox.test.ts
  -> 3 files passed; 26 tests passed

npm test
  -> 256 files passed; 2,008 tests passed

npm run lint
  -> Prettier passed
  -> ESLint passed
  -> package build passed
  -> public TypeScript API matches d85979e8ebbe2047 (72 paths)
  -> external public-consumer fixture passed
  -> skill-link validation passed

cargo check --quiet --manifest-path Cargo.toml
  -> passed
```

The final SCIP whole-series check used the commit immediately before the plan,
`8745d26d`, as its base so committed slices were not hidden by the ordinary
`HEAD` comparison:

```text
scip-query diff-impact --base 8745d26d --json
  -> 36 indexed files changed
  -> 200 indexed symbols changed
  -> 180 affected consumer files
  -> both required evidence tiers complete
  -> command coverage unknown; all 94,850 rendered characters retrieved in 8 pages

scip-query diff-gate --base 8745d26d --full --json --compact
  -> 9 checks ran; 0 skipped
  -> complete finding coverage: 6 of 6 unsuppressed findings returned
  -> 3 existing structured suppressions matched
  -> 1 blocking co-change signal and 5 advisory document signals
  -> all 37,423 rendered characters retrieved in 4 pages
```

The sole blocking signal, `SQ81C85F3058D3`, says
`lsp-batch-worker.ts` historically co-changes with
`lsp-session-worker.ts`. It is accepted for this change, without a permanent
suppression. The batch worker changed only
`RustReferenceWorkerResponse` from a Boolean-plus-optional interface to its
equivalent strict `SemanticAvailabilityState` intersection. A complete
reference query found the session worker at three consumer sites; it already
imports and produces that shared response type. TypeScript, the protocol
fixture, Rust session tests, the public API check, and the 2,008-test full
suite all compiled or exercised the consumer. Editing the session worker to
manufacture a symmetric diff would not repair a contract, while permanently
suppressing the file pair would hide a later real one-sided change.

The five advisory document signals were reread and remain accurate:

- `docs/COMMAND_REFERENCE.md` describes the co-change command's budget
  boundary; the edited impact handler changed incomplete-migration and
  diff-gate failure reporting, not that budget;
- `docs/analyzer-inventory.md` and
  `docs/analyzer-validation-ledger.md` say `diffGate()` and
  `DIFF_GATE_CHECKS` own the default gate family; both symbols and the family
  remain there;
- `docs/architecture/evidence-cache-invalidation.md` describes cache
  ownership and invalidation. The relevant source edits added a failed-tier
  CLI warning and tightened a capability type; neither changed a cache key,
  payload owner, or staleness rule;
- `docs/architecture/scip-query-target-architecture.md` describes the
  TypeScript semantic mailbox's immutable generation identity. The remote
  provider now validates availability through the shared decoder, while its
  generation identity and operation key are unchanged.

The three matched structured suppressions were also rechecked. They cover a
type-only watch-service stop-result change, an untouched semantic-prewarm
anchor, and semantic protocol changes that do not alter the Rust performance
ledger's session or cache behavior. Suppression-record compatibility was
complete: all 42 repository records were accepted.
