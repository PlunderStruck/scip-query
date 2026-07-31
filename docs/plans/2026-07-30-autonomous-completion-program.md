# Autonomous repository completion program

Date: 2026-07-30

## Goal

Feature: An autonomous coding agent can carry a supported repository change
from an authorized goal to independently verified completion without routine
human approval or ceremonial work.

Done means the agent retains its goal and work state across long execution,
receives current evidence without manually assembling provenance, sees the
effects of its actions, resolves or preserves every necessary consequence, and
cannot make completion easier merely by editing the artifacts that judge it.

## Performance contract

Correct completion is the threshold, not one side of a speed-versus-quality
trade. Compare otherwise identical agents from goal receipt to verified
completion, counting failed attempts and rework.

The scip-query workflow is acceptable when it:

1. increases the probability of full completion without unacceptable
   regressions, false blocking, or architecture violations; and
2. improves either elapsed time or model-token use without an unacceptable
   regression in the other.

A mandatory agent action must change the target, supply decision-relevant
information, preserve otherwise-lost state, verify an effect, or preserve a
live obligation. If it does none of those things, remove it or make it an
automatic byproduct.

Pre-change observations for the first slice:

- the committed pre-change CLI completed `stats --json --compact` in a
  244.0 ms median across five warm local runs;
- common database-backed JSON output does not contain an observation receipt;
  and
- the current diff gate has zero findings.

The first slice must add zero agent commands to the workflow and must keep the
same command within a 20% local median runtime regression. This threshold is a
slice guard, not the final mission trial.

## Current flow

Descriptor-backed query handlers run with an open `ScipDatabase`, produce a
command-owned result, and send it through `runCommandOutput()` or a direct
`printJsonEnvelope()` call. `printJsonEnvelope()` already adds producer,
command, evidence-tier, coverage, budget, and pagination-compatible output
metadata through the versioned common envelope.

The existing observation-receipt contract can identify an immutable index
generation and, when a consumer actually observes it, a local worktree state.
Stop-hook records already use the same receipt type. Ordinary query envelopes
do not include a receipt, so agents cannot safely relate outputs after
repository changes.

The current receipt is schema version 1. It is useful local provenance but does
not yet establish the version-2 collaboration, whole-content,
relevant-input, and fixed-snapshot relationships in the redesign. The first
slice must label and preserve it honestly rather than promote it to
completion-authoritative evidence.

## Affected consumers

The complete `plan-context --full printJsonEnvelope` pass found
`printJsonEnvelope()` in the shared command execution module with ten direct
external consumers and repository-wide use through command builders. The
public envelope type is exported from `./runtime`; its schema, fixtures, API
report, CLI documentation, pagination snapshots, and runtime contract tests
are affected.

Direct command payloads remain unchanged. `--result-only` deliberately omits
the envelope and therefore cannot stand alone as completion evidence.

## Reuse decision

Extend `CliJsonEnvelopeV1` additively and reuse the existing
`ObservationReceipt` contract and `buildObservationReceipt()`. Ordinary index
queries record the held index only; they do not hash and imply observation of
the live worktree. Do not introduce a second receipt type, parallel output
renderer, sidecar file, or agent-authored provenance step.

The first slice injects receipts only where the shared database-backed query
pipeline establishes that a repository observation occurred. Operation-role
classification and receipt version 2 follow in the next slice; mutation and
tool-only commands must not be mislabeled merely because they emit JSON.

## Slices

### 1. Automatic local observation provenance

Status: implemented and verified on 2026-07-30.

Files and symbols:

- `src/runtime/cli-json-envelope.ts`
- `src/runtime/command-kit/command-execution.ts`
- `src/runtime/index.ts`
- `tests/runtime/cli-json-envelope.test.ts`
- `tests/runtime/code-cli-contract.test.ts`
- `tests/runtime/output-pagination.test.ts`
- `docs/schemas/cli-json-envelope.schema.json`
- `docs/CLI_JSON_OUTPUT.md`
- `docs/api/scip-query.api.json`

Change:

- add an optional schema-versioned evidence context carrying the existing
  observation receipt;
- inject it from the shared database-backed query renderer;
- preserve legacy top-level analysis fields during the additive migration;
- leave `--result-only` explicitly envelope-free and non-authoritative; and
- verify pagination replays the original serialized context.

Validation:

- focused envelope and pagination tests;
- typecheck and build;
- API compatibility check;
- before/after five-run `stats --json --compact` timing; and
- `scip-query diff-gate`.

Observed result:

- ordinary database-backed JSON output now receives one
  `evidenceContext` automatically at the shared renderer;
- the existing receipt remains explicitly local, version-1,
  `not-certified` provenance rather than completion authority;
- tool-only `status --json` and `--result-only` output do not acquire a false
  evidence context;
