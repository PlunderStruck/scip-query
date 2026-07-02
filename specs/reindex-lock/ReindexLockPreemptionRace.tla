---- MODULE ReindexLockPreemptionRace ----
EXTENDS TLC, Naturals, FiniteSets

\* Regression model seeded from a real counterexample: PRE-FIX
\* src/reindex/index.ts discarded terminateReindexLockOwner's outcome and
\* force-removed the lock file unconditionally (see git history before "tla
\* model A: fail closed when lock preemption cannot confirm owner death").
\* This is the CURRENT/VulnerableSpec pairing for the reindex lock: the main
\* model (ReindexLock.tla) is the FIXED behavior and passes; this spec is the
\* pre-fix behavior and MUST violate AtMostOneOwner. It doubles as the
\* tla-model-system skill's required "remove a guard, confirm TLC catches
\* it" exercise — the guard removed here is the termination-confirmed check
\* on the Preempt action, not a placeholder deletion.

Actors == {"w", "m"}

VARIABLES lockOwner, phase, published

vars == <<lockOwner, phase, published>>

StaleTag(a) == IF a = "w" THEN "w_stale" ELSE "m_stale"
IsStale(v) == v \in {"w_stale", "m_stale"}

Init ==
  /\ lockOwner = "None"
  /\ phase = [a \in Actors |-> "Idle"]
  /\ published = "Init"

Acquire(a) ==
  /\ phase[a] = "Idle"
  /\ (lockOwner = "None" \/ IsStale(lockOwner))
  /\ lockOwner' = a
  /\ phase' = [phase EXCEPT ![a] = "Running"]
  /\ UNCHANGED published

\* THE BUG (src/reindex/index.ts, pre-fix): terminateReindexLockOwner's
\* return value was ignored — `await terminateReindexLockOwner(existing.pid);
\* rmSync(lockPath, {force:true}); continue;` ran unconditionally. Whether or
\* not the watcher actually died, the manual actor steals the lock and starts
\* running. If the watcher survived (stuck process, kill(2) permission
\* failure, or the PID was reused by an unrelated process within the
\* SIGTERM+SIGKILL wait window), phase["w"] genuinely stays "Running" — the
\* code has nothing that would change it.
BuggyPreempt ==
  /\ phase["m"] = "Idle"
  /\ lockOwner = "w"
  /\ phase["w"] = "Running"
  /\ lockOwner' = "m"
  /\ phase' = [phase EXCEPT !["m"] = "Running"]
  /\ UNCHANGED published

Crash(a) ==
  /\ phase[a] = "Running"
  /\ lockOwner = a
  /\ phase' = [phase EXCEPT ![a] = "Failed"]
  /\ lockOwner' = StaleTag(a)
  /\ UNCHANGED published

Fail(a) ==
  /\ phase[a] = "Running"
  /\ lockOwner = a
  /\ phase' = [phase EXCEPT ![a] = "Failed"]
  /\ lockOwner' = "None"
  /\ UNCHANGED published

Publish(a) ==
  /\ phase[a] = "Running"
  /\ lockOwner = a
  /\ phase' = [phase EXCEPT ![a] = "Done"]
  /\ lockOwner' = "None"
  /\ published' = a

Recycle(a) ==
  /\ phase[a] \in {"Done", "Failed"}
  /\ phase' = [phase EXCEPT ![a] = "Idle"]
  /\ UNCHANGED <<lockOwner, published>>

Next ==
  \/ \E a \in Actors : Acquire(a)
  \/ BuggyPreempt
  \/ \E a \in Actors : Crash(a)
  \/ \E a \in Actors : Fail(a)
  \/ \E a \in Actors : Publish(a)
  \/ \E a \in Actors : Recycle(a)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ lockOwner \in {"None", "w", "m", "w_stale", "m_stale"}
  /\ phase \in [Actors -> {"Idle", "Running", "Done", "Failed"}]
  /\ published \in Actors \cup {"Init"}

\* Expected to FAIL: BuggyPreempt can fire while phase["w"] = "Running",
\* immediately producing phase["w"] = phase["m"] = "Running" in the same
\* state.
AtMostOneOwner == Cardinality({a \in Actors : phase[a] = "Running"}) <= 1
====
