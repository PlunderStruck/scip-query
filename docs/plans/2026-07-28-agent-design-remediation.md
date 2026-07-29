# Agent-design remediation program

Date: 2026-07-28  
Status: COMPLETE  
Audit: `docs/reviews/2026-07-28-agent-design-audit.md`

## Goal

Turn scip-query's agent-facing lifecycle into a stateful evidence loop whose
ordinary autonomous decisions remain automatic, while stale, incomplete,
incompatible, or high-consequence decisions remain visibly unresolved.

Done means:

- a missing or stale index cannot yield an ordinary clean Stop result;
- one deadline contract gives the gate enough host time to publish its own
  diagnosis;
- exact-finding suppressions can be accepted automatically only when an
  external policy can verify their scope, evidence, risk, and invalidation;
- a gate with suppressions is visibly distinct from a gate with no findings;
- pagination resumes through the same executable that created the snapshot;
- compaction restores unfinished evidence state;
- Stop preserves coverage, analysis-budget, and prior-attempt evidence;
- command envelopes identify the index and worktree generation they observed;
- local writable effectiveness telemetry is not presented as independent
  correctness evaluation;
- focused tests, typecheck, build, public-API checks, and diff-gate pass, or
  every remaining failure is recorded with evidence.

Pre-registered baseline:

- agent-design findings: 10 open;
- silent missing-index Stop paths: 1;
- stale-index false-negative Stop paths: 1 runtime-confirmed;
- host/internal default deadline inequality: `30s < 60s`;
- suppression result state: clean and pass-with-suppressions are currently
  indistinguishable in the Stop path;
- focused audit tests before remediation: 36 passing.

Target:

- 10 findings addressed;
- zero silent missing/stale Stop paths;
- host deadline strictly greater than the child deadline plus shutdown and
  serialization grace;
- automatic exact-finding adjudication covered by positive, negative,
  invalidation, compatibility, and rate-anomaly tests;
- zero documented invocation forms whose continuation changes executable
  identity or evades anti-truncation recognition;
- PostCompact restores a bounded session receipt;
- every common evidence envelope can disclose its authority identity;
- effectiveness output labels local writable observations as telemetry.

## Definitions and invariants

An **observation receipt** is a compact record attached to a command or hook
result that identifies the index generation, Git/worktree state, coverage,
analysis budget, and invocation needed to decide whether that result can be
combined with another. The concrete referents are CLI envelopes, Stop output,
output-page snapshots, and PostCompact state. Its identity fields make stale
or cross-generation reasoning mechanically detectable.

An **evidence lease** is the bounded relationship between one gate execution
and the index/worktree state it observed. Its concrete referents are the
freshness check before Stop, the generation/worktree identity before and
after the gate, and the published result. It is valid only while those
identities remain unchanged.

An **automatic adjudication** is a policy-checked decision that one exact
finding does not require the detector's proposed remediation. Its concrete
referents are a suppression record, its matched finding, structured
counterevidence, risk policy, invalidation fingerprint, and result counts.
Unlike unconstrained self-approval, admission is decided by code outside the
model's prose.

An **escalation** is a durable unresolved result produced when a proposed
decision exceeds automatic policy. Its concrete referents are broad waivers,
incompatible records, high-consequence detector classes, evidence
contradictions, and rate anomalies. It first invokes automated calibration;
human interruption is reserved for ambiguity that remains after those checks.

Invariants:

- I1. Stop reports a normal clean result if and only if the index was fresh
  for the observed worktree before the gate and both identities were stable
  through publication.
- I2. Missing, unknown, stale, refreshing, changed-during-run, timed-out, and
  incompatible evidence states are never rendered as ordinary silence.
- I3. The host deadline must always be greater than the child deadline plus
  explicit process-reaping and output-serialization grace.
- I4. An ordinary automatic suppression must always name exactly one stable
  finding and pass the current adjudication policy.
- I5. Broad waiver authority must never be inferred from a model-authored
  reason string.
- I6. Suppressed findings remain observable in result semantics, event
  history, and Stop feedback.
- I7. A continuation must invoke the same executable identity and immutable
  snapshot that produced the page.
- I8. Compaction must not erase the identity of unfinished output retrieval or
  the latest Stop attempt within the same session.
- I9. Two observations may be combined as same-state evidence only when their
  authority receipts agree.
