# Diff-gate runtime containment

Date: 2026-07-26
Status: implemented and verified

## Problem

Three `scip-query diff-gate --json` processes in Vega remained alive after their
calling UI no longer showed active commands. Each process consumed roughly one
CPU core for 21–22 minutes and retained 1.4–2.2 GB. A process sample showed the
main JavaScript thread repeatedly executing regular-expression tests.

A fresh gate on the same 28-line Vega diff completes in about 1.7 seconds, and
each detector completes in isolation within about 2.2 seconds. Debug evidence
then exposed the hidden multiplier: outcome reconciliation had 62 historical
comparison bases and could synchronously call the complete gate once for every
base. Three overlapping callers could therefore perform as many as 189 gate
evaluations without any foreground output.

The historical replay loop entered in commit `dc197340` on 2026-07-14. The
2026-07-25/26 output-integrity, record-versioning, and pagination work did not
introduce the loop. The recent record work made committed history more explicit;
continued normal use also increased the number of distinct historical bases, so
the pre-existing unbounded algorithm became progressively more expensive.

## Essential concepts

A **foreground diff gate** is a repository-policy analysis started by a user,
agent, or stop hook whose distinguishing responsibility is to return one
pass/fail judgment about the current working-tree diff. Historical metrics are
secondary bookkeeping and must not multiply that foreground judgment without a
visible bound.

A **historical outcome replay** is a retrospective gate evaluation against an
older comparison commit whose distinguishing purpose is to decide whether a
previously reported finding was actually fixed. It improves effectiveness
records; it does not change the current diff’s pass/fail decision.

A **single-flight lease** is a process-owned filesystem lock whose distinguishing
property is that, for one project, only one process may spend CPU on a diff gate
at a time. A live owner causes later callers to fail quickly with its PID; a dead
owner is reclaimed using the existing process-identity protocol.

A **runtime deadline** is an enforced upper limit on one foreground evaluation
whose distinguishing property is independent ownership: the gate runs in a
child process, while its parent remains able to terminate and reap that child
even if the child’s JavaScript thread never yields.

## Facts and premises

1. The primary Vega gate is currently fast; the observed 21-minute duration is
   not proportional to the current diff.
2. `recordDiffGateOutcomes` groups missing findings by historical base and
   currently replays every group on a clean worktree.
3. Vega currently supplies 62 such groups.
4. The CLI and `hook-stop` paths both call the same outcome reconciliation.
5. Same-process timers cannot interrupt a synchronous CPU-bound JavaScript loop.
6. The repository already has:
   - a token-owned, process-identity-aware lock with dead-owner reclamation;
   - an isolated-analysis subprocess protocol;
   - a bounded child-process runner that terminates, escalates, drains output,
     and waits for the child to be reaped.
7. A missing or timed-out retrospective replay must leave its finding open. It
   must never manufacture a resolution.
8. A timed-out current gate must fail closed because it did not finish judging
   the diff.

## Invariants

1. At most one foreground diff-gate process may run per project cache.
2. Every CLI and installed stop-hook gate has a finite wall-clock deadline.
3. A timed-out child is terminated and reaped before the parent reports failure.
4. One foreground gate may replay at most one historical comparison base.
5. A replay runs only the detectors required by the findings anchored to that
   base.
6. Findings belonging to deferred bases remain open and a bounded-work warning
   reports how many bases and findings were retained.
7. The current diff result and its exit status do not depend on whether
   retrospective bookkeeping completes.
8. Lock ownership is token-checked on release and dead owners are reclaimable;
   one process cannot release another process’s lease.
9. Ordinary successful CLI JSON and human output retain their existing schema
   and pass/fail semantics.
10. `--hook` and `hook-stop` convert timeout or contention into explicit
    fail-closed feedback rather than silently allowing completion.
11. No implementation change touches `skills/**`; concurrently authored skill
    changes remain intact.

## Reuse and ownership

- Reuse `tryAcquireProcessFileLock` for single-flight exclusion. Do not invent a
  second lock format.
- Reuse `runIsolatedJsonProcess` and its existing timeout/reaping behavior. Do
  not add an in-process watchdog that cannot preserve hook exit semantics.
- Reuse the private isolated-analysis envelope for the child result.
- Keep policy evaluation in `queries.diffGate`; the runtime layer owns
  isolation, deadlines, locks, and outcome bookkeeping.
- Keep outcome truth in the existing SQLite/event ledgers. Deferred work is
  represented by retaining open keys, not a second cache or shadow ledger.

## Slices

### Slice 1 — Bound retrospective work

- Add a default replay budget of one historical base per foreground gate.
- Choose the base deterministically from the current commit and sorted
  candidates so successive commits distribute verification rather than always
  starving older groups.
