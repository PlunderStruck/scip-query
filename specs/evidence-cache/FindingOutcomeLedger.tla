---- MODULE FindingOutcomeLedger ----
(***************************************************************************
 Finding-outcome ledger lifecycle.

 The modeled slice is the hook-facing ledger update:
 - updateFindingOutcomeLedger reads existing rows.
 - recordFindingOutcomes computes the next outcome for each finding identity.
 - writeFindingOutcomeLedger persists rows and applies the per-check FIFO cap.

 A finding identity is represented by a small symbolic index. The production
 ledger key is <<check, findingId>>; this model fixes one check ("echo") and
 three finding ids, which is enough to exercise per-check FIFO overflow. The
 production cap is FINDING_OUTCOME_LEDGER_CAP_PER_CHECK = 5,000; Cap = 2 is
 the finite abstraction that makes overflow reachable in TLC.

 "resolved" means that identity stopped matching because code changed;
 CurrentSpec treats that identity as terminal. VulnerableSpec widens the
 environment so the same resolved identity can be observed as active again,
 and also includes an uncapped write path.

 Failure stories:
 - NoResurrectedResolutions fails if a resolved identity later appears as
   still-open or suppressed.
 - CapNeverExceeded fails if a write stores more than Cap rows for the check.
 ***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

ProductionCap == 5000
Cap == 2
KeyCount == 3
KeyIndexes == 1..KeyCount
Times == 0..3

ASSUME
  /\ Cap \in Nat
  /\ Cap > 0
  /\ KeyCount > Cap

VARIABLES
  ledger,            \* sequence of stored finding indexes
  outcome,           \* [KeyIndexes -> Outcomes]
  lastSeen,          \* [KeyIndexes -> Times]
  resolvedEver,      \* [KeyIndexes -> BOOLEAN]
  now,               \* symbolic clock
  phase,             \* scalar projection for trace-check
  storedRows,        \* scalar projection: Len(ledger)
  maxRowsForCheck,   \* scalar projection: one-check max row count
  resolvedRows,      \* scalar projection: count of resolvedEver flags
  resurrectionSeen   \* observer flag for the forbidden transition

vars ==
  <<ledger, outcome, lastSeen, resolvedEver, now, phase,
    storedRows, maxRowsForCheck, resolvedRows, resurrectionSeen>>

Outcomes == {"absent", "still-open", "suppressed", "resolved"}
ActiveOutcomes == {"still-open", "suppressed"}

SeqSet(seq) == {seq[i] : i \in DOMAIN seq}
NoDup(seq) == Cardinality(SeqSet(seq)) = Len(seq)
AllKeySeqs == UNION {[1..n -> KeyIndexes] : n \in 0..KeyCount}
LedgerSeqs == {seq \in AllKeySeqs : NoDup(seq)}
InLedger(key, seq) == key \in SeqSet(seq)
AddIfMissing(seq, key) == IF InLedger(key, seq) THEN seq ELSE Append(seq, key)
ResolvedCount(flags) == Cardinality({key \in KeyIndexes : flags[key]})

FIFOCap(rows, seen) ==
  {kept \in LedgerSeqs :
    /\ SeqSet(kept) \subseteq SeqSet(rows)
    /\ Len(kept) =
      IF Cardinality(SeqSet(rows)) <= Cap THEN Cardinality(SeqSet(rows)) ELSE Cap
    /\ \A keptKey \in SeqSet(kept) :
      \A dropped \in SeqSet(rows) \ SeqSet(kept) :
        seen[keptKey] >= seen[dropped]}

ProjectionOK ==
  /\ storedRows = Len(ledger)
  /\ maxRowsForCheck = Len(ledger)
  /\ resolvedRows = ResolvedCount(resolvedEver)

Init ==
  /\ ledger = <<>>
  /\ outcome = <<"absent", "absent", "absent">>
  /\ lastSeen = <<0, 0, 0>>
  /\ resolvedEver = <<FALSE, FALSE, FALSE>>
  /\ now = 0
  /\ phase = "empty"
  /\ storedRows = 0
  /\ maxRowsForCheck = 0
  /\ resolvedRows = 0
  /\ resurrectionSeen = FALSE

ObserveOpenCurrent ==
  \E key \in KeyIndexes, tick \in Times :
    /\ tick > now
    /\ resolvedEver[key] = FALSE
    /\ ledger \in LedgerSeqs
    /\ outcome \in [KeyIndexes -> Outcomes]
    /\ lastSeen \in [KeyIndexes -> Times]
    /\ LET rawLedger == AddIfMissing(ledger, key)
           rawOutcome == [outcome EXCEPT ![key] = "still-open"]
           rawLastSeen == [lastSeen EXCEPT ![key] = tick]
       IN
       /\ ledger' \in FIFOCap(rawLedger, rawLastSeen)
       /\ outcome' = rawOutcome
       /\ lastSeen' = rawLastSeen
       /\ resolvedEver' = resolvedEver
       /\ now' = tick
       /\ phase' = "observed-open"
       /\ storedRows' = Len(ledger')
       /\ maxRowsForCheck' = Len(ledger')
       /\ resolvedRows' = ResolvedCount(resolvedEver')
       /\ resurrectionSeen' = resurrectionSeen

