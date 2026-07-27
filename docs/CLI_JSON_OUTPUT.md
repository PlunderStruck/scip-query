# CLI JSON output contract

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
  "producer": { "name": "scip-query", "version": "0.19.8" },
  "command": "refs",
  "resultSchemaVersion": 1,
  "evidence": "graph-fact",
  "args": ["login"],
  "options": { "json": true, "compact": true },
  "result": {},
  "coverage": {}
}
```

`schemaVersion` governs the outer transport record. `resultSchemaVersion`
governs the payload selected by `command`; it can advance without changing
the transport version. `producer.version` is the installed package version
that emitted the record. `kind` prevents a consumer from mistaking another
JSON protocol for a CLI result.

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

Human output larger than 12,000 characters is paged automatically. The page
prints its exact continuation command both before and after its content.
Agents must run that command unchanged and continue until the page reports
completion. Do not pipe scip-query through `head`, `tail`, or a line-range
`sed`; those programs discard output without creating a resumable position.

Default `--json` output remains the ordinary `scip-query-result` envelope
byte-for-byte so existing scripts are not broken. When that envelope exceeds
12,000 characters, scip-query writes an early stderr warning containing the
exact command that opts into output pages. The paged command returns:

```json
{
  "kind": "scip-query-output-page",
  "schemaVersion": 1,
  "producer": { "name": "scip-query", "version": "0.19.8" },
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

The cursor is bound to the command, working directory, complete
non-pagination argument list, next character offset, private output snapshot,
and SHA-256 of the complete rendered output. SHA-256 is a fixed-size content
fingerprint: the same bytes produce the same identity with overwhelming
reliability. A continuation reads the immutable snapshot rather than re-running
the command, so timestamps, durations, edits, or reindexes cannot mix
different result generations between pages. Missing, expired, or changed
snapshot data is rejected with the exact command that restarts at page one.
Every incomplete machine-readable page also carries a direct
`agentInstruction`. A partial page is not sufficient evidence for a conclusion
or completion claim; consumers must follow `page.continuation.command` until
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
