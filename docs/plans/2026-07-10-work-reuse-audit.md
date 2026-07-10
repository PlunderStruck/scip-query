# Work Reuse Audit

Date: 2026-07-10
Status: Complete

## Goal

Replace manual profile inspection with one ranked command that identifies the
same computation running more than once. The command must distinguish repeated
work from several different inputs that happen to share a span name, and it
must separate duplication inside one CLI run from recomputation across runs.

A work identity is a compact fingerprint of the inputs that determine one
computation's result. Two profile events represent the same work only when the
operation name and this fingerprint are both equal. A run identity is the
identifier shared by one top-level CLI invocation and the worker processes it
starts; it makes within-run duplication directly observable.

## Current Evidence

- `src/instrumentation/profile.ts` writes command, cache-state, span, duration,
  and caller metadata, but it has no run or work identity.
- `scripts/profile-scoreboard.mjs` groups only by command, span, and cache
  state. It can rank expensive span names, but it cannot tell whether six
  `consumer-evidence.product` events used the same definition set or six
  different sets.
- A two-run `wrapper-candidates --json --full` baseline produced 4,071 profile
  events. The current scoreboard reported six consumer-evidence products
  totaling 1,880ms, including 1,175ms of provenance and 704ms of
  classification, but cannot classify any of that time as repeated work.
- `profileSpan` has more than twenty direct consumers, so its existing call
  signature and legacy event shape must remain valid.
- `consumerEvidenceProduct()` is used by wrapper, stale-abstraction,
  not-implemented, and locality analysis. Its product is the first instrumented
  target because profiles already show it as a large repeated span.

Run history: `docs/benchmarks/runs/2026-07-10-work-reuse-audit.jsonl`.

## API Impact

- **Risk:** medium. The profiler extension is additive, but `work-audit` is a
  new public CLI command.
- **Direct consumers:** existing `profileSpan` callers remain source-compatible;
  command descriptors feed CLI registration, generated command reference,
  command-contract tests, and bundled skill coverage.
- **Required co-changes:** command handler, descriptor, generated command
  reference, hyper-optimization skill guidance, watch-service exclusion, and
  focused tests.
- **Migration:** compatible extension. Legacy JSONL remains readable and is
  counted as uninstrumented rather than guessed into repeated-work groups.
- **Rollback:** remove the new descriptor/analyzer and the optional metadata;
  no stored project schema or command output is changed.

## Design

1. Add a profile run identity without changing `profileSpan`'s arguments. The
   top-level CLI initializes it before command execution, and subprocesses
   inherit it through the environment.
2. Establish two optional event fields:
   - `workIdentity`: the stable input fingerprint for the named span;
   - `workOutcome`: whether that event computed or reused the result.
3. Add a pure TypeScript analyzer that groups by span and work identity,
   retains command/run provenance, and ranks only groups with multiple
   computations.
4. Report:
   - within-run duplicate count and time;
   - later-run recomputation count and time, which is a durable-cache
     opportunity rather than proof that caching is safe;
   - total estimated avoidable time, equal to all computation time after the
     first observed computation for that exact work identity.
5. Expose `scip-query work-audit <profile>` with `--top` and `--json`.
6. Instrument consumer-evidence product, provenance, and classification with
   one shared identity derived from the definition symbols and semantic/source
   options plus the existing project evidence fingerprint. Identity hashing
   runs only while profiling is enabled; if the project fingerprint is
   unavailable, the event stays unclassified rather than claiming equivalence
   across unknown project states.

## Testability

| Behavior | Test seam | Contract |
|---|---|---|
| Run identity crosses profile events | `tests/runtime/profile.test.ts` | explicit run IDs are preserved; generated IDs are non-empty |
| Repeated work is ranked correctly | pure audit unit fixture | distinct inputs never count as repeats; within/across-run time is separated |
| Legacy profiles remain valid | pure audit unit fixture | events without work identity are counted as uninstrumented and never guessed |
| CLI surface is complete | CLI contract and command-reference tests | descriptor, help, JSON envelope, docs, and skill coverage agree |
| Consumer evidence has stable identity | profiled consumer-evidence fixture | product/provenance/classify events share the same non-empty identity |
| Results remain unchanged | wrapper-candidates output hash | profiling and audit metadata do not alter detector output |

## Verification

- `npx vitest run tests/runtime/profile.test.ts tests/runtime/profile-work-audit.test.ts tests/queries/internal/consumer-evidence.test.ts tests/runtime/cli-contract.test.ts tests/runtime/watch-service.test.ts`
- `npm run typecheck`
- `npm run build`
- repeat profiled `wrapper-candidates --json --full`, then run
  `node dist/cli.js work-audit <profile> --json`
- compare command output hashes with the pre-edit baseline
- `node dist/cli.js recent-duplicates --json --full`
- `node dist/cli.js unused-params --json --full`
- `node dist/cli.js reindex && node dist/cli.js diff-gate --json`
- invoke `scip-verify`

## Acceptance

- One command identifies exact repeated consumer-evidence computations and
  ranks them by measured opportunity.
- The report never labels same-name/different-input spans as duplicates.
- Multi-process health profiles share a top-level run identity.
- Legacy profile files remain readable.
- Profiled and unprofiled detector outputs match.
- The benchmark run history records the baseline, accepted result, and any
  rejected implementation attempt.

## Measured Result

The audit processed 6,505 profile events in 145ms median / 151ms p95. The final
project-fingerprinted run processed 6,240 events and identified 27 work-bearing
consumer-evidence stage events across three command runs, split into three exact
definition-set identities. Each identity was computed once per command run, so
within-run duplicate time was zero. The largest cross-run product opportunity
was 518ms across the two later runs. This points the next optimization at
durable consumer-evidence reuse with correct project/input invalidation, not
another command-local memo.

An uncached composite health run produced 10,081 events from 14 processes with
one shared run identity. Profiled and unprofiled wrapper outputs both hashed to
`4335a8088f82e39621dbbe2b3b255e1548178e2e27b69092367a13e7d0650f31`.
The final diff gate reported zero blocking and zero advisory findings.
