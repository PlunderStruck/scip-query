# CLI output modes

Human output is the default for people and agents. It is the command-owned
presentation: reports retain sections and whitespace, and `code` retains a
path/range header, source indentation, and one-based line numbers. It omits
transport metadata that does not help answer the command's question.

Public commands that support structured output share the same three options:

```text
--json         Emit the stable versioned CLI envelope.
--result-only  With --json, emit only the command-owned result.
--compact      With --json, minify the selected JSON form for a program.
```

Use plain `--json` for an integration that depends on producer, schema,
coverage, evidence, arguments, or invocation options. Use `--json
--result-only` for a program that needs just the result. Agents should run the
ordinary command instead; pretty JSON remains structurally noisier than the
human renderer. Both modifiers are rejected without `--json`.

For example, `scip-query code <symbol>` prints source directly. Its result-only
form contains only `file`, resolved `symbol`, `language`, a one-based `range`,
and ordered `{ line, text }` rows. Resolution alternatives are added only when
the requested symbol is ambiguous.

## Stable JSON envelope

A CLI JSON envelope is the public transport record printed by a scip-query
command when a caller selects `--json`. Its real-world units are the JSON
objects read by agents, shell scripts, CI jobs, and other programs. It is a
versioned message format distinguished by one stable outer shape that names
its producer, command, and result contract while leaving the command-specific
payload under `result`.

The current envelope is schema version 1:

```json
{
  "kind": "scip-query-result",
  "schemaVersion": 1,
  "producer": { "name": "scip-query", "version": "0.20.0" },
  "command": "refs",
  "operationRole": "repository-observation",
  "resultSchemaVersion": 1,
  "evidence": "graph-fact",
  "evidenceContext": {
    "schemaVersion": 1,
    "operationRole": "repository-observation",
    "receipt": {
      "schemaVersion": 2,
      "observedAt": "2026-07-30T12:00:00.000Z",
      "facts": {
        "collaborationDomain": {
          "schemaVersion": 1,
          "canonicalizationVersion": 1,
          "hashAlgorithm": "sha256",
          "projection": { "name": "scip-query:collaboration-domain", "version": 1 },
          "digest": "<64 lowercase hex characters>"
        },
        "index": {
          "generation": {
            "schemaVersion": 1,
            "canonicalizationVersion": 1,
            "hashAlgorithm": "sha256",
            "projection": { "name": "scip-query:index-generation", "version": 1 },
            "digest": "<64 lowercase hex characters>"
          },
          "source": "immutable"
        }
      },
      "observedSources": [{ "kind": "index-generation" }],
      "stabilityProofs": [{ "source": "index-generation", "kind": "immutable" }]
    },
    "analysisManifest": {
      "schemaVersion": 1,
      "evidence": "graph-fact",
      "coverage": {},
      "claimQualification": {
        "schemaVersion": 1,
        "origin": "compiler-graph",
        "coverage": { "state": "complete", "returned": 1, "totalKnown": true, "total": 1, "omitted": 0 },
        "producerValidation": { "status": "not-evaluated" },
        "stateAuthority": {
          "policyVersion": 1,
          "authority": "advisory",
          "requiredRelationships": ["collaborationDomain", "wholeContent", "observationStability"],
          "reasons": ["wholeContent:unknown"]
        },
        "repositoryPolicy": {
          "policyId": "scip-query:unresolved-repository-policy",
          "policyVersion": 1,
          "permission": "not-established",
          "reasons": ["No repository action policy was supplied for this claim."]
        }
      }
    }
  },
  "args": ["login"],
  "options": { "json": true },
  "result": {},
  "coverage": {}
}
```

`schemaVersion` governs the outer transport record. `resultSchemaVersion`
governs the payload selected by `command`; it can advance without changing
the transport version. `producer.version` is the installed package version
that emitted the record. `kind` prevents a consumer from mistaking another
JSON protocol for a CLI result.

`operationRole` names the effect of the parsed invocation, independently from
how its result was derived. The closed roles distinguish repository
observation, repository preview, mutation, combined mutation/observation,
environment observation, and tool information. A command with several modes
selects its role from parsed arguments and options before its handler runs.