ObserveSuppressedCurrent ==
  \E key \in KeyIndexes, tick \in Times :
    /\ tick > now
    /\ resolvedEver[key] = FALSE
    /\ ledger \in LedgerSeqs
    /\ outcome \in [KeyIndexes -> Outcomes]
    /\ lastSeen \in [KeyIndexes -> Times]
    /\ LET rawLedger == AddIfMissing(ledger, key)
           rawOutcome == [outcome EXCEPT ![key] = "suppressed"]
           rawLastSeen == [lastSeen EXCEPT ![key] = tick]
       IN
       /\ ledger' \in FIFOCap(rawLedger, rawLastSeen)
       /\ outcome' = rawOutcome
       /\ lastSeen' = rawLastSeen
       /\ resolvedEver' = resolvedEver
       /\ now' = tick
       /\ phase' = "observed-suppressed"
       /\ storedRows' = Len(ledger')
       /\ maxRowsForCheck' = Len(ledger')
       /\ resolvedRows' = ResolvedCount(resolvedEver')
       /\ resurrectionSeen' = resurrectionSeen

ResolveMissingCurrent ==
  \E key \in KeyIndexes, tick \in Times :
    /\ tick > now
    /\ InLedger(key, ledger)
    /\ outcome[key] \in ActiveOutcomes
    /\ ledger' = ledger
    /\ outcome' = [outcome EXCEPT ![key] = "resolved"]
    /\ lastSeen' = lastSeen
    /\ resolvedEver' = [resolvedEver EXCEPT ![key] = TRUE]
    /\ now' = tick
    /\ phase' = "resolved"
    /\ storedRows' = Len(ledger')
    /\ maxRowsForCheck' = Len(ledger')
    /\ resolvedRows' = ResolvedCount(resolvedEver')
    /\ resurrectionSeen' = resurrectionSeen

SkipCheckCurrent ==
  \E tick \in Times :
    /\ tick > now
    /\ outcome \in [KeyIndexes -> Outcomes]
    /\ outcome' = outcome
    /\ lastSeen' = lastSeen
    /\ now' = tick
    /\ phase' = "check-skipped"
    /\ UNCHANGED <<ledger, resolvedEver,
                  storedRows, maxRowsForCheck, resolvedRows, resurrectionSeen>>

ObserveResolvedOpenVulnerable ==
  \E key \in KeyIndexes, tick \in Times :
    /\ tick > now
    /\ resolvedEver[key] = TRUE
    /\ ledger \in LedgerSeqs
    /\ outcome \in [KeyIndexes -> Outcomes]
    /\ lastSeen \in [KeyIndexes -> Times]
    /\ LET rawLedger == AddIfMissing(ledger, key)
           rawOutcome == [outcome EXCEPT ![key] = "still-open"]
           rawLastSeen == [lastSeen EXCEPT ![key] = tick]
       IN
       /\ ledger' \in FIFOCap(rawLedger, rawLastSeen)
       /\ outcome' = rawOutcome
       /\ lastSeen' = rawLastSeen
       /\ resolvedEver' = resolvedEver
       /\ now' = tick
       /\ phase' = "resurrected"
       /\ storedRows' = Len(ledger')
       /\ maxRowsForCheck' = Len(ledger')
       /\ resolvedRows' = ResolvedCount(resolvedEver')
       /\ resurrectionSeen' = TRUE