- Pass the exact set of required checks to the replay callback.
- Skip every unrelated detector and enable the baseline detector only when it
  is required.
- Retain every deferred finding key and emit exact replay/deferred counts.

Tests:

- Multiple historical bases result in one replay.
- The replay callback receives only the needed detector names.
- Deferred records remain open.
- The warning reports replayed bases, deferred bases, and retained findings.
- A replay exception leaves that group open.

### Slice 2 — Isolate and time-bound the foreground gate

- Add a private `__diff-gate-run` command that executes current analysis plus
  outcome recording and returns the existing private analysis envelope.
- Make the public `diff-gate` command invoke that child with a finite timeout.
- Use a 60-second default for bounded mode and a 180-second default for
  `--full`; allow a validated environment override for exceptional repos while
  retaining a finite upper bound.
- On timeout, report the deadline and fail closed (`1`, or `2` in legacy
  `--hook` mode).

Tests:

- The isolated runner returns a valid result.
- A non-yielding child is killed and reaped at its deadline.
- Timeout messages do not masquerade as a passing gate.
- Normal JSON output remains compatible.

### Slice 3 — Single-flight exclusion

- Acquire `<cacheDir>/runtime/diff-gate.lock` before spawning the child.
- On contention, do not spawn another child; report the live owner PID and
  start time when known.
- Always release the lease after success or handled failure.
- Rely on the existing process-identity protocol to reclaim abandoned owners.

Tests:

- A second caller cannot enter while a live owner holds the lease.
- The protected function is never called under contention.
- The lease is released after success and exceptions.
- A stale attributable owner is reclaimed (covered by the shared lock contract,
  plus one integration assertion at the gate boundary).

### Slice 4 — Hook parity

- Route `hook-stop` through the same isolated, single-flight execution path.
- Preserve re-entry suppression and no-workspace/no-index behavior.
- Render timeout/contention as explicit stop-hook feedback according to the
  configured hook mode.

Tests:

- Existing snapshot-doc and normal hook tests stay green.
- Timeout and contention cannot silently allow a blocking stop.

### Slice 5 — Verification and deployment

- Run focused runtime/outcome/CLI/hook tests.
- Run typecheck, build, CLI contract, agent setup, and full tests.
- Rebuild and run Vega’s current gate repeatedly, including two simultaneous
  callers.
- Confirm the primary gate remains near its prior latency and a duplicate
  returns promptly without a second CPU-heavy child.
- Install the verified build globally so active watchers and later agent
  invocations use the containment fix immediately.

## Adversarial attacks

1. **Sixty-two historical bases:** expected result is one targeted replay and
   an exact deferred-work warning, not 62 gates.
2. **Three simultaneous agents:** expected result is one child and two prompt
   contention failures.
3. **Parent cancellation:** the child remains bounded by its own parent-owned
   deadline; a dead lease owner is reclaimable on the next invocation.
4. **CPU loop that never yields:** the parent kills and reaps the isolated
   child; no JavaScript timer inside the child is required.
5. **Replay detector failure:** affected findings remain open; effectiveness is
   understated rather than falsely credited.
6. **Malformed lock:** acquisition fails closed under the existing protocol;
   the tool does not delete an unattributable owner record.
7. **Large legitimate full analysis:** it receives the larger but still finite
   deadline and can be explicitly tuned within the validated maximum.
8. **Child output flood:** the existing isolated runner’s output cap terminates
   the child rather than filling memory.
9. **Different gate options:** the request is passed explicitly to the child;
   no shared result cache can return a judgment computed under other options.
10. **Concurrent skill edits:** no write occurs under `skills/**`.

## Verification matrix

| Risk | Unit | Integration | Real repository |
| --- | --- | --- | --- |
| Replay explosion | Synthetic multi-base ledger | Private worker execution | Vega 62-base history |
| Duplicate CPU work | Held-lock boundary test | Two CLI processes | Two simultaneous Vega gates |
| Non-yielding analysis | Existing bounded-process timeout fixture | Private worker timeout | Deadline override smoke test |
| False resolution | Outcome ledger assertions | Effectiveness recomputation | Existing Vega events retained |
| CLI compatibility | Envelope and exit tests | Built CLI contract | `diff-gate --json --compact` |
| Hook compatibility | Hook rendering tests | Built `hook-stop` invocation | Installed hook smoke test |

## Derived verdict

The defect is not “diff-gate needs a faster cache.” The primary gate already
finishes quickly. The causal defect is unowned multiplicative work: historical
bookkeeping can expand one command into an unbounded number of gates, and
multiple callers can expand it again. The sufficient correction is therefore
containment at both dimensions—one replay base per judgment, one foreground
judgment per project, and one parent-enforced deadline per judgment—while
retaining unresolved evidence whenever bounded work cannot prove a fix.