Repository observations, previews, and composite operations attach
`evidenceContext` automatically at the shared renderer when they hold an open
database. Pure mutations and environment/tool-information results do not
inherit repository-observation authority merely because they emit JSON. The
context repeats the selected operation role so it remains self-contained; the
decoder rejects conflicting top-level and nested roles.

The context's version-2 `receipt` records independent facts about the
collaboration domain, workspace instance, whole repository content, relevant
inputs, index inputs, immutable generation, observed sources, and the
mechanism—if any—that kept each source fixed. Every content-derived identity
names its projection and projection version, canonicalization version, and
hash algorithm. A missing fact means unknown; it is never inferred from a
neighboring identity.

The example identifies the immutable index generation the query actually
held, but it does not contain a fixed repository snapshot or an index-input
alignment proof. Product policy therefore keeps it advisory for completion
even though the index source itself is immutable. `analysisManifest`
separately records how the result was produced and how much was examined.

`claimQualification` keeps five questions independent. `origin` identifies
the method that produced support for the result. `coverage` identifies how
much of the relevant answer the invocation enumerated. `producerValidation`
reports performance against a named versioned corpus when such certification
exists. `stateAuthority` is product policy derived from the receipt rather
than a producer-authored strength label. `repositoryPolicy.permission` states
what response the repository permits. A strong value in one field never
upgrades another.

For a command whose aggregate origin is `mixed`, `families` binds a stable
result selector either to one fixed origin or to an existing per-row
provenance field. This retains the actual origins of findings and result
families instead of forcing a consumer to treat every row as generically
mixed. The legacy top-level and manifest `evidence` values remain during the
additive compatibility window.

When a producer actually reads repository bytes through the fixed-snapshot
boundary, its receipt may additionally contain:

- `facts.wholeContent`, derived from the immutable Git tree plus captured
  dirty, untracked, declared-ignored, deletion, symlink, and executable-mode
  overlays;
- one `facts.relevantInputs` entry for `scip-query:index-inputs`;
- `facts.index.inputs`, derived from the versioned project-input fingerprint
  already persisted with the held generation; and
- a `repository-snapshot` observed source with a `fixed-snapshot` stability
  proof.

Equal `scip-query:index-inputs` projections establish exact alignment between
that snapshot and the immutable generation. A capture race, unsupported input,
or producer that never read repository bytes leaves the snapshot facts absent;
absence remains `unknown`. A producer does not gain whole-content authority
merely because another command could have taken a snapshot.

Version-1 receipts remain readable as legacy provenance. Their path-derived
project identity and mixed worktree hash are not relabeled as collaboration,
workspace, or content identities. Only a legacy index-generation identity can
be compared as the same legacy fact; unproved v2 relationships remain
`unknown`.

The existing top-level `evidence`, `analysisBudget`, and `coverage` fields
remain during the additive migration so older tolerant consumers continue to
work. New consumers may read the nested context. `--result-only` deliberately
omits the common envelope, including this context, and therefore cannot stand
alone as completion evidence.

The machine-readable schema is
[`schemas/cli-json-envelope.schema.json`](schemas/cli-json-envelope.schema.json).
The public `scip-query/runtime` export provides
`decodeCliJsonEnvelope()` and `requireCompatibleCliJsonEnvelope()` for
consumers that want the repository's compatibility policy rather than a
hand-written field check.

## Complete output for agents

An output page is one consecutive, bounded part of the characters a command
rendered. Its real-world units are the `scip-query-output-page` objects and
human page blocks returned after a result exceeds an agent transport's safe
size. It differs from a query limit because it divides already-produced
output without discarding any character: following each emitted continuation
command reconstructs the complete rendered stream.

Every command accepts these global options:

```text
--output-page-size <characters>
--output-cursor <cursor>
```

