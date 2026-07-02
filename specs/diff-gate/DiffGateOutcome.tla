---- MODULE DiffGateOutcome ----
EXTENDS TLC

\* Models the diff-gate pass/fail decision: diffGate (src/queries/impact/
\* diff-gate.ts) computes a DiffGateResult in one call, then the caller
\* (handleDiffGate, src/runtime/query-commands/impact.ts) derives an exit
\* code from blockingFindings(result.findings) and diffGateFailedClosed
\* (result). Two specs share the same RunDiffGate action and diverge only in
\* DecideExit, mirroring Vega's SubscriptionLifecycle CurrentSpec/
\* VulnerableSpec pairing:
\*   CurrentSpec    — today's hardened decision (checks diffGateFailedClosed)
\*   VulnerableSpec — the pre-fix decision (ignored gateFailed entirely,
\*                    discovered on the 2026-07-01 Vega calibration run: an
\*                    8,099-file commit blew the git-diff exec buffer,
\*                    diffImpactPlan fell back to an empty plan with
\*                    GIT_DIFF_UNAVAILABLE_NOTE, checksRun stayed [], and the
\*                    gate exited 0 — a silent pass with zero checks run.)

VARIABLES stage, planState, checksRan, findingsState, exitState, allSkipped

vars == <<stage, planState, checksRan, findingsState, exitState, allSkipped>>

\* planState: the outcome of diffImpactPlan/diffImpact inside diffGate().
\*   "ok-empty"    — git succeeded, genuinely zero changed files
\*   "ok-changes"  — git succeeded, N > 0 changed files
\*   "git-failed"  — git diff computation failed (buffer too large, bad
\*                   --base, git missing); diffImpact falls back to an empty
\*                   plan with note = GIT_DIFF_UNAVAILABLE_NOTE
\* Both "ok-empty" and "git-failed" hit diffGate's early
\* `if (changedFiles.length === 0) return result` (src/queries/impact/
\* diff-gate.ts:257) BEFORE any check runs — checksRun stays [] in both
\* cases. Only diffGateFailedClosed's note check (line 322-324) tells them
\* apart.
\*
\* allSkipped abstracts `--skip` covering every one of the 9 checks
\* (DIFF_GATE_CHECKS) — a legitimate, user-directed reason checksRun can be
\* empty even when planState = "ok-changes" (runUnlessSkipped records a
\* `skipped` entry and returns before pushing into checksRun, for every
\* check named in --skip; src/queries/impact/diff-gate.ts:259-275). It is
\* fixed per behavior (chosen once in Init, never changes).

Init ==
  /\ stage = "start"
  /\ planState = "pending"
  /\ checksRan = FALSE
  /\ findingsState = "none"
  /\ exitState = "unset"
  /\ allSkipped \in BOOLEAN

\* diffGate() as one atomic computation: plan resolution + (if reached) the
\* check loop + applyStructuredSuppressions, all synchronous in the real
\* function.
RunDiffGate ==
  /\ stage = "start"
  /\ \E p \in {"ok-empty", "ok-changes", "git-failed"} :
       LET ranChecks == p = "ok-changes" /\ ~allSkipped IN
       \E f \in (IF ranChecks THEN {"none", "advisoryOnly", "blockingPresent", "suppressedToNone"} ELSE {"none"}) :
         /\ planState' = p
         /\ checksRan' = ranChecks
         /\ findingsState' = f
  /\ stage' = "computed"
  /\ allSkipped' = allSkipped \* fixed per behavior; primed for tooling visibility, see mapping
  /\ UNCHANGED exitState

\* diffGateFailedClosed's exact formula (src/queries/impact/diff-gate.ts:322-324).
GateFailed == ~checksRan /\ planState = "git-failed"
HasBlocking == findingsState = "blockingPresent"

\* handleDiffGate's exit decision post-fix (src/runtime/query-commands/
\* impact.ts:230-240): `blocking.length > 0 || gateFailed`.
DecideExitCurrent ==
  /\ stage = "computed"
  /\ exitState = "unset"
  /\ exitState' = IF GateFailed \/ HasBlocking THEN "block" ELSE "pass"
  /\ stage' = "decided"
  /\ UNCHANGED <<planState, checksRan, findingsState, allSkipped>>

\* Pre-fix: gateFailed did not exist as a concept wired into the exit
\* decision — only `blocking.length > 0` gated the exit code.
DecideExitVulnerable ==
  /\ stage = "computed"
  /\ exitState = "unset"
  /\ exitState' = IF HasBlocking THEN "block" ELSE "pass"
  /\ stage' = "decided"
  /\ UNCHANGED <<planState, checksRan, findingsState, allSkipped>>

Terminal ==
  /\ stage = "decided"
  /\ UNCHANGED vars

NextCurrent == RunDiffGate \/ DecideExitCurrent \/ Terminal
NextVulnerable == RunDiffGate \/ DecideExitVulnerable \/ Terminal

CurrentSpec == Init /\ [][NextCurrent]_vars
VulnerableSpec == Init /\ [][NextVulnerable]_vars

TypeOK ==
  /\ stage \in {"start", "computed", "decided"}
  /\ planState \in {"pending", "ok-empty", "ok-changes", "git-failed"}
  /\ checksRan \in BOOLEAN
  /\ findingsState \in {"none", "advisoryOnly", "blockingPresent", "suppressedToNone"}
  /\ exitState \in {"unset", "pass", "block"}
  /\ allSkipped \in BOOLEAN

\* Literal invariant as specified: a passing exit implies checks actually
\* ran and there is no blocking finding. TLC PROVES this for CurrentSpec —
\* wait, it does not: see report. It is refuted by the *legitimate*
\* all-checks-skipped-by-request case (planState = "ok-changes" /\
\* allSkipped), which is not the Vega bug. Kept because the task specifies
\* it verbatim; NoUnintendedSilentPass below is the corrected version.
NoSilentPass == (exitState = "pass") => (checksRan /\ findingsState # "blockingPresent")

\* A pass with zero checks is fine when the *user* asked to skip everything,
\* or when there truly was nothing to check — it is only a silent-pass bug
\* when checksRan is false because the gate could not see the diff at all
\* (planState = "git-failed"). This is the invariant CurrentSpec actually
\* upholds and VulnerableSpec actually violates.
ConsentedNoCheck == planState = "ok-empty" \/ (planState = "ok-changes" /\ allSkipped)

NoUnintendedSilentPass ==
  (exitState = "pass") => (checksRan \/ ConsentedNoCheck) /\ findingsState # "blockingPresent"
====
