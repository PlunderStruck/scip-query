# Bulk Rust SCIP Reference Materialization Design

Date: 2026-07-09

## Purpose

Reduce VegaAssistant warm `health --full` from the accepted 80.97–83.86 second
range to at most 50 seconds without changing ordered semantic references,
callees, command payloads, or the zero-incomplete-reference contract.

A SCIP occurrence index is a serialized table of compiler-resolved symbol uses:
its rows refer to concrete source positions, and its essential value here is
that one sequential read can answer many reference questions without one
interactive rust-analyzer request per definition. A semantic fallback is a
compiler-service request used when that table cannot prove the required answer;
its essential role is to preserve correctness at the uncertain boundary.

## Evidence and Alternatives

The accepted Vega warm profile spends 64.585 seconds in the semantic reference
provider loop and 61.130 seconds in rust-analyzer reference requests. Existing
safe SCIP materialization answers 16,592 definitions with 45,329 references,
while 21,629 definitions still fall back. Broadly promoting those definitions
is rejected: fields, types, modules, `Default`, and custom trait implementations
have measured mismatches.

Three approaches were considered:

1. Promote all SCIP occurrences. This has the largest theoretical coverage but
   already changed Vega facts and became slower, so it is unsafe.
2. Promote Vega-specific traits such as `Tool`. The current cache matches for
   those rows, but a project-name allowlist is not a general scip-query policy.
3. Promote only audited standard-trait implementations, then re-profile and
   continue at the next measured bottleneck. This is the selected approach
   because it is repository-independent, fail-closed, and directly removes
   historically slow rust-analyzer tasks.

The current parity audit found 91 fallback standard-trait rows on VegaAssistant:
90 were exact. Every SCIP-positive row was exact. Every SCIP-zero row was exact
except one `From::from` implementation, so zero-reference `From` remains a
fallback. `Default` remains outside this policy because its separate
source-backed implementation has its own definition guard and broad `Default`
occurrences are not exact. SynthRunnerRust had no eligible non-`Default` rows.

## Architecture

`src/semantic/rust/scip-occurrence-references.ts` remains the only occurrence
reference policy boundary. It loads the SCIP companion retained by the same
open SQLite generation handle, materializes the existing safe definitions, and
additionally considers a fixed set of standard trait implementation symbols.
It never reopens the mutable compatibility path during a query. One pure
decision receives the parsed trait name and the number of exact SCIP
occurrences:

- `Default`: reject;
- `From` with zero occurrences: reject;
- audited standard trait with zero or more occurrences: accept;
- custom or unrecognized trait: reject.

The scalar and bulk APIs must call the same decision after the index is loaded.
Missing, unreadable, or malformed SCIP data returns no proof, which delegates
the definition to rust-analyzer. The `all` experiment mode still cannot bypass
these trait guards.

`src/semantic/rust/engine-identity.ts` will include an explicit occurrence
reference policy revision. A policy revision is a cache-key component whose
essential function is to distinguish semantic rows produced by different
acceptance rules. This intentionally invalidates old Rust reference rows once
and prevents cache results from crossing policy versions.

No callee acceptance rule changes in this first slice. The existing combined
reference/callee rust-analyzer request and SCIP callee proof continue to handle
the remaining definitions. If the slice misses the 50-second target, its exact
result stays diagnostic and the next slice is chosen from the new critical-path
profile rather than accepted as the campaign result.

### Profile-Driven Second Slice: Parallel Gap Delegation

The first standard-trait slice preserved the accepted Vega payload but measured
110.189 seconds warm. It promoted 50 definitions, while the reference provider
loop remained 63.521 seconds. The same request spent 60.161 seconds resolving
references and 47.412 seconds resolving callees inside one rust-analyzer
process. A role-bit audit found no SCIP occurrence role that separates the
broad exact and mismatching field/type/module rows, so widening the occurrence
policy would trade away facts.

