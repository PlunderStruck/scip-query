---- MODULE ReindexLock ----
EXTENDS TLC, Naturals, FiniteSets

\* Models the reindex lock/publish machinery in src/reindex/index.ts
\* (acquireReindexLock/tryAcquireReindexLock/terminateReindexLockOwner/
\* promoteReindexArtifacts) contended by two actor roles: the file watcher's
\* forked reindex child ("w") and a manual `scip-query reindex` invocation
\* ("m"). Debounce/cooldown scheduling (src/runtime/watch.ts) is deliberately
\* out of scope: it controls WHEN a role requests the lock, not lock
\* correctness, and is covered by existing watcher tests.
\*
\* This spec reflects the FIXED code (terminateReindexLockOwner's outcome is
\* checked before the lock is stolen — src/reindex/index.ts, commit
\* "tla-model A: fail closed when lock preemption cannot confirm owner
\* death"). specs/reindex-lock/ReindexLockPreemptionRace.tla is the
\* regression model of the PRE-FIX behavior and is expected to violate
\* AtMostOneOwner.

Actors == {"w", "m"}

VARIABLES lockOwner, phase, published

vars == <<lockOwner, phase, published>>

\* lockOwner encodes both identity and staleness: "w"/"m" means the lock file
\* records that role as the live owner (src/reindex/index.ts:
\* ReindexLockMetadata#pid, written by tryAcquireReindexLock). "w_stale"/
\* "m_stale" means the recorded pid belongs to a process that has since died
\* without releasing the lock (detected via isProcessAlive at
\* acquireReindexLock's stale-lock branch) — the lock file itself doesn't
\* distinguish this; it's a derived fact checked at acquisition time.
StaleTag(a) == IF a = "w" THEN "w_stale" ELSE "m_stale"
IsStale(v) == v \in {"w_stale", "m_stale"}

Init ==
  /\ lockOwner = "None"
  /\ phase = [a \in Actors |-> "Idle"]
  /\ published = "Init"

\* A fresh or stale-reclaiming acquire — acquireReindexLock's retry loop
\* (src/reindex/index.ts) handles both the EEXIST-empty case and the
\* !isProcessAlive stale-takeover case the same way: remove/ignore the old
\* record and claim the lock. Available to either role regardless of trigger
\* kind (unlike Preempt*, which is manual-cli-only).
Acquire(a) ==
  /\ phase[a] = "Idle"
  /\ (lockOwner = "None" \/ IsStale(lockOwner))
  /\ lockOwner' = a
  /\ phase' = [phase EXCEPT ![a] = "Running"]
  /\ UNCHANGED published

\* Manual CLI preempts a live watcher-owned lock (shouldPreemptReindexLock
\* requires requested.kind = 'manual-cli' AND the existing lock's trigger to
\* be watch-*; manual never preempts manual, watcher never preempts anyone).
\* terminateReindexLockOwner (post-fix) confirms the owner actually died
\* before the caller steals the lock.
PreemptSucceeds ==
  /\ phase["m"] = "Idle"
  /\ lockOwner = "w"
  /\ phase["w"] = "Running"
  /\ lockOwner' = "m"
  /\ phase' = [phase EXCEPT !["m"] = "Running", !["w"] = "Failed"]
  /\ UNCHANGED published

\* Termination could not be confirmed (SIGTERM+SIGKILL both failed to
\* produce a dead PID within the wait windows, or the PID was reused): the
\* fixed code throws instead of stealing the lock. The watcher keeps running
\* untouched; the manual attempt fails.
PreemptFails ==
  /\ phase["m"] = "Idle"
  /\ lockOwner = "w"
  /\ phase["w"] = "Running"
  /\ phase' = [phase EXCEPT !["m"] = "Failed"]
  /\ UNCHANGED <<lockOwner, published>>

\* The owning process is killed (OOM, SIGKILL from outside this system, a
\* crashed forked child) without running reindex()'s `finally { releaseLock()
\* }` — the lock file survives with a now-dead pid.
Crash(a) ==
  /\ phase[a] = "Running"
  /\ lockOwner = a
  /\ phase' = [phase EXCEPT ![a] = "Failed"]
  /\ lockOwner' = StaleTag(a)
  /\ UNCHANGED published

\* A controlled failure (indexer error, conversion error, etc.) — reindex()'s
\* catch/finally releases the lock normally.
Fail(a) ==
  /\ phase[a] = "Running"
  /\ lockOwner = a
  /\ phase' = [phase EXCEPT ![a] = "Failed"]
  /\ lockOwner' = "None"
  /\ UNCHANGED published

\* promoteReindexArtifacts + writeReindexMeta (published' abstracts the
\* atomic index.db rename readers actually consume) followed by releaseLock.
Publish(a) ==
  /\ phase[a] = "Running"
  /\ lockOwner = a
  /\ phase' = [phase EXCEPT ![a] = "Done"]
  /\ lockOwner' = "None"
  /\ published' = a

\* A fresh process instance of role `a` starts up and is ready to try
\* acquiring again (a new `scip-query reindex` invocation, or the watcher's
\* next forked child).
Recycle(a) ==
  /\ phase[a] \in {"Done", "Failed"}
  /\ phase' = [phase EXCEPT ![a] = "Idle"]
  /\ UNCHANGED <<lockOwner, published>>

Next ==
  \/ \E a \in Actors : Acquire(a)
  \/ PreemptSucceeds
  \/ PreemptFails
  \/ \E a \in Actors : Crash(a)
  \/ \E a \in Actors : Fail(a)
  \/ \E a \in Actors : Publish(a)
  \/ \E a \in Actors : Recycle(a)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ lockOwner \in {"None", "w", "m", "w_stale", "m_stale"}
  /\ phase \in [Actors -> {"Idle", "Running", "Done", "Failed"}]
  /\ published \in Actors \cup {"Init"}

\* Invariant 1: at most one live reindex owner.
AtMostOneOwner == Cardinality({a \in Actors : phase[a] = "Running"}) <= 1

\* Invariant 2: the published index is always a complete artifact. In this
\* model `published` only ever changes via the single atomic Publish action,
\* so a torn/partial value is unrepresentable by construction — a
\* deliberate simplification. The real code's promote step touches three
\* files (scip, db, meta) with three separate renames
\* (src/reindex/index.ts replaceFile); readers only ever consume index.db,
\* whose own rename is a single OS-atomic renameSync, so the reader-facing
\* half of this invariant holds by the platform's rename guarantee, not by
\* anything TLC checks here (see report: accepted non-modeled behavior).
NoTornPublish == published \in Actors \cup {"Init"}

\* Invariant 3: a preempted/crashed run never publishes. In this model this
\* reduces to AtMostOneOwner: Publish(a)'s only guard is sole live ownership
\* (phase[a] = "Running" /\ lockOwner = a), and there is no other gate on
\* publishing — so the only way a preempted/crashed actor could publish is by
\* being concurrently "Running" while contended, which AtMostOneOwner already
\* forbids. Kept as a separately named invariant for traceability to the
\* PreemptFails counterexample.
NoPublishWhileContended == Cardinality({a \in Actors : phase[a] = "Running"}) <= 1

\* Invariant 4 (bounded-takeover safety, not liveness): whenever the lock is
\* stale, every actor is in a phase from which it can reach "Running" within
\* at most one more step (Idle -> Acquire is immediate; Done/Failed -> Recycle
\* is always enabled, then Acquire). No actor can be stuck "Running" while the
\* lock is recorded stale (that would require two different lockOwner values
\* simultaneously, impossible for a single variable) — so a stale lock can
\* never permanently block progress.
NoRunnerBlockedByStaleLock ==
  IsStale(lockOwner) => \A a \in Actors : phase[a] \in {"Idle", "Done", "Failed"}
====