Run commands normally without choosing a page size. Human output larger than
12,000 characters is paged automatically as ordinary multiline text, not as a
JSON object. Each incomplete page prints one exact continuation command after
its content. Agents must run that command unchanged until the output-complete
marker. Supplying `--output-page-size` changes the character budget; it does
not select JSON. The value counts rendered JavaScript string characters, not
rows, results, model tokens, or bytes. If the complete result fits, scip-query
returns it unchanged and removes the temporary snapshot; a page wrapper exists
only when more content remains. Partial human pages end at the last complete
line within that budget whenever one exists, so the next page begins with its
own heading or source line number; a single line longer than the budget is the
only case that requires a character-boundary split. Do not pipe scip-query
through `head`, `tail`, or a line-range `sed`; those programs discard output
without creating a resumable position.

Default `--json` output remains the ordinary, additively extensible
`scip-query-result` envelope. When that envelope exceeds
12,000 characters, scip-query writes an early stderr warning containing the
exact command that opts into output pages. The paged command returns:

```json
{
  "kind": "scip-query-output-page",
  "schemaVersion": 1,
  "producer": { "name": "scip-query", "version": "0.20.0" },
  "command": "architecture",
  "contentType": "application/json",
  "agentInstruction": "INCOMPLETE EVIDENCE: do not draw conclusions or report completion from this partial page. Run page.continuation.command exactly, then repeat until page.complete is true.",
  "page": {
    "offset": 0,
    "returnedCharacters": 12000,
    "totalCharacters": 48152,
    "omittedCharacters": 36152,
    "remainingCharacters": 36152,
    "complete": false,
    "outputHash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "continuation": {
      "cursor": "<opaque cursor>",
      "command": "scip-query architecture --json --output-page-size 12000 --output-cursor <opaque cursor>"
    }
  },
  "content": "{\n  \"kind\": \"scip-query-result\",\n  ..."
}
```

The cursor is bound to the executable or package-runner prefix, command,
working directory, complete non-pagination argument list, immutable page
number and size, private output snapshot, and SHA-256 of the complete rendered
output. The initial capture records that invocation identity plus each page's
UTF-8 byte range and hash. A continuation reads and verifies only that range,
so retrieving all pages performs linear snapshot I/O and never re-runs the
command. A changed executable identity, page, page size, missing snapshot, or
expired snapshot is rejected with the exact page-one restart command using the
same prefix that created it.

A genuinely partial JSON page must carry `content` as a string because an
arbitrary character boundary is not necessarily valid nested JSON. Run the
emitted continuation exactly until completion. Normal agent work should use
human output, where partial pages remain multiline text rather than a JSON
string.

One snapshot is bounded to 32 million characters, 64 MiB, and 32,768 pages.
The per-user pool is bounded to 32 snapshots and 256 MiB under atomic
reservation. Every incomplete machine-readable page carries a direct
`agentInstruction`; consumers must follow `page.continuation.command` until
`page.complete` is `true`.

Output pages and result coverage answer different questions:

- output pagination says whether every rendered character is retrievable;
- the result envelope's `coverage` says whether the command examined every
  logical result unit.

A completely retrieved page can therefore still contain a bounded or sampled
analysis. Use the result envelope's stated `--full` remediation when present,
then follow output continuation commands until complete.

Invocation coverage counts the semantic result units declared by the command
descriptor. A list command counts top-level rows; a report counts one report;
and a command with a named result field counts only that field. Unrelated
diagnostic arrays do not inflate `returned`. Symbol-selecting commands also
report a separate `coverage.resolution` state—`exact`, `ambiguous`, or
`missing` with its candidate count—because resolving one requested identity
and enumerating that identity's result rows are different completeness
questions.

`refs --limit <n>` uses a generation-bound keyset cursor: each ordinary page
continues after the last returned `(relativePath, line)` and stops once it has
found the requested rows plus one continuation witness. The JSON result reports
`pagination.producer: "source-keyset"` for that bounded producer. Explicit
semantic enrichment (`--full`), Ruby supplemental evidence, and the coarse SCIP
chunk fallback cannot currently resume before complete materialization; those
pages preserve their evidence but report
`pagination.producer: "complete-only"` instead of implying that `--limit`
bounded the analysis work. Version-1 offset cursors remain readable and their
next continuation is upgraded to the version-2 keyset format. Every result
cursor is rejected after the index generation changes.

