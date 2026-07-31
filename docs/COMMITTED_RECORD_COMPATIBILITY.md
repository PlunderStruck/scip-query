# Committed record compatibility

scip-query stores two kinds of team-shared records in Git:

- `.scipquery/suppressions/*.json` contains accepted detector-policy
  decisions.
- `.scipquery/events/*.json` contains immutable finding-transition
  observations used by `effectiveness` and cross-HEAD repair verification.

A committed record is a repository-owned JSON fact or policy whose value
comes from surviving clones and branches. Unlike a local cache row, it cannot
be silently dropped and rebuilt when a reader does not understand it.

## Compatibility states

Every JSON candidate is classified exactly once:

| State                | Meaning                                                           | Included in conclusions? |
| -------------------- | ----------------------------------------------------------------- | ------------------------ |
| `legacy`             | A supported unversioned record from an earlier scip-query release | Yes                      |
| `current`            | A record matching the current discriminator and schema            | Yes                      |
| `unsupported-older`  | A versioned record older than the supported overlap window        | No                       |
| `unsupported-future` | A record written by a newer incompatible schema                   | No                       |
| `malformed`          | Invalid JSON, fields, discriminator, metadata, or stable identity | No                       |

`complete` is true only when every candidate is `legacy` or `current`.
Readers return accepted records together with `total`, `accepted`, `omitted`,
the per-state counts, and path-specific issues. A subset may still support a
conservative result, but it must not be represented as complete.

## Current suppression records

New records conform to
[`schemas/suppression-record.schema.json`](schemas/suppression-record.schema.json).
They carry:

- `kind: "scip-query-suppression"`;
- `schemaVersion: 2`;
- the stable `suppressionIdentity`;
- producer name/version and creation/update timestamps;
- the exact suppression target and explanatory reason;
- a controlled adjudication reason code;
- inspectable counterevidence, including content hashes for file referents;
- the policy version, decision provenance, and invalidation conditions.

Current readers accept v1 and unversioned records as legacy policy so history
is not lost. Legacy records do not have enough mechanically checkable evidence
to authorize automatic acceptance: matching findings remain visible as policy
escalations until the record is explicitly replaced with a v2 decision.
Earlier readers classify v2 as unsupported-future and therefore fail closed
instead of silently treating the new evidence fields as optional. The filename
remains the conflict domain: different suppression identities merge as
different paths, while policy changes to one identity require revision-aware
replacement.

If a legacy, future, malformed, expired, or content-invalidated suppression
cannot pass current policy, it cannot waive a finding. `diff-gate` keeps the
matching finding unsuppressed and reports incomplete coverage or the exact
policy-escalation reason in JSON, human output, and Stop-hook feedback. A
successful gate that did accept one or more v2 decisions reports
`pass-with-suppressions`, preserving the difference between an ordinary clean
pass and an adjudicated exception.

## Current outcome-event records

New records conform to
[`schemas/outcome-event-record.schema.json`](schemas/outcome-event-record.schema.json).
They retain all semantic event fields at the root and add:

- `kind: "scip-query-outcome-event"`;
- `schemaVersion: 1`;
- `eventIdentity`, the JSON tuple of check, finding ID, transition, and
  observed commit;
- producer name/version;
- `gateRunId`, the logical diff-gate observation shared by retries;
- observer kind and whether its authority is repository-writable or protected
  externally;
- the versioned observation receipt;
- the adjudication policy version on suppressed transitions.

Keeping semantic fields at the root lets the immediately prior permissive
reader consume new records. Current readers accept both these v1 records and
the existing unversioned event files.

An observation receipt is the factual record of which repository-state
sources an operation actually held and how those sources were kept stable
while it read them. Version 2 separates collaboration domain, workspace
instance, whole content, relevant inputs, immutable index generation, and
stability proofs so equality in one relationship cannot silently prove
another. Every content-derived identity includes its projection and
canonicalization versions. Missing facts remain unknown, and policy derives
completion authority when consuming the receipt rather than trusting a
self-asserted authority label.

Version-1 receipts remain readable without reinterpretation. Their
path-derived project identity and mixed worktree identity do not establish
version-2 collaboration, workspace, content, or stability facts. Durable
suppression and outcome records may therefore contain either receipt version
during the overlap window; readers fail closed on malformed or unsupported
receipt versions.

The immutable filename is still a timestamp plus a hash of the complete
record bytes. Deduplication does not use that path or producer metadata; it
uses the semantic `eventIdentity`. If legacy and current records describe the
same fact, comparable-base proof wins first, then protected/provenance-bearing
evidence, and then the earliest timestamp.

Observer kind says who originated the record: `local-agent`, `local-human`,
or `protected-ci`. Observer authority says what conclusion the record can
support. Both local kinds remain `repository-writable`, because the observer
can edit the same event and suppression files being measured.
`protected-external` is accepted only with `protected-ci` records produced by
a separately controlled evaluator and a gate-run attestation delivered
outside the writable event directory; a record field cannot attest itself
and ordinary CLI environment settings cannot mint that authority.

## Partial history is conservative

`effectiveness --json` includes
`recordCompatibility.outcomeEvents`. Human output prints the same incomplete
coverage counts before any metrics. Metrics use only accepted records and are
therefore explicitly partial when `complete` is false.

`effectiveness` calls the ordinary local ratio
`resolutionVsSuppressionRate`. It publishes `precision` only when every event
in the evaluated population claims protected external authority and its
gate-run ID appears in a separately supplied attestation set. Mixed,
unattested, repository-writable, and legacy populations remain telemetry and
carry a null precision field. Provenance gaps, unattested authority claims,
mixed authority, missing gate-run identity, and anomalous suppression rates
produce bounded sample reports, not a mandatory per-suppression human queue.
Git preserves history that is present; deleting an event file cannot be
detected from the remaining directory, so the command never describes
repository-local totals as an independent grade.

Cross-HEAD repair verification needs complete committed history to establish
the prior lifecycle anchor. If any event candidate is incompatible, scip-query
retains every missing local-ledger finding and defers resolution. An omitted
record can therefore delay a verified fix, but it cannot manufacture one.

## Legacy JSONL migration

`.scipquery/ledger/events.jsonl` remains readable during the overlap window.
On the next event append:

1. every non-empty line is classified;
2. compatible lines are copied to independent current event files;
3. new observations are appended normally;
4. the legacy ledger and its `merge=union` attribute are removed only if
   every line was compatible.

If even one line is unsupported or malformed, the original ledger stays
byte-for-byte present and the append reports a warning. Repeating the append
is safe: exclusive content-addressed event creation makes already-copied rows
idempotent. Upgrade scip-query or repair the named malformed line before
removing the legacy ledger.

## Merge and rollback rules

- Commit suppression and event files with the code or documentation change
  that produced them.
- Do not rewrite all legacy files just to make compatibility counters
  “current.” Read overlap is the migration mechanism.
- Resolve a same-suppression-path conflict by reviewing both policy decisions;
  never choose a side mechanically.
- Independent event files should normally keep both sides of a merge.
- Do not delete an unsupported record to make a warning disappear. Use a
  reader that supports it, or deliberately migrate it with verified tooling.
- Rolling back remains fail-closed: older readers reject v2 suppressions as
  unsupported-future, so they cannot accidentally waive a finding using a
  policy they do not understand.