- I10. Repository-local writable telemetry must never claim independent
  correctness authority.

## Premises

- P1. `handleAgentHookStop` reads the hook payload, calls
  `runIsolatedStopHookDiffGate`, and emits execution failure only when that
  call throws (`src/runtime/agent-hooks.ts:778-790`).
- P2. `runIsolatedStopHookDiffGate` returns `undefined` for both a missing
  workspace and a missing database, and does not call `getIndexFreshness`
  before executing the gate (`src/runtime/agent-hooks.ts:796-814`).
- P3. `getIndexFreshness` already classifies missing, unknown, stale, and
  fresh states from the database, metadata fingerprint, and SQLite generation
  (`src/runtime/index-freshness.ts:21-99`).
- P4. Hook context already owns watcher wake/request behavior through
  `refreshIndexForHookIfNeeded`; extending that coordination is preferable to
  a second reindex path (`src/runtime/agent-hooks.ts:932-980`).
- P5. The installed Stop hook has a 30-second host timeout
  (`src/runtime/agent-hooks.ts:619-628`), while the ordinary isolated gate
  defaults to 60 seconds (`src/runtime/diff-gate-execution.ts:18-20`).
- P6. `executeDiffGate` already produces outcome observations and an optional
  analysis-budget disclosure, but `runIsolatedStopHookDiffGate` returns only
  `.result` (`src/runtime/diff-gate-execution.ts:104-146`;
  `src/runtime/agent-hooks.ts:801-813`).
- P7. `FindingSuppression` currently carries identity/check/file, free-form
  reason, expiry, and creation time only
  (`src/domain/config-types.ts:315-328`).
- P8. `applyStructuredSuppressions` moves a matching finding into
  `result.suppressed`; matching permits stable IDs, legacy IDs, check-only,
  and check+file scopes (`src/queries/impact/diff-gate.ts:491-519`).
- P9. Suppression files already have a conflict-aware single-record writer,
  immutable first creation, explicit compare-and-replace, writer metadata,
  and compatibility decoding (`src/runtime/suppression-writer.ts:57-130`;
  `src/storage/suppression-store.ts:82-151`).
- P10. Output continuation commands hardcode `scip-query` even though the
  snapshot invocation hash is bound to the actual invocation arguments
  (`src/runtime/output-pagination.ts:1165-1192`).
- P11. The PreToolUse recognizer identifies path-prefixed `scip-query`, but
  not supported `node dist/cli.js` or package-runner forms
  (`src/runtime/agent-hooks.ts:704-723`).
- P12. PostCompact resets the native-search marker and immediately returns no
  state (`src/runtime/agent-hooks.ts:876-888`).
- P13. `DiffGateResult` exposes findings, suppressed findings, evidence tiers,
  skipped checks, and record compatibility, but no normal/pass-with-
  suppressions outcome discriminator (`src/queries/impact/diff-gate.ts:181-206`).
- P14. The common command contract defines result and coverage semantics, but
  the common JSON envelope does not yet prove index/worktree authority
  identity (`src/runtime/command-kit/command-descriptor-types.ts:130-177`;
  `src/runtime/command-kit/command-execution.ts`).
- P15. Effectiveness derives fix/suppression rates from repository-local
  outcome events that the coding agent can write or delete
  (`src/queries/health/effectiveness.ts`;
  `src/storage/outcome-events.ts`).

### State-authority premises

- SA1 — Index freshness. Writers are reindex publication and watcher refresh
  publication; readers include status/context, query database opening, and
  the new Stop preparation. The canonical classifier is
  `getIndexFreshness`; Stop must reuse it rather than infer freshness from
  database existence.
- SA2 — Gate lifetime. The child deadline is selected by
  `diffGateTimeoutMs`; the hook host timeout is written by `scipHookGroup`.
  One exported deadline contract must derive both values.
- SA3 — Suppression policy. Persistent writers are `suppress` through
  `writeSuppressionFile` plus legacy manual config; readers are config
  loading, `readSuppressionDir`, `diffGate`, Stop rendering, and
  effectiveness/outcome recording. The compatibility reader must remain
  complete before any record can authorize automatic acceptance.
- SA4 — Output snapshot. The pagination runtime is the sole writer and reader
  of immutable output snapshots/cursors. Session state may reference snapshot
  identity but must not duplicate snapshot content.