The second slice keeps the exact bulk policy and changes only the fallback
execution shape. An explicit durable-session experiment switch gives reference
gaps and callee gaps one persistent rust-analyzer worker each. Both workers are
started before either response is awaited, then their responses are merged into
the existing combined response. Reference incompleteness comes only from the
reference response; availability requires both responses; either error fails
the combined request so the existing one-shot fallback remains authoritative.

This is not enabled for the ordinary worker transport and is not silently
enabled for durable sessions before corpus proof. It intentionally doubles the
live analyzer process count during the experiment, so acceptance requires a
large wall-time win, exact payloads, and no fallback—not merely parallel-looking
profile spans.

Measured decision: rejected and reverted. VegaAssistant remained exact, but
parallel warm full health measured 96.200 seconds at concurrency 8, 109.572
seconds at concurrency 16, and 95.185 seconds at concurrency 4. The accepted
single-session range remains faster. The two lanes competed for CPU and memory;
the split is not a viable production tradeoff on the stress corpus.

### Profile-Driven Third Slice: Complete-Response Reuse

The durable helper already survives CLI process exit and invalidates its worker
when source, Cargo inputs, rust-analyzer, compiler environment, protocol, or the
helper build changes. The third slice reuses that same identity boundary to
memoize one complete combined semantic response in memory. A memoized response
is a process-local computation result whose essential property is that it can
be reused only while every input that determines it is unchanged.

The response key includes the full semantic request shape and definition lists,
but omits the absolute readiness deadline because that deadline changes on each
command without changing a completed answer. Request timeout, diagnostics,
settle, retry, concurrency, operation flags, and definitions remain key inputs,
so explicit experiments still execute. Only available responses with no
incomplete reference IDs are retained. Identity invalidation and helper
shutdown clear the entry; import-definition requests do not use it.

This is not a second disk cache: stopping the helper loses the response, and a
session-cold command still performs the full compiler work. It is live-session
reuse under the exact benchmark contract that distinguishes session-cold from
session-warm. The expected warm path still serializes the response through the
normal mailbox and writes the normal evidence rows, so downstream behavior and
durable evidence are unchanged.

Measured decision: accepted. VegaAssistant warm full health measured 41.933
seconds forward and 46.310 seconds in the reverse-order control, both below the
50-second gate. The live semantic request itself fell from 148.531 seconds cold
to 0.680 seconds on the forward warm control. The five-control Vega sequence
reported `created`, `reused`, `invalidated`, `reused`, and `created`; only the
two reused controls hit the response entry. All controls retained the accepted
output hash, ordered reference and callee digests, 38,222 rows of each kind,
zero incomplete Rust references, and no worker fallback.

The same control shape passed locally and on SynthRunnerRust. An inert
`RA_TEST_IDENTITY` value supplied the local and corrected Synth invalidation
control: it is part of the compiler-environment identity because it begins with
`RA_`, but rust-analyzer ignores it, so it tests invalidation without adding the
logging overhead of `RA_LOG=info`. The initial Synth control labeled
`identity-invalidated` was classified `created` because its helper had expired
during the long Vega matrix; it remains diagnostic, and the `-v3` artifact is
the accepted `invalidated` control.

## Correctness and Failure Handling

Focused tests must prove:

- an audited standard-trait implementation with occurrences materializes the
  exact deduplicated positions in both scalar and bulk APIs;
- an audited non-`From` standard-trait implementation with no occurrences is a
  proven empty result;
- zero-reference `From`, `Default`, custom traits, non-Rust symbols, and broad
  field/type/module shapes return no proof;
- malformed or missing SCIP indexes return no proof;
- the semantic engine identity contains the policy revision.

Corpus acceptance requires byte-identical command output and ordered semantic
payload digests against the accepted readiness-v2 baseline, zero incomplete
Rust references, expected durable-session dispositions, and no worker fallback.
The evidence sequence is focused tests, local and Synth controls, a Vega
evidence-cold/session-warm pair, invalidation and reverse-order controls, then
the full repository checks and SCIP diff gate.

## Scope

This design does not enable durable Rust routing by default, change public CLI
output, create another persistent store, hard-code corpus names, weaken timeout
or readiness rules, or promote unproven custom traits. All work stays on `main`
and runs inline without sub-agents.
