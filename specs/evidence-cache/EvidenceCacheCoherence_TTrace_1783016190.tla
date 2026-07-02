---- MODULE EvidenceCacheCoherence_TTrace_1783016190 ----
EXTENDS Sequences, TLCExt, EvidenceCacheCoherence, Toolbox, Naturals, TLC, EvidenceCacheCoherence_TEConstants

_expression ==
    LET EvidenceCacheCoherence_TEExpression == INSTANCE EvidenceCacheCoherence_TEExpression
    IN EvidenceCacheCoherence_TEExpression!expression
----

_trace ==
    LET EvidenceCacheCoherence_TETrace == INSTANCE EvidenceCacheCoherence_TETrace
    IN EvidenceCacheCoherence_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        conn = ("ok")
        /\
        evidence = ({<<f1, h1>>})
        /\
        indexView = ((f1 :> h2))
        /\
        fileContent = ((f1 :> h2))
        /\
        servedDisabled = (FALSE)
        /\
        projEvidence = ({})
        /\
        servedStale = (TRUE)
    )
----

_init ==
    /\ indexView = _TETrace[1].indexView
    /\ conn = _TETrace[1].conn
    /\ fileContent = _TETrace[1].fileContent
    /\ servedDisabled = _TETrace[1].servedDisabled
    /\ projEvidence = _TETrace[1].projEvidence
    /\ servedStale = _TETrace[1].servedStale
    /\ evidence = _TETrace[1].evidence
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ indexView  = _TETrace[i].indexView
        /\ indexView' = _TETrace[j].indexView
        /\ conn  = _TETrace[i].conn
        /\ conn' = _TETrace[j].conn
        /\ fileContent  = _TETrace[i].fileContent
        /\ fileContent' = _TETrace[j].fileContent
        /\ servedDisabled  = _TETrace[i].servedDisabled
        /\ servedDisabled' = _TETrace[j].servedDisabled
        /\ projEvidence  = _TETrace[i].projEvidence
        /\ projEvidence' = _TETrace[j].projEvidence
        /\ servedStale  = _TETrace[i].servedStale
        /\ servedStale' = _TETrace[j].servedStale
        /\ evidence  = _TETrace[i].evidence
        /\ evidence' = _TETrace[j].evidence

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("EvidenceCacheCoherence_TTrace_1783016190.json", _TETrace)

=============================================================================

 Note that you can extract this module `EvidenceCacheCoherence_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `EvidenceCacheCoherence_TEExpression.tla` file takes precedence 
  over the module `EvidenceCacheCoherence_TEExpression` below).

---- MODULE EvidenceCacheCoherence_TEExpression ----
EXTENDS Sequences, TLCExt, EvidenceCacheCoherence, Toolbox, Naturals, TLC, EvidenceCacheCoherence_TEConstants

expression == 
    [
        \* To hide variables of the `EvidenceCacheCoherence` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        indexView |-> indexView
        ,conn |-> conn
        ,fileContent |-> fileContent
        ,servedDisabled |-> servedDisabled
        ,projEvidence |-> projEvidence
        ,servedStale |-> servedStale
        ,evidence |-> evidence
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_indexViewUnchanged |-> indexView = indexView'
        
        \* Format the `indexView` variable as Json value.
        \* ,_indexViewJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(indexView)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_indexViewModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].indexView # _TETrace[s-1].indexView
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE EvidenceCacheCoherence_TETrace ----
\*EXTENDS IOUtils, EvidenceCacheCoherence, TLC, EvidenceCacheCoherence_TEConstants
\*
\*trace == IODeserialize("EvidenceCacheCoherence_TTrace_1783016190.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE EvidenceCacheCoherence_TETrace ----
EXTENDS EvidenceCacheCoherence, TLC, EvidenceCacheCoherence_TEConstants

trace == 
    <<
    ([conn |-> "ok",evidence |-> {},indexView |-> (f1 :> h1),fileContent |-> (f1 :> h1),servedDisabled |-> FALSE,projEvidence |-> {},servedStale |-> FALSE]),
    ([conn |-> "ok",evidence |-> {},indexView |-> (f1 :> h1),fileContent |-> (f1 :> h2),servedDisabled |-> FALSE,projEvidence |-> {},servedStale |-> FALSE]),
    ([conn |-> "ok",evidence |-> {<<f1, h1>>},indexView |-> (f1 :> h1),fileContent |-> (f1 :> h2),servedDisabled |-> FALSE,projEvidence |-> {},servedStale |-> FALSE]),
    ([conn |-> "ok",evidence |-> {<<f1, h1>>},indexView |-> (f1 :> h2),fileContent |-> (f1 :> h2),servedDisabled |-> FALSE,projEvidence |-> {},servedStale |-> FALSE]),
    ([conn |-> "ok",evidence |-> {<<f1, h1>>},indexView |-> (f1 :> h2),fileContent |-> (f1 :> h2),servedDisabled |-> FALSE,projEvidence |-> {},servedStale |-> TRUE])
    >>
----


=============================================================================

---- MODULE EvidenceCacheCoherence_TEConstants ----
EXTENDS EvidenceCacheCoherence

CONSTANTS f1, h1, h2

=============================================================================

---- CONFIG EvidenceCacheCoherence_TTrace_1783016190 ----
CONSTANTS
    Files = { f1 }
    Hashes = { h1 , h2 }
    h1 = h1
    h2 = h2
    f1 = f1

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
\* Generated on Thu Jul 02 11:16:30 PDT 2026