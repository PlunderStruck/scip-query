---- MODULE EvidenceCacheCoherence ----
(***************************************************************************
 Evidence-cache coherence: no query may ever serve an evidence product
 computed from content other than the content of the index it is serving.

 The modeled slice (src/storage/evidence-cache.ts + the reindex publish):
 - Workspace files change (EditFile) without the index knowing.
 - Reindex publishes atomically: the served index view becomes a snapshot
   of current content (Publish).
 - Queries serve file-tier evidence keyed by (kind, file, contentHash) and
   project-tier evidence keyed by the whole-index fingerprint.
 - Any cache error disables the connection permanently (fail closed).

 The COHERENCE subtlety this model exists to pin down: serving OLD evidence
 against an OLD index view while the workspace has newer edits is CORRECT
 (evidence matches what is being served). Staleness is only possible if a
 serve's key discipline is broken — which CurrentServe makes impossible by
 construction and VulnerableServe (path-keyed, hash-ignored) permits. TLC
 must prove NoStaleServe for CurrentSpec and refute it for VulnerableSpec.
 ***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Files, Hashes
ASSUME Cardinality(Hashes) >= 2

VARIABLES
  fileContent,   \* [Files -> Hashes]: content in the working tree now
  indexView,     \* [Files -> Hashes]: snapshot the published index serves
  evidence,      \* set of <<file, hash>> file-tier products in evidence.db
  projEvidence,  \* set of index fingerprints with a project-tier product
  conn,          \* "ok" | "disabled": fail-closed connection state
  servedStale,   \* TRUE iff some serve returned evidence not matching indexView
  servedDisabled \* TRUE iff a serve happened while conn = "disabled"

vars == <<fileContent, indexView, evidence, projEvidence, conn, servedStale, servedDisabled>>

Fingerprint(view) == view  \* a project fingerprint is determined by the full view

Init ==
  /\ fileContent \in [Files -> Hashes]
  /\ indexView = fileContent
  /\ evidence = {}
  /\ projEvidence = {}
  /\ conn = "ok"
  /\ servedStale = FALSE
  /\ servedDisabled = FALSE

\* The working tree changes; the published index does not.
EditFile ==
  /\ \E f \in Files, h \in Hashes :
       /\ fileContent[f] # h
       /\ fileContent' = [fileContent EXCEPT ![f] = h]
  /\ UNCHANGED <<indexView, evidence, projEvidence, conn, servedStale, servedDisabled>>

\* Atomic reindex publish: the served view becomes current content.
\* Evidence rows are NOT deleted — old-keyed rows simply become unreachable.
Publish ==
  /\ indexView' = fileContent
  /\ UNCHANGED <<fileContent, evidence, projEvidence, conn, servedStale, servedDisabled>>

\* Miss path: compute a product for a file as the served index sees it.
ComputeAndStore ==
  /\ conn = "ok"
  /\ \E f \in Files :
       /\ <<f, indexView[f]>> \notin evidence
       /\ evidence' = evidence \cup {<<f, indexView[f]>>}
  /\ UNCHANGED <<fileContent, indexView, projEvidence, conn, servedStale, servedDisabled>>

ComputeProjectProduct ==
  /\ conn = "ok"
  /\ Fingerprint(indexView) \notin projEvidence
  /\ projEvidence' = projEvidence \cup {Fingerprint(indexView)}
  /\ UNCHANGED <<fileContent, indexView, evidence, conn, servedStale, servedDisabled>>

\* CURRENT policy: a hit exists only when the stored hash equals the served
\* view's hash — staleness is impossible by key construction.
CurrentServe ==
  /\ conn = "ok"
  /\ \E f \in Files :
       /\ <<f, indexView[f]>> \in evidence
       /\ servedStale' = servedStale
  /\ UNCHANGED <<fileContent, indexView, evidence, projEvidence, conn, servedDisabled>>

CurrentServeProject ==
  /\ conn = "ok"
  /\ Fingerprint(indexView) \in projEvidence
  /\ UNCHANGED vars

\* VULNERABLE policy: key by file identity only; a row computed under any
\* older view still hits, and it is stale whenever its hash differs from
\* the served view's hash.
VulnerableServe ==
  /\ conn = "ok"
  /\ \E f \in Files, h \in Hashes :
       /\ <<f, h>> \in evidence
       /\ servedStale' = (servedStale \/ (h # indexView[f]))
  /\ UNCHANGED <<fileContent, indexView, evidence, projEvidence, conn, servedDisabled>>

\* Any storage error disables the connection for the process lifetime.
CacheError ==
  /\ conn = "ok"
  /\ conn' = "disabled"
  /\ UNCHANGED <<fileContent, indexView, evidence, projEvidence, servedStale, servedDisabled>>

\* A serve attempted while disabled must MISS. The action exists so the
\* break-test can flip it into a violation; in the current policy it is a
\* stutter that records nothing.
DisabledServeAttempt ==
  /\ conn = "disabled"
  /\ UNCHANGED vars

NextCurrent ==
  \/ EditFile \/ Publish \/ ComputeAndStore \/ ComputeProjectProduct
  \/ CurrentServe \/ CurrentServeProject \/ CacheError \/ DisabledServeAttempt

\* Vulnerable variant for FailClosed: serves despite the disabled guard.
VulnerableDisabledServe ==
  /\ conn = "disabled"
  /\ servedDisabled' = TRUE
  /\ UNCHANGED <<fileContent, indexView, evidence, projEvidence, conn, servedStale>>

NextVulnerable ==
  \/ EditFile \/ Publish \/ ComputeAndStore \/ ComputeProjectProduct
  \/ VulnerableServe \/ CacheError \/ DisabledServeAttempt
  \/ VulnerableDisabledServe

CurrentSpec == Init /\ [][NextCurrent]_vars
VulnerableSpec == Init /\ [][NextVulnerable]_vars

TypeOK ==
  /\ fileContent \in [Files -> Hashes]
  /\ indexView \in [Files -> Hashes]
  /\ evidence \subseteq (Files \X Hashes)
  /\ conn \in {"ok", "disabled"}
  /\ servedStale \in BOOLEAN
  /\ servedDisabled \in BOOLEAN

\* THE invariant: nothing stale is ever served.
NoStaleServe == servedStale = FALSE

\* Fail closed: a disabled connection never serves.
FailClosed == servedDisabled = FALSE
====