The machine-readable page schema is
[`schemas/cli-output-page.schema.json`](schemas/cli-output-page.schema.json).
Page sizes range from 256 through 100,000 characters and cursors are limited
to 4,096 characters. The first paged invocation streams the complete output
to a mode-`0600` snapshot beneath a current-user mode-`0700` temporary
directory while retaining only the requested page in memory. Snapshots expire
after one hour and are removed after the final page. Pagination imposes no
arbitrary total-output ceiling and does not silently discard later pages;
command-level result budgets still apply and report their own completeness.

## Compatibility policy

The decoder accepts:

| Input                                                               | Meaning                                       | Consumer action                                                |
| ------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| Unversioned legacy envelope                                         | The public shape emitted before schema v1     | Read as supported legacy v0; plan migration                    |
| `kind: "scip-query-result"`, `schemaVersion: 1`                     | Current transport contract                    | Read the named result schema                                   |
| A supported envelope with an unknown command `resultSchemaVersion`  | A command payload this consumer does not know | Reject that payload without changing unrelated command schemas |
| A higher or otherwise unsupported positive envelope `schemaVersion` | An outer contract this consumer does not know | Reject with producer/version context                           |
| Missing required identity or transport fields                       | A malformed or different message              | Reject with the failed boundary                                |

Consumers must ignore unknown fields. Additive fields can therefore ship in a
minor release. A field removal, type change, meaning change, or previously
optional field becoming required needs a new relevant schema version.
Deprecated aliases remain available for a documented compatibility window;
removing one requires a major contract transition.

The committed v0 and v1 fixtures in `tests/fixtures/` prove that the newest
decoder reads both generations. The v1 fixture also contains an unknown
additive field so tests prove tolerant reads rather than exact-key coupling.

## Effectiveness telemetry authority

`effectiveness --json` reports both handling outcomes and the authority of the
observer that produced them. Repository-local agents and humans can edit the
same `.scipquery/events/` and suppression files being summarized, so their
rows use `authority: "local-writable-telemetry"` and expose
`resolutionVsSuppressionRate`. The legacy `precision` result field remains
present but is `null` for writable, mixed, or self-asserted populations. It is
numeric only when every event in that population is a `protected-ci`
observation with `protected-external` authority and the caller supplies its
gate-run ID through a separately controlled attestation set. The built-in
repository-history command supplies no such set, so writable JSON cannot
self-promote into an independent grade. External evaluators can call the
public `computeEffectiveness()` export from `scip-query/queries` with
`protectedGateRunIds` obtained from their separately controlled corpus.

The result also includes observer counts, distinct and missing gate-run
identities, and bounded anomaly samples. Those samples identify calibration
work without requiring a human to approve every ordinary automated
suppression. `recordCompatibility.outcomeEvents` remains the independent
statement about whether every event file was readable; neither compatibility
nor Git can prove that a writable event file was never deleted.

## Other JSON protocols

The hidden `__health-phase` and `__diff-impact-batch` commands are
same-package child-process messages, not public `--json` responses. They use
the independently versioned `scip-query-isolated-analysis` protocol and are
validated for protocol name, schema version, producer, command, and result
before the parent accepts them.

The `hook-context`, `hook-pretool`, and `hook-stop` outputs implement the
Codex or Claude host's hook schema. Those hosts are the protocol owners, so
scip-query must not add its CLI envelope fields to their messages. The hook
event discriminator supplied by the host contract identifies those records.

## Evolution checklist

1. Keep existing fields and meanings when making an additive change.
2. Bump `resultSchemaVersion` when one command's payload breaks compatibility.
3. Bump `schemaVersion` when the shared outer record breaks compatibility.
4. Keep a fixture for the previous supported generation and teach the decoder
   whether to migrate or reject it.
5. Update the JSON Schema, this guide, the command reference, and compatibility
   tests in the same change.