ObserveResolvedSuppressedVulnerable ==
  \E key \in KeyIndexes, tick \in Times :
    /\ tick > now
    /\ resolvedEver[key] = TRUE
    /\ ledger \in LedgerSeqs
    /\ outcome \in [KeyIndexes -> Outcomes]
    /\ lastSeen \in [KeyIndexes -> Times]
    /\ LET rawLedger == AddIfMissing(ledger, key)
           rawOutcome == [outcome EXCEPT ![key] = "suppressed"]
           rawLastSeen == [lastSeen EXCEPT ![key] = tick]
       IN
       /\ ledger' \in FIFOCap(rawLedger, rawLastSeen)
       /\ outcome' = rawOutcome
       /\ lastSeen' = rawLastSeen
       /\ resolvedEver' = resolvedEver
       /\ now' = tick
       /\ phase' = "resurrected"
       /\ storedRows' = Len(ledger')
       /\ maxRowsForCheck' = Len(ledger')
       /\ resolvedRows' = ResolvedCount(resolvedEver')
       /\ resurrectionSeen' = TRUE

ObserveWithoutCapVulnerable ==
  \E key \in KeyIndexes, tick \in Times :
    /\ tick > now
    /\ resolvedEver[key] = FALSE
    /\ ledger \in LedgerSeqs
    /\ outcome \in [KeyIndexes -> Outcomes]
    /\ lastSeen \in [KeyIndexes -> Times]
    /\ ledger' = AddIfMissing(ledger, key)
    /\ outcome' = [outcome EXCEPT ![key] = "still-open"]
    /\ lastSeen' = [lastSeen EXCEPT ![key] = tick]
    /\ resolvedEver' = resolvedEver
    /\ now' = tick
    /\ phase' = "uncapped-write"
    /\ storedRows' = Len(ledger')
    /\ maxRowsForCheck' = Len(ledger')
    /\ resolvedRows' = ResolvedCount(resolvedEver')
    /\ resurrectionSeen' = resurrectionSeen

Terminal ==
  UNCHANGED vars

NextCurrent ==
  \/ ObserveOpenCurrent
  \/ ObserveSuppressedCurrent
  \/ ResolveMissingCurrent
  \/ SkipCheckCurrent
  \/ Terminal

NextVulnerable ==
  \/ NextCurrent
  \/ ObserveResolvedOpenVulnerable
  \/ ObserveResolvedSuppressedVulnerable
  \/ ObserveWithoutCapVulnerable

CurrentSpec == Init /\ [][NextCurrent]_vars
VulnerableSpec == Init /\ [][NextVulnerable]_vars

TypeOK ==
  /\ ledger \in LedgerSeqs
  /\ outcome \in [KeyIndexes -> Outcomes]
  /\ lastSeen \in [KeyIndexes -> Times]
  /\ resolvedEver \in [KeyIndexes -> BOOLEAN]
  /\ now \in Times
  /\ phase \in {"empty", "observed-open", "observed-suppressed",
                "resolved", "check-skipped", "resurrected", "uncapped-write"}
  /\ storedRows \in 0..KeyCount
  /\ maxRowsForCheck \in 0..KeyCount
  /\ resolvedRows \in 0..KeyCount
  /\ resurrectionSeen \in BOOLEAN
  /\ \A key \in SeqSet(ledger) : outcome[key] # "absent"
  /\ \A key \in KeyIndexes : resolvedEver[key] => (outcome[key] = "resolved" \/ resurrectionSeen)
  /\ ProjectionOK

NoResurrectedResolutions ==
  /\ resurrectionSeen = FALSE
  /\ \A key \in KeyIndexes : resolvedEver[key] => outcome[key] = "resolved"

CapNeverExceeded ==
  /\ maxRowsForCheck <= Cap
  /\ Len(ledger) <= Cap
====