- SA5 — Outcome telemetry. Diff-gate outcome recording writes repository
  events; effectiveness reads them. Provenance additions must be additive and
  legacy-readable.

## Current flow

The Stop provider launches `hook-stop` with a 30-second host limit. The
handler resolves the repository and storage paths, treats absent database
state as “nothing to do,” starts an isolated diff-gate child with a default
60-second owned deadline, discards the execution receipt, and returns silence
when there are no unsuppressed findings. The gate loads suppression records,
matches them by ID/check/file plus prose and expiry, moves matches out of the
finding list, and records outcomes. Because neither freshness nor result state
is preserved, stale evidence and automatic suppressions can both be rendered
as ordinary clean completion.

Output pagination independently writes immutable snapshots and transport
cursors, but its emitted command chooses a generic executable token instead
of preserving the executable that generated the snapshot. Hook state resets
after compaction without restoring an unfinished pagination or prior Stop
receipt.

## Affected consumers

Complete compiler-resolved reference checks established:

- `FindingSuppression`: config types, diff-gate, suppression writer, and
  suppression store;
- `runIsolatedDiffGate`: agent Stop, public diff-gate command, and containment
  tests;
- `handleAgentHookStop`: hidden command descriptor;
- `renderStopHookOutput`: Stop handler and focused hook tests.

Broader file-level consumers are bounded by `plan-context`: agent hook setup,
command handlers/descriptors, setup tests, project setup, generated agent
instructions, command documentation, and public declaration output. Each is
assigned to a slice or to final regeneration/verification.

## Reuse decisions

- Reuse `getIndexFreshness`, watcher/service inspection, and refresh-request
  coordination; do not create a second fingerprint or direct reindex path.
- Extend `DiffGateExecutionResult`; do not create a parallel Stop-only gate
  result model.
- Extend `FindingSuppression` and the existing record envelope with optional
  adjudication fields; do not add a second suppression store.
- Put deterministic suppression-policy admission in a pure module consumed by
  writer and gate; keep file I/O in the existing writer/store shell.
- Extend output snapshot invocation metadata; do not persist a second copy of
  output content for compaction.
- Reuse common command-envelope assembly for authority receipts; do not patch
  individual query renderers.
- Extend outcome provenance additively; do not replace legacy event reading.

## Testability design

- Pure cores: Stop preparation state transition, deadline derivation,
  suppression-policy evaluation, invocation recognition, authority-receipt
  comparison, and effectiveness-label selection.
- Injected effects: freshness observation, watcher inspection/request, clock,
  sleep/poll, gate execution, filesystem snapshot access, and worktree
  identity.
- Side-effect shells: lifecycle handlers, isolated child runner,
  suppression writer/store, output snapshot store, and outcome event writer.
- Focused seams: exported preparation/evaluation helpers with dependency
  objects; live CLI integration tests exercise the hidden hook commands.

## Slices

### Slice 1 — Stop evidence lease

Files: `src/runtime/agent-hooks.ts`, focused hook tests, and supporting
freshness/watch types only when required.

Change:

- classify missing/unknown/stale/fresh before gate;
- request or observe watcher refresh without starting a competing reindex;
- wait for a bounded accepted refresh;
- record generation/worktree identity before and after gate;
- publish explicit unresolved feedback for non-fresh and changed-during-run
  states.

Validation:

- missing-index hook output is non-empty;
- stale fixture reproduces the old false negative, then the new path refuses
  it;
- a watcher-published fresh generation proceeds;
- generation/worktree mutation during execution refuses certification.

Deployable: yes.

### Slice 2 — One deadline contract

Files: `src/runtime/diff-gate-execution.ts`,
`src/runtime/agent-hooks.ts`, setup/hook tests.

Change:

- define child deadline, shutdown grace, serialization grace, and host seconds
  in one exported contract;
- derive the installed Stop timeout from it;
- assert `host > child + grace`;
- preserve configured child overrides without silently exceeding host policy.

Validation:

- unit inequality tests;
- child that exceeds its owned deadline publishes the scip-query timeout
  before host expiry;
- generated Codex and Claude hook settings use the derived host limit.

Deployable: yes.

### Slice 3 — Automated suppression adjudication

Files: config types/schema/validation, suppression policy/writer/store,
diff-gate result and rendering, outcome events/effectiveness, focused tests and
docs.

Change:

- add structured reason code, evidence, policy version, invalidation, decision
  provenance, and legacy classification;
