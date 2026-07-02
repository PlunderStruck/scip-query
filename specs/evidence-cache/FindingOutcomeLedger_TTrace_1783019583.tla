---- MODULE FindingOutcomeLedger_TTrace_1783019583 ----
EXTENDS Sequences, TLCExt, Toolbox, FindingOutcomeLedger, Naturals, TLC

_expression ==
    LET FindingOutcomeLedger_TEExpression == INSTANCE FindingOutcomeLedger_TEExpression
    IN FindingOutcomeLedger_TEExpression!expression
----

_trace ==
    LET FindingOutcomeLedger_TETrace == INSTANCE FindingOutcomeLedger_TETrace
    IN FindingOutcomeLedger_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        resurrectionSeen = (TRUE)
        /\
        phase = ("resurrected")
        /\
        ledger = (<<1>>)
        /\
        lastSeen = (<<3, 0, 0>>)
        /\
        storedRows = (1)
        /\
        now = (3)
        /\
        resolvedEver = (<<TRUE, FALSE, FALSE>>)
        /\
        maxRowsForCheck = (1)
        /\
        resolvedRows = (1)
        /\
        outcome = (<<"still-open", "absent", "absent">>)
    )
----

_init ==
    /\ resolvedRows = _TETrace[1].resolvedRows
    /\ now = _TETrace[1].now
    /\ resurrectionSeen = _TETrace[1].resurrectionSeen
    /\ outcome = _TETrace[1].outcome
    /\ maxRowsForCheck = _TETrace[1].maxRowsForCheck
    /\ phase = _TETrace[1].phase
    /\ resolvedEver = _TETrace[1].resolvedEver
    /\ storedRows = _TETrace[1].storedRows
    /\ ledger = _TETrace[1].ledger
    /\ lastSeen = _TETrace[1].lastSeen
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ resolvedRows  = _TETrace[i].resolvedRows
        /\ resolvedRows' = _TETrace[j].resolvedRows
        /\ now  = _TETrace[i].now
        /\ now' = _TETrace[j].now
        /\ resurrectionSeen  = _TETrace[i].resurrectionSeen
        /\ resurrectionSeen' = _TETrace[j].resurrectionSeen
        /\ outcome  = _TETrace[i].outcome
        /\ outcome' = _TETrace[j].outcome
        /\ maxRowsForCheck  = _TETrace[i].maxRowsForCheck
        /\ maxRowsForCheck' = _TETrace[j].maxRowsForCheck
        /\ phase  = _TETrace[i].phase
        /\ phase' = _TETrace[j].phase
        /\ resolvedEver  = _TETrace[i].resolvedEver
        /\ resolvedEver' = _TETrace[j].resolvedEver
        /\ storedRows  = _TETrace[i].storedRows
        /\ storedRows' = _TETrace[j].storedRows
        /\ ledger  = _TETrace[i].ledger
        /\ ledger' = _TETrace[j].ledger
        /\ lastSeen  = _TETrace[i].lastSeen
        /\ lastSeen' = _TETrace[j].lastSeen

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("FindingOutcomeLedger_TTrace_1783019583.json", _TETrace)

=============================================================================

 Note that you can extract this module `FindingOutcomeLedger_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `FindingOutcomeLedger_TEExpression.tla` file takes precedence 
  over the module `FindingOutcomeLedger_TEExpression` below).

---- MODULE FindingOutcomeLedger_TEExpression ----
EXTENDS Sequences, TLCExt, Toolbox, FindingOutcomeLedger, Naturals, TLC

expression == 
    [
        \* To hide variables of the `FindingOutcomeLedger` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        resolvedRows |-> resolvedRows
        ,now |-> now
        ,resurrectionSeen |-> resurrectionSeen
        ,outcome |-> outcome
        ,maxRowsForCheck |-> maxRowsForCheck
        ,phase |-> phase
        ,resolvedEver |-> resolvedEver
        ,storedRows |-> storedRows
        ,ledger |-> ledger
        ,lastSeen |-> lastSeen
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_resolvedRowsUnchanged |-> resolvedRows = resolvedRows'
        
        \* Format the `resolvedRows` variable as Json value.
        \* ,_resolvedRowsJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(resolvedRows)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_resolvedRowsModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].resolvedRows # _TETrace[s-1].resolvedRows
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE FindingOutcomeLedger_TETrace ----
\*EXTENDS IOUtils, FindingOutcomeLedger, TLC
\*
\*trace == IODeserialize("FindingOutcomeLedger_TTrace_1783019583.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE FindingOutcomeLedger_TETrace ----
EXTENDS FindingOutcomeLedger, TLC

trace == 
    <<
    ([resurrectionSeen |-> FALSE,phase |-> "empty",ledger |-> <<>>,lastSeen |-> <<0, 0, 0>>,storedRows |-> 0,now |-> 0,resolvedEver |-> <<FALSE, FALSE, FALSE>>,maxRowsForCheck |-> 0,resolvedRows |-> 0,outcome |-> <<"absent", "absent", "absent">>]),
    ([resurrectionSeen |-> FALSE,phase |-> "observed-open",ledger |-> <<1>>,lastSeen |-> <<1, 0, 0>>,storedRows |-> 1,now |-> 1,resolvedEver |-> <<FALSE, FALSE, FALSE>>,maxRowsForCheck |-> 1,resolvedRows |-> 0,outcome |-> <<"still-open", "absent", "absent">>]),
    ([resurrectionSeen |-> FALSE,phase |-> "resolved",ledger |-> <<1>>,lastSeen |-> <<1, 0, 0>>,storedRows |-> 1,now |-> 2,resolvedEver |-> <<TRUE, FALSE, FALSE>>,maxRowsForCheck |-> 1,resolvedRows |-> 1,outcome |-> <<"resolved", "absent", "absent">>]),
    ([resurrectionSeen |-> TRUE,phase |-> "resurrected",ledger |-> <<1>>,lastSeen |-> <<3, 0, 0>>,storedRows |-> 1,now |-> 3,resolvedEver |-> <<TRUE, FALSE, FALSE>>,maxRowsForCheck |-> 1,resolvedRows |-> 1,outcome |-> <<"still-open", "absent", "absent">>])
    >>
----


=============================================================================

---- CONFIG FindingOutcomeLedger_TTrace_1783019583 ----

INVARIANT
    _inv

CHECK_DEADLOCK
    \* CHECK_DEADLOCK off because of PROPERTY or INVARIANT above.
    FALSE

INIT
    _init

NEXT
    _next

CONSTANT
    _TETrace <- _trace

ALIAS
    _expression
=============================================================================
\* Generated on Thu Jul 02 12:13:03 PDT 2026