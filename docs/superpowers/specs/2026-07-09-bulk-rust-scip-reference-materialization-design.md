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
reference policy boundary. It will load the SCIP index once, materialize the
existing safe definitions, and additionally consider a fixed set of standard
trait implementation symbols. One pure decision receives the parsed trait name
and the number of exact SCIP occurrences:

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