- allow the ordinary automatic lane only for exact IDs whose detector/risk,
  evidence, invalidation, compatibility, and rate policy pass;
- route broad/high-consequence/anomalous proposals to a visible policy
  escalation without creating more automatic records;
- reopen expired or invalidated decisions;
- return `pass-with-suppressions` and counts without prompting a human.

Validation:

- positive exact-ID automatic admission;
- prose-only, broad, expired, invalidated, incompatible, high-risk, and rate
  burst cases;
- deterministic graph-fact exception positive and negative cases;
- legacy readability;
- concurrent replacement/conflict tests;
- Stop visibility with zero required human approvals.

Deployable: additive schema/read compatibility first, enforcement in the same
single-deploy group.

### Slice 4 — Preserve Stop execution evidence

Files: isolated execution result, Stop rendering, outcome summaries, tests.

Change:

- retain analysis budget, outcomes, repeated-finding age/count, coverage, and
  adjudication counts through the Stop wrapper;
- render the smallest actionable feedback.

Validation: each field survives isolated transport and appears only when
relevant.

Deployable: yes, after Slice 3 for adjudication counts.

### Slice 5 — Invocation identity

Files: pagination runtime, CLI bootstrap metadata, PreToolUse recognizer,
pagination/hook tests.

Change:

- capture the reviewed executable prefix that created a snapshot;
- emit exact continuation and restart commands using that prefix;
- recognize global, absolute, package-runner, and local built CLI forms in
  anti-truncation enforcement.

Validation: exact-command tests for every supported invocation form, cursor
cross-command rejection, and snapshot-unavailable restart.

Deployable: yes.

### Slice 6 — Session state after compaction

Files: hook context, bounded session receipt store, pagination snapshot
registry, setup tests.

Change:

- persist bounded session evidence state keyed by provider session identity;
- track unfinished snapshot IDs and latest Stop attempt/result;
- restore compact continuation state on PostCompact;
- expire and isolate state across sessions and worktrees.

Validation: same-session restore, cross-session refusal, expiry, completed
snapshot removal, and bounded-size behavior.

Deployable: yes.

### Slice 7 — Common observation receipts

Files: common output envelope/types/schema, generation/worktree authority
helpers, command tests and docs.

Change:

- add index generation, project/worktree identity, Git state, observed time,
  and authority kind to common machine output;
- provide comparison semantics that reject mixed-generation complete-set
  claims;
- reuse receipt in suppression evidence and session restoration.

Validation: schema compatibility, clean/dirty worktrees, generation changes,
  and mixed-receipt comparison.

Deployable: additive public contract; update documentation and public API
snapshot in the same slice.

### Slice 8 — Telemetry authority

Files: outcome event schema/store, effectiveness computation/rendering,
schemas/docs/tests.

Change:

- add observer provenance and gate-run identity;
- label local writable data as telemetry;
- reserve evaluation/precision language for protected or externally attested
  observations;
- report anomalies and samples rather than requesting universal review.

Validation: legacy events, local-agent/local-human/protected-CI rendering, and
  metric-name tests.

Deployable: additive record compatibility first, renderer terminology in the
same slice.

## Attack record

- A1 / I1 / stale source: edit source after index publication, then Stop.
  Outcome: HOLE in current code; repaired by Slice 1.
- A2 / I1 / concurrent watcher: watcher publishes a generation while gate is
  running. Outcome: HOLE in current code; repaired by pre/post lease identity
  in Slice 1.
- A3 / I2 / missing metadata: database exists but metadata is absent.
  Outcome: HOLE in current code; repaired by Slice 1 unknown-state feedback.
- A4 / I3 / non-yielding detector: child reaches 60 seconds while host kills at
  30. Outcome: HOLE in current code; repaired by Slice 2.
- A5 / I4 / fluent prose: model supplies plausible prose for a false broad
  waiver. Outcome: HOLE in current code; repaired by Slice 3 structured
  automatic admission.
- A6 / I5 / check+file authority: one record suppresses all current and future
  findings in a file. Outcome: HOLE in current code; repaired by Slice 3
  escalation.
- A7 / I6 / all suppressed: every finding moves out of `findings` and Stop
  becomes silent. Outcome: HOLE in current code; repaired by Slice 3 result
  semantics and Slice 4 rendering.
