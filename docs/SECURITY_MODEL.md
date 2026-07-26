# Security model

`scip-query` treats a checked-out repository and every index or cache artifact
derived from it as untrusted input. An untrusted checkout is a directory of
files supplied by a project rather than by the operator, distinguished from
ordinary input by being able to name source paths, tools, configuration, and
persisted records that the CLI may otherwise be tempted to trust.

The default analysis boundary may read repository files and managed,
rebuildable cache artifacts. It may not execute a repository-selected program,
adopt an arbitrary cache directory, escape the canonical project root through
an indexed path, or install a mutable tool identity merely because the
checkout requests it.

## Explicit authority

An authority grant is an operator action that permits one otherwise-forbidden
effect, distinguished from project configuration by coming from the current
CLI invocation:

- `--trust-project-tools` permits reviewed repository-local indexer
  executables for that invocation.
- `--tla-tools <jar>` selects a reviewed TLA jar explicitly. The default
  downloaded TLA artifact remains version- and SHA-256-pinned.
- `--install-missing` permits installation of the exact immutable tool
  identities listed by the command. Without it, missing tools produce setup
  instructions instead of a mutation.
- environment overrides such as `SCIP_QUERY_CACHE_DIR` are operator-owned
  storage choices. Tracked `.scipquery.json` cannot grant destructive authority
  over an arbitrary external cache.

A managed cache is rebuildable local state rooted under a scip-query-owned
directory, distinguished from a caller-selected directory by an ownership
record and canonical containment checks. Destructive cache operations require
both properties.

## Input budgets

An input budget is a maximum amount of untrusted data one operation will
materialize or ask a parser to compile, distinguished from silent truncation by
failing explicitly with the input kind, observed amount, and accepted limit.

| Input class                                            |                    Limit | Representative users                                                     |
| ------------------------------------------------------ | -----------------------: | ------------------------------------------------------------------------ |
| Config, manifest, lock, lease, and other small records |                    8 MiB | `.scipquery.json`, package manifests, generation metadata, hook settings |
| One source or per-document fragment                    |                   64 MiB | indexed source reads, TypeScript/Vue snapshots, mailbox result payloads  |
| One SCIP index artifact                                |                  512 MiB | merge, sanitize, Rust occurrence fallback, shared-generation hydration   |
| Profile or retained JSONL artifact                     |                  256 MiB | profiling audits, legacy event ledgers, rotating diagnostic segments     |
| Generated TLA trace                                    | 16 MiB and 100,000 steps | `tla instrument` recorder                                                |
| Repository-supplied regular-expression pattern         |         4,096 characters | entry-root patterns and TLA statement bindings                           |
| Agent hook standard input                              |                    8 MiB | stop-hook request payload                                                |

Regular files are opened first, checked through that descriptor, read, and
checked again so replacement or growth cannot bypass the pre-read limit.
Streams and pseudo-files are counted while reading. Large file fingerprints
are computed in fixed-size chunks rather than by retaining the complete file.

An oversized artifact is not partially interpreted. Operations that require
the complete artifact fail and name the limit; query-level detectors that
intentionally sample or cap logical rows retain their existing machine-readable
coverage metadata and `--full` remediation.

## Complete command output

Output pagination is a resumable transport for one rendered command result,
distinguished from a result limit by preserving every rendered character.
Human output above 12,000 characters automatically includes the exact command
for the next page. Large default JSON remains byte-compatible and writes the
exact opt-in paging command to stderr before and after the JSON stream.

Every command accepts:

```text
--output-page-size <characters>
--output-cursor <cursor>
```

The opaque cursor binds the command, working directory, non-pagination
arguments, next character offset, private output snapshot, and complete output
hash. The first invocation streams the output to current-user temporary
storage with private permissions while retaining only one page in memory.
Continuations read that immutable snapshot instead of re-running a command
whose timestamps or durations may change. Snapshots expire after one hour and
are removed after the final page; an unavailable snapshot produces the exact
page-one restart command.

Continue until `page.complete` is `true`. Do not pipe output through `head`,
`tail`, or a line-range `sed`; those programs discard data without creating a
resumable position. See [CLI JSON output](CLI_JSON_OUTPUT.md) and the
[output-page schema](schemas/cli-output-page.schema.json).

## Terminal and JSON output

Human terminal output is presentation text written to an interactive terminal,
distinguished from JSON by being able to activate terminal control sequences.
Repository-controlled human fields therefore have control bytes rendered
inert. JSON values retain their printable data and are protected by JSON
encoding rather than human-output rewriting.

Registry and release diagnostics redact URL user information and
credential-bearing query fields before rendering nested errors.

## Reporting a security issue

Do not include a live credential, private repository, or destructive
proof-of-concept target in a public report. Describe the affected command,
platform, trust flags, and smallest disposable reproduction needed to
distinguish the boundary failure.
