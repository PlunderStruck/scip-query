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
  "producer": { "name": "scip-query", "version": "0.19.6" },
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