- A8 / I7 / local CLI: `node dist/cli.js` creates a page whose continuation
  runs a global package. Outcome: HOLE in current code; repaired by Slice 5.
- A9 / I7 / local truncation: the same local CLI is piped through `head`.
  Outcome: HOLE in current code; repaired by Slice 5 recognition.
- A10 / I8 / compaction: context compacts between page one and page two.
  Outcome: HOLE in current code; repaired by Slice 6.
- A11 / I9 / mixed generation: refs from generation A are combined with
  affected output from generation B. Outcome: HOLE in current code; repaired
  by Slice 7.
- A12 / I10 / self-grading: the agent edits outcome records, then cites a high
  precision score. Outcome: HOLE in current presentation; repaired by Slice 8
  provenance and terminology.
- A13 / autonomy / false-positive volume: automatic admission is replaced by
  per-finding human approval. Outcome: rejected design; Slice 3 must preserve
  autonomous exact-finding decisions.
- A14 / compatibility / old records: new readers reject all v1 suppression or
  outcome files. Outcome: prevented by additive decoding tests in Slices 3 and
  8.
- A15 / durability / concurrent suppression: two writers replace one
  decision. Outcome: existing revision-aware writer holds; Slice 3 tests must
  preserve it.

Coverage matrix:

| Surface | Writers/readers attacked | Attacks |
| --- | --- | --- |
| Index freshness | reindex/watcher → context/Stop/gate | A1, A2, A3 |
| Gate deadline | hook setup → host; runtime → child | A4 |
| Suppression records | CLI/manual writers → store/gate/Stop/effectiveness | A5, A6, A7, A13, A14, A15 |
| Output snapshots | pagination writer/reader → hook/session state | A8, A9, A10 |
| Observation receipts | command envelope → cross-command reasoning | A11 |
| Outcome telemetry | event writer → effectiveness renderer | A12, A14 |

## Execution order and deviation protocol

Slices 1 → 2 → 3 are ordered because trustworthy freshness and deadline
publication must precede policy decisions that rely on gate output. Slices 4
through 8 may follow independently where their schema dependencies permit,
but each lands as one focused, verified change.

If source contradicts a premise, record the deviation here before changing
direction. Do not overwrite concurrent work. Do not edit `skills/**` while
Claude owns those files. Exact `.scipquery/events/**` records produced by
verification are retained with the change.

## Verdict

A slice is ready to implement when its current flow, consumer set, reuse
decision, test seam, and validation are explicit above. The program is
PLANNED-COMPLETE for implementation: 15 attacks, 12 current holes assigned to
specific slices, 1 rejected autonomy regression, and 2 compatibility/
concurrency defenses to preserve. No accepted unresolved hole exists at plan
time.

## Completion record

Completed 2026-07-28. All eight slices and all ten audit findings are
implemented.

The implementation also closed three integrity edges found while exercising
the planned seams:

- output snapshots now resolve their temporary root lazily, so importing
  compaction state does not create a hidden environment dependency;
- outcome events observed at the same millisecond use deterministic lifecycle
  ordering, preventing a stored caught-plus-suppressed pair from reading back
  as open;
- a repository event cannot promote itself to protected evaluation merely by
  claiming `protected-external`; numeric precision also requires a
  separately supplied attestation for the originating gate-run ID.

Watcher freshness retains repository-wide input detection while excluding
scip-query's own events, legacy ledger, releases, and suppression records.
Writing gate telemetry therefore cannot recursively make the source index
stale.

Verification:

- focused telemetry/outcome regression: 55 tests passed;
- focused final import/receipt regression: 57 tests passed;
- repository suite: 265 files and 2,095 tests passed;
- TypeScript typecheck passed;
- formatting, ESLint, public API check, and skill-link validation passed;
- public API change accepted as additive in
  `docs/api/changes/dbd08231cc605e16.json`;
- `cargo check --workspace` passed;
- the locally built `effectiveness --check echo --json` reported
  `local-writable-telemetry`, a numeric
  `resolutionVsSuppressionRate`, null `precision`, provenance gaps, and
  complete record compatibility;
- the locally built `diff-gate` passed with two advisory documentation
  references and no blocking findings. Both advisories cite the still-current
  `src/queries/impact/diff-gate.ts` implementation/configuration surface, so
  no documentation rewrite was warranted.

No `skills/**` file was edited by this implementation. Concurrent skill,
SQL-performance, and durability changes were preserved.
