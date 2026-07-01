---- MODULE TlaVerifier ----
EXTENDS TLC

VARIABLES contractState, moduleState, conformanceState, toolState, exitState

vars == <<contractState, moduleState, conformanceState, toolState, exitState>>

Init ==
  /\ contractState = "missing"
  /\ moduleState = "unread"
  /\ conformanceState = "pending"
  /\ toolState = "notRun"
  /\ exitState = "unset"

LoadContract ==
  /\ contractState = "missing"
  /\ contractState' = "loaded"
  /\ UNCHANGED <<moduleState, conformanceState, toolState, exitState>>

ReadModule ==
  /\ contractState = "loaded"
  /\ moduleState = "unread"
  /\ moduleState' = "read"
  /\ UNCHANGED <<contractState, conformanceState, toolState, exitState>>

CheckConformance ==
  /\ moduleState = "read"
  /\ conformanceState = "pending"
  /\ conformanceState' = "checked"
  /\ UNCHANGED <<contractState, moduleState, toolState, exitState>>

RunChecker ==
  /\ conformanceState = "checked"
  /\ toolState = "notRun"
  /\ toolState' \in {"passed", "failed"}
  /\ UNCHANGED <<contractState, moduleState, conformanceState, exitState>>

DecideExit ==
  /\ conformanceState = "checked"
  /\ toolState # "notRun"
  /\ exitState = "unset"
  /\ exitState' \in {"success", "failure"}
  /\ UNCHANGED <<contractState, moduleState, conformanceState, toolState>>

Terminal ==
  /\ exitState # "unset"
  /\ UNCHANGED vars

Next ==
  \/ LoadContract
  \/ ReadModule
  \/ CheckConformance
  \/ RunChecker
  \/ DecideExit
  \/ Terminal

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ contractState \in {"missing", "loaded"}
  /\ moduleState \in {"unread", "read"}
  /\ conformanceState \in {"pending", "checked"}
  /\ toolState \in {"notRun", "passed", "failed"}
  /\ exitState \in {"unset", "success", "failure"}

ModuleAfterContract ==
  moduleState = "read" => contractState = "loaded"

CheckerAfterConformance ==
  toolState # "notRun" => conformanceState = "checked"

ExitAfterEvidence ==
  exitState # "unset" => /\ conformanceState = "checked"
                         /\ toolState # "notRun"
====