- paginated output reconstructs the exact original serialized context;
- focused envelope, pagination, and CLI integration tests passed 39 of 39;
- typecheck, build, lint, and the public-API check passed;
- the full suite passed 2,188 of 2,193 tests; the five failures are the
  unrelated shared-worktree integration file attempting to spawn relative
  indexer paths that do not exist inside its temporary repositories, and the
  same five failures reproduce when that unchanged file runs alone;
- the final median was 243.3 ms across nine warm runs versus the exact
  committed 244.0 ms baseline, effectively no runtime regression;
- the API acceptance record classifies the actual optional-field/export
  change as compatible while recording the declaration bundler's conservative
  alias-renumbering signal;
- `scip-query diff-gate` passed with zero findings after the final edit; and
- `scip-query health --baseline` reports 96 repository-wide deltas against its
  older committed baseline. The changed renderer remains a
  workflow-orchestration extraction signal after its evidence-context builder
  was isolated; the final diff gate does not classify it as a new defect.

An intermediate implementation hashed Git status and the full tracked diff on
every query. It measured 291.3 ms in an early run and 361–375 ms under later
verification load. It was rejected because the index-backed query had not
observed the live worktree and the extra cost bought no valid authority. The
final `index-only` receipt records exactly the state source the query held.

### 2. Honest operation roles and receipt version 2

Add parsed-invocation result roles for repository observation, preview,
mutation, composite, environment observation, and tool information. Replace
path-derived combined identities with collaboration, workspace, whole-content,
relevant-input, index-input, generation, and stability facts. Legacy receipts
decode as lower-authority evidence.

Validation is contract-driven across every public JSON operation, with
mutation tests proving that setup and write commands cannot inherit an
observation role by default.

Before editing, establish only the contracts this slice consumes:

1. the generated operation-role registry and the parsed argument that selects
   each role;
2. the version-2 receipt's collaboration, workspace, content, relevant-input,
   index-input, generation, and stability facts;
3. the named comparison results and the policy function that derives
   authority from those facts; and
4. the additive decoder/migration behavior for version-1 receipts.

These are implementation-slice decisions. They do not reopen the mission,
completeness definition, autonomy envelope, or anti-ceremony performance
contract unless repository evidence contradicts one of those settled
premises.

### 3. Composable claim meaning

Replace the coarse evidence tier with independent origin, coverage,
validation, state-authority, and action qualifications. Mixed commands carry
row or result-family provenance. A generated registry keeps runtime,
certification, documentation, and public API classifications synchronized.

### 4. Persistent goal and work state

Add versioned goal, intended-change, attempt, decision, and completion-
obligation records. The canonical concise Gherkin `Feature` goal is independent
of plans. Attempts record actions and observed effects so context loss cannot
turn a repeated failure into a new plan.

### 5. Protected autonomous completion

Add a goal-relative completion gate. The governing goal, invariants, policy,
and transition rules are immutable for one evaluation. Editable tests,
baselines, suppressions, and configuration can contribute evidence but cannot
alone certify their own change. Pre-authorized transition rules permit
autonomous successor versions without a runtime approval prompt.

### 6. Residue and architecture obligations

Promote qualified evidence into obligations only through declared policy.
Repository-declared architecture rules participate in completion; descriptive
signals remain advisory. Obligations close only through current fulfillment
evidence, factual invalidation, or atomic carry-forward.

### 7. Agent workflow integration

Update planning, editing, and verification skills to consume the same goal and
work-state records. Evidence collection, receipt attachment, progress
recording, and ordinary dispositions occur automatically or on changed-state
triggers. The agent is never required to restate metadata the tool can derive.

### 8. Outcome trials and product alignment

Run matched long-form repository tasks with and without the complete workflow.
Measure full completion, missed affected artifacts, residue, reintroduced
behavior, architecture violations, false blocking, elapsed time, model tokens,
tool calls, and rework. Use independently constructed ground truth and
predeclared thresholds. Then align health and public identity with the
established results.

## Risks and unknowns

- Receipt version 1 does not prove the stronger state relationships required
  for final completion. The envelope must not imply otherwise.
- Git status and diff hashing may create measurable overhead. Cache only under
  an observation interval whose state identity is still valid; do not cache
  across unknown changes.
- The working agent can edit this repository's own tests and scip-query
  implementation. Self-hosting trials therefore need an evaluator fixed
  outside the candidate diff.
- Some legitimate changes modify goals, policies, tests, or baselines.
  Protected transition rules must validate the change rather than forbidding
  it categorically.
- Cross-clone lineage identity and exact canonical content encoding remain
  slice-2 decisions; remote URLs are not proof of identity.

## Program conduct

Each slice refreshes its current-flow evidence, implements one coherent
contract, and runs its focused checks plus the repository gate. Deviations and
deferred work are written into this plan. A step that cannot move a declared
condition is removed rather than retained for process compliance.
