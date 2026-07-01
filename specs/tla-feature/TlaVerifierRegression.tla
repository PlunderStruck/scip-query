---- MODULE TlaVerifierRegression ----
EXTENDS TLC

VARIABLES conformanceState, toolState, exitState

vars == <<conformanceState, toolState, exitState>>

Init ==
  /\ conformanceState = "pending"
  /\ toolState = "notRun"
  /\ exitState = "unset"

CheckConformance ==
  /\ conformanceState = "pending"
  /\ conformanceState' = "checked"
  /\ UNCHANGED <<toolState, exitState>>

RunChecker ==
  /\ conformanceState = "checked"
  /\ toolState = "notRun"
  /\ toolState' = "passed"
  /\ UNCHANGED <<conformanceState, exitState>>

DecideExit ==
  /\ conformanceState = "checked"
  /\ toolState = "passed"
  /\ exitState = "unset"
  /\ exitState' = "success"
  /\ UNCHANGED <<conformanceState, toolState>>

Terminal ==
  /\ exitState # "unset"
  /\ UNCHANGED vars

Next ==
  \/ CheckConformance
  \/ RunChecker
  \/ DecideExit
  \/ Terminal

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ conformanceState \in {"pending", "checked"}
  /\ toolState \in {"notRun", "passed"}
  /\ exitState \in {"unset", "success"}

ExitAfterEvidence ==
  exitState # "unset" => /\ conformanceState = "checked"
                         /\ toolState = "passed"
====
