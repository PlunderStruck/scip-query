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
- `schemaVersion: 1`;
- the stable `suppressionIdentity`;
- producer name/version and creation/update timestamps;
- the existing suppression target and reason fields.

The discriminator is additive within suppression v1. Older v1 readers permit
unknown properties, so they continue to read newly written records. Current
readers also accept v1 records written before the discriminator was added and
unversioned legacy records. The filename remains the conflict domain:
different suppression identities merge as different paths, while policy
changes to one identity require revision-aware replacement.

If a future or malformed suppression is omitted, it cannot waive a finding.
`diff-gate` keeps the matching finding unsuppressed and reports incomplete
suppression coverage in JSON, human output, and Stop-hook feedback.

## Current outcome-event records

New records conform to
[`schemas/outcome-event-record.schema.json`](schemas/outcome-event-record.schema.json).
They retain all semantic event fields at the root and add:

- `kind: "scip-query-outcome-event"`;
- `schemaVersion: 1`;
- `eventIdentity`, the JSON tuple of check, finding ID, transition, and
  observed commit;
- producer name/version.

Keeping semantic fields at the root lets the immediately prior permissive
reader consume new records. Current readers accept both these v1 records and
the existing unversioned event files.

The immutable filename is still a timestamp plus a hash of the complete
record bytes. Deduplication does not use that path or producer metadata; it
uses the semantic `eventIdentity`. If legacy and current records describe the
same fact, stronger comparison evidence wins and then the earliest timestamp
wins, as before.

## Partial history is conservative

`effectiveness --json` includes
`recordCompatibility.outcomeEvents`. Human output prints the same incomplete
coverage counts before any metrics. Metrics use only accepted records and are
therefore explicitly partial when `complete` is false.

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
- Rolling back to the immediately prior release remains safe because new
  metadata is additive and prior readers ignore unknown fields.
