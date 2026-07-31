# Autonomous completion protected-trial remediation

Date: 2026-07-31
Status: in progress — slices 1-3 complete; protected trial pending
Governing goal: `SQG-4061E7D5D360464ED8E8B05D53BBF49D`
Governing change: `SQC-DED67E74D3898BDCA85766BE8D3C93AF`

## Goal

An autonomous coding run begins from an independently fixed execution
authorization, carries its exact repository consequences to protected
completion, and receives only the evidence capable of changing its next action.

Done means a fresh protected matched-pair program satisfies the registered
completion-quality rule while keeping median workflow/control model-token use
at or below `1.2`. The old program
`SQTP-2FB7335FEA79CDF6BA5FD67542C1B297` remains immutable evidence and is not
reused.

```gherkin
Feature: Protected autonomous execution from authorized intent

  Rule: The candidate cannot create or weaken the standard that judges it

  Scenario: An authorized request starts autonomous work
    Given a principal-controlled preflight fixed one goal, intended change, and any protected artifact transitions
    When the coding agent receives the matching user request
    Then the exact work envelope is materialized without a human metadata step

  Scenario: Candidate-controlled authority is rejected
    Given the candidate changes the goal, authorization, or an ungranted protected artifact transition
    When completion is evaluated
    Then that candidate change cannot authorize its own completion predicates

  Scenario: Verification remains decision-equivalent
    Given two verification projections contain the same blockers and next action
    When the agent-facing projection is rendered
    Then redundant evidence is omitted without changing the completion decision
```

## Definitions and invariants

A protected work authorization is an immutable execution envelope stored
outside the candidate-editable worktree. Its concrete referents are one prompt
digest, one exact goal record, one exact intended-change record, and zero or
more exact predecessor/successor byte transitions for protected artifacts. It
is a kind of delegated repository authority distinguished by fixing the
standard before candidate actions while allowing the candidate to consume but
not create, replace, or broaden it.

Activation is the idempotent publication of the envelope's already-fixed goal
and intended change into the repository's mergeable `.scipquery/` record set.
It is a kind of repository mutation distinguished by copying exact protected
meaning rather than asking the coding agent to restate protocol metadata.

Decision-equivalent verification is an agent-facing projection that preserves
every fact whose change could alter the controller decision or the selected
next action. It is a kind of evidence compression distinguished by removing
only facts that are redundant for the current decision, never by truncating an
incomplete relationship set.

The following invariants must always hold:

1. A protected authorization grants authority iff its current regular-file
   bytes decode canonically, its content identity matches, its collaboration
   domain matches, and its configured root is outside the candidate worktree.
2. A goal or change is authorized iff its full canonical record equals the
   corresponding record fixed in the configured authorization.
3. A protected artifact transition is authorized iff both its fixed
   predecessor digest and current successor digest equal the configured exact
   transition.
4. The authorization record observed before evaluation must be byte-identical
   after evaluation; movement discards the judgment.
5. Absence, ambiguity, incompatibility, or movement of authorization fails
   closed and never weakens the existing reflexive-authority firewall.
6. Compression may change presentation size, but never the controller state,
   blocked predicates, unresolved effects, live obligations, or selected next
   action.

## Premises

- **P1 — Current prompt entry.** `UserPromptSubmit` invokes `hook-context`; the
  hook parses the raw prompt and currently performs only routing plus durable
  work restoration. Source: `src/runtime/agent-hooks.ts:667-692` and
  `src/runtime/agent-hooks.ts:1319-1355`; `scip-query plan-context
  renderUserPromptContext --full` completed transport and found its sole direct
  consumer in `renderAgentHookContext`.
- **P2 — Goal writers.** The complete compiler-resolved production writer set
  for `createGoalRecordFile` is `runGoalOperation` and
  `materializeCompletionTransitionSuccessor`. Source: `scip-query refs
  createGoalRecordFile --full` and `scip-query dataflow createGoalRecordFile
  --full`.
- **P3 — Goal readers.** The complete compiler-resolved reader set for the goal
  collection reaches command status, completion context/evaluation, work
  ledger, obligations, restoration, and transition-rule selection. Source:
  `scip-query refs readGoalRecords --full`.
- **P4 — Completion authority choke point.**
  `createCompletionAuthorityAssessment` has one production caller,
  `stopCompletionEvaluationRequest`, and the result is passed through
  `applyCompletionAuthorityFirewall`. Source: `scip-query dataflow
  createCompletionAuthorityAssessment --full` and
  `src/runtime/completion-evaluation-context.ts:402-414`.
- **P5 — Current authority limitation.** Goal and configuration paths changed
  from the Git predecessor are candidate-controlled unless a selected fixed
  transition rule supplies an authorized referent. Source:
  `src/runtime/completion-evaluation-context.ts:58-94`,
  `src/runtime/completion-evaluation-context.ts:439-492`, and
  `src/domain/autonomous-completion.ts:273-344`.
- **P6 — Existing exact-transition machinery.** Completion transition rules
  already compare protected predecessor and successor file SHA-256 digests and
  expose an authorized referent only after exact matching. Source:
  `src/storage/completion-transition-rule.ts:147-195` and
  `src/storage/completion-transition-rule.ts:262-308`.
- **P7 — Existing protected storage.** Mission trials already use durable,
  exclusive, regular-file-only storage outside the candidate worktree and
  reject conflicting immutable identities. Source:
  `src/storage/mission-trials.ts:70-105`,
  `src/storage/mission-trials.ts:179-185`, and
  `src/storage/mission-trials.ts:218-264`.
- **P8 — Trial failure and efficiency baseline.** The counted workflow had the
  same 25% full-completion rate as control, a `1.255` median token ratio, and
  three unknown blocker-validity judgments; pairs 02-04 had technically clean
  code but candidate-controlled goal/configuration blockers. Source:
  `docs/validation/2026-07-31-autonomous-completion-protected-trial.md:47-108`.

State-authority map:

| State | Complete writers | Complete readers | Authority rule |
| --- | --- | --- | --- |
| Repository goal files | goal command; fixed successor materializer; planned protected activation | command status, completion context/history, ledger, obligations, restoration, transition selection | Candidate publication is data; exact protected activation or fixed predecessor supplies authority |
| Protected work authorization | planned principal/orchestrator issue command only | planned activation and completion-context lease | Configured external root must be outside and non-writable by the candidate |
| Completion authority assessment | controller pure constructor only | firewall, evaluation persistence, next-action policy | Derived from fixed predecessor, evaluator build, fixed transition rule, and planned authorization lease |
| Agent-facing restoration/Stop projection | lifecycle hooks only; reconstructable cache claims | supported coding agent | Projection is advisory input; repository records and controller decisions remain canonical |

The compiler establishes the current goal and completion rows through P2-P4.
The planned authorization and projection rows do not exist yet; their writer
and reader sets are requirements to re-run with `refs --full` after each slice.

## Current flow

The provider sends a raw prompt to `hook-context` (P1). If no canonical goal
exists, current skill guidance tells the coding model to derive and publish one
through the ordinary goal command (P2). Stop captures that goal and change with
the repository observation (P3), partitions changed protected paths (P4-P5),
and turns goal or configuration reliance into unknown predicates when the same
candidate changed those paths. The protected trial therefore produced correct
repository effects while the workflow could not establish independent
authority and spent too many tokens retrying or explaining that boundary (P8).

## Reuse audit

- Extend `GoalRecordV1`, `IntendedChangeRecordV1`, and their existing atomic
  publishers; do not create parallel repository goal/change formats.
- Reuse the mission-trial regular-file, create-only, external-root storage
  pattern (P7), but give work authorization its own domain schema because its
  identity and consumers differ from outcome trials.
- Reuse the exact artifact-transition type and digest comparator (P6); export
  the comparator instead of duplicating Git/current byte logic.
- Extend the fixed completion-context snapshot with an optional authorization
  identity/digest; do not add an ambient mutable authority lookup inside the
  pure firewall.
- Extend `UserPromptSubmit` at its existing choke point (P1); do not install a
  second hook or require the agent to run a metadata-only activation command.
- Compress the existing restoration and Stop renderers; controller records and
  detailed status commands remain the drill-down source.

## Testability design

Pure seams are authorization request decoding/identity, exact record matching,
referent derivation, and projection selection. Filesystem publication and reads
remain thin storage shells using injected atomic runtimes where durability is
tested. Hook tests call `renderAgentHookContext` with an injected environment;
completion tests pass an explicit authorization lease rather than mutating
process globals. Git predecessor/current artifact matching remains the existing
side-effect seam.

## Slices

### 1. Protected authorization record and external storage

- **Anchors:** `src/domain/autonomous-work-state.ts:34-100`,
  `src/storage/autonomous-work-state.ts:71-137`,
  `src/storage/mission-trials.ts:179-264`.
- **Premises:** P2, P3, P6, P7.
- **Deployable:** yes; the new surface is inert until explicitly configured.
- **Change:** add a content-identified protected authorization containing an
  exact goal/change pair, prompt digest, and exact protected transitions; add
  create/read/list and idempotent activation storage plus a principal-facing
  CLI command.
- **Validation:** domain mutation tests, atomic collision/partial/symlink/root
  tests, activation retry/conflict tests, command-contract tests, typecheck and
  build.
- **Order safety:** no controller trusts the record in this slice.

**Result (2026-07-31): complete.** The slice added the canonical request and
record schemas, domain decoder/identity, durable external create/read/list
storage, exact idempotent goal/change activation, and the principal-facing
`work-authorization` command. Root validation now rejects lexical nesting,
root symlinks, resolved nesting, authorization-directory symlinks, record
symlinks, immutable collisions, and collaboration-domain mismatch before any
repository record is written. The command reuses the established work-state
request/domain helpers and central handler registry after the first diff gate
identified avoidable echoes and a forbidden command-to-filesystem edge.

Validation: 63 focused tests passed before the final cleanup; 47 focused tests
and typecheck passed after it; the complete suite passed (307 files, 2,398
tests); lint, build, public-API compatibility, skill-link validation,
`recent-duplicates --full`, `similar --full`, `stale-abstractions --full`,
`unused-params --full`, `co-change --full`, fully paginated `doc-drift --full`,
and `self-audit` completed. The final `scip-query diff-gate` passed. Three
remaining heuristic echo matches were recorded as content-invalidating,
evidence-backed suppressions: separate persisted-record decoders and prefix
guards intentionally retain record-owned semantics, while the two command
renderers shared only generic console/error vocabulary.

### 2. Fixed authorization lease and automatic prompt activation

- **Anchors:** `src/runtime/agent-hooks.ts:1319-1365`,
  `src/runtime/completion-evaluation-context.ts:126-219`, and
  `src/runtime/completion-evaluation-context.ts:308-414`.
- **Premises:** P1-P6.
- **Deployable:** yes; absent configuration preserves current fail-closed
  behavior.
- **Change:** bind a configured authorization to the matching prompt digest,
  activate its exact records before the model acts, fix its ID/digest in the
  completion context, re-observe it after evaluation, and supply authorized
  referents only for exact goal/change/artifact matches.
- **Validation:** matching prompt activates once; replay is idempotent; wrong
  prompt, wrong domain, candidate goal edit, fake root, wrong artifact bytes,
  moved external bytes, partial activation, and missing config all fail closed.
- **Order safety:** activation and trust consumption land together, so there is
  no enforcement window in which a loose record is trusted.

**Result (2026-07-31): complete.** The supported prompt hook now consumes only
the host-configured external authorization root and identity, verifies the
first prompt before any publication, and idempotently materializes the exact
embedded goal and intended change. Completion snapshots fix both work-record
digests plus the authorization ID and source-byte digest. The firewall grants
goal authority only when the sole changed goal is the embedded goal, and
grants each other protected class only when every changed path has one exact
predecessor/current transition. A post-evaluation reread turns external byte
movement into a discarded context rather than a published judgment.

Validation covers matched activation, prompt substitution, continuation,
partial-write recovery, missing or partial environment configuration, relative
and candidate-owned roots, collaboration-domain mismatch, symlinked storage,
candidate goal widening, wrong protected successor bytes, and authorization
movement. The complete repository suite, typecheck, lint/build/API contracts,
architecture policy, fully paginated relationship postchecks, self-audit, and
the final staged `scip-query diff-gate` are the slice exit conditions.

Exit evidence: the complete suite passed (308 files, 2,409 tests); lint passed,
including formatting, ESLint, build, public-API compatibility, the public
consumer fixture, and skill-link validation. `architecture`,
`recent-duplicates --full`, fully paginated `similar --full`,
`stale-abstractions --full`, `unused-params --full`, fully paginated
`co-change --full`, fully paginated `doc-drift --full`, and `self-audit`
completed. The staged `scip-query diff-gate` passed with no findings. No new
suppression was required.

### 3. Decision-equivalent verification compression

- **Anchors:** `src/runtime/agent-hooks.ts:1172-1310` and
  `src/runtime/agent-hooks.ts:1367-1421`.
- **Premises:** P1 and P8.
- **Deployable:** yes.
- **Change:** render one compact controller/next-action block, deduplicate facts
  already represented by that action, summarize repeated attempt history, and
  emit exact drill-down commands only for unresolved predicates whose detail
  can change the next action.
- **Validation:** snapshot tests prove identical decision, blockers, unknowns,
  and commands; output-size fixtures must shrink by at least 30% for the
  pair-02-style blocked state and never exceed the registered restoration
  budget.
- **Order safety:** detailed immutable records remain unchanged.

**Result (2026-07-31): complete.** Stop now renders each controller judgment
and its selected autonomous action in one block. The block retains the
terminal state, exact blocked and unknown predicate sets, successor identity
when applicable, and exact action text. Context and decision record identities
remain in the committed records rather than being repeated in prose. Only an
unknown predicate emits `completion status`; established-false predicates
already select repair work. The pair-02-style regression fixture measures the
new block at no more than 70% of the former duplicated controller/action text.

Restoration now reports total, failed, unresolved-unknown, and within-family
supersession counts; renders a latest attempt only when it is not already the
latest unsuccessful member of its family; marks unsafe attempts in that same
line; and emits only commands for a missing goal, unresolved attempt, live
obligation, or record-safety issue. Its existing 16 KiB fail-closed fallback
and immutable source records are unchanged.

Validation: 26 focused tests passed across the restoration, hook, and policy
surfaces; typecheck passed; the complete suite passed (308 files, 2,410 tests);
lint passed, including formatting, ESLint, build, API compatibility, the public
consumer fixture, and skill-link validation. `architecture` completed with no
declared-boundary violation. `recent-duplicates --full` found none;
`similar --full`, `stale-abstractions --full`, `unused-params --full`,
`co-change --full`, and `doc-drift --full` completed with full transport.
Their remaining rows were pre-existing named domain concepts or unrelated
signals, and no new extraction or documentation repair was warranted.
`self-audit` reported reference precision 0.966 and recall 1. No new
suppression was required; the staged diff gate is the slice exit condition.

### 4. Protected apparatus and fresh program

- **Anchors:** external protected runner named in the Phase 6 validation record,
  mission-trial record/report commands, skills, README, and this execution plan.
- **Premises:** P8.
- **Deployable:** no; apparatus registration and all counted runs are one
  protected program.
- **Change:** issue one authorization before each workflow candidate, configure
  its read-only root/ID, include any exact required configuration transition,
  pre-register a new parameters digest, and run fresh alternating pairs.
- **Validation:** immutable program validation, hidden evaluator, controller
  blocker-validity observation, report classification, health/effectiveness,
  full repository gates, and `scip-query diff-gate`.
- **Order safety:** old outcomes remain immutable and excluded from the new
  decision dataset.

## Attack record

| ID | Invariant/lens | Attack | Outcome |
| --- | --- | --- | --- |
| A1 | 1 / authority | Candidate points a manual command at a fake root containing a forged envelope | HOLE in draft; repaired by slice 2: Stop consumes only the host-configured root/ID fixed in its context, not command-local overrides |
| A2 | 1 / boundary | Configured root is inside the worktree or a symlinked record escapes it | HELD by slice 1 regular-file/non-symlink checks and external-root assertion (P7) |
| A3 | 2 / self-easing | Candidate changes the activated Gherkin or authorization source | HELD by slice 2 full canonical goal digest equality before granting a referent |
| A4 | 3 / policy weakening | Candidate changes `.scipquery.json` to different bytes than the pre-authorized transition | HELD by slice 2 predecessor and successor digest equality using P6 |
| A5 | 4 / concurrency | Principal replaces an authorization while the gate runs | HOLE in draft; repaired by slice 2 pre/post byte-digest lease assertion |
| A6 | 5 / availability | Authorization file is missing, future-versioned, malformed, or from another collaboration domain | HELD by slices 1-2: activation reports the boundary and the existing firewall remains in force |
| A7 | 2 / replay | Candidate replays `UserPromptSubmit` with the known prompt | HELD by slice 2: replay can only idempotently materialize the same protected goal/change |
| A8 | 2 / prompt substitution | Candidate tries a different prompt against the configured authorization | HELD by slice 2 prompt SHA-256 equality before first activation |
| A9 | 6 / efficiency | Compression hides a blocker or drill-down needed for a different next action | HOLE in draft; repaired by slice 3 decision-equivalence snapshot matrix and exact status-command escape hatch |
| A10 | purpose / measurement | New code passes unit tests but does not improve autonomous outcomes | HELD only by slice 4 fresh protected matched trials; program exit remains open until then |

Coverage matrix:

| Surface or lens | Attack |
| --- | --- |
| Protected authorization writer | A1, A2, A5 |
| Goal/change activation writer | A3, A7, A8 |
| Completion authority reader | A1, A3-A6 |
| Hook/restoration projection writer | A8, A9 |
| Valid intermediate state | A5-A7 |
| Reversibility and compatibility | A6; optional fields preserve old records and absent configuration preserves current behavior |
| Efficiency and purpose | A9, A10 |

Three holes were found and repaired in the plan; none is accepted. The external
root's non-writability by the candidate is an environment precondition, not a
property pathname validation can manufacture. Supported adapters and trials
must enforce it with sandbox or mount permissions and report the protection
mode; environments that do not establish it receive no authorization grant.

## Risks, unknowns, and deferrals

- No local process can infer that a same-user caller is a principal merely from
  a CLI invocation. The design therefore trusts exact bytes only from a
  configured external root whose write authority is outside the candidate.
- Converting natural-language intent into exact Gherkin remains a protected
  preflight responsibility. It may use a model, but it is a separate stage from
  the coding candidate and its output is fixed before candidate actions.
- A protected artifact change not known exactly at preflight remains blocked or
  requires an already-fixed transition rule. The controller will not replace
  byte identity with a vague “goal-related” grant.
- General provider adapters beyond the current Codex/Claude hook surface are
  deferred until a real provider supplies a lifecycle boundary and protected
  storage contract.

## Execution and ship order

One commit per numbered slice. After each source change: wait for the watcher,
run the slice's focused tests, typecheck, build, matching `scip-verify`
postchecks, and `scip-query diff-gate`; record every deviation. Slices 1-3 are
additive and rollbackable. Slice 4 is a one-way evidence event because counted
records are immutable, so its program and thresholds must be registered only
after the implementation gates are green.

## Verdict

A plan is PLANNED-COMPLETE iff every state writer/reader row is covered, every
attack is held by a cited slice and premise, and no premise fails
reverification.

Result: **PLANNED-COMPLETE** — 10 attacks, 3 holes repaired, 0 accepted holes,
and 0 unresolved design items. Program completion itself remains open pending
the fresh protected trial.

## Files expected to change

- Create domain, storage, runtime, command-handler, and test files for protected
  work authorization.
- Edit goal/completion context, hook, command registry, docs/schema, and skill
  contracts only where the new exact authority or compact projection is
  consumed.
- Edit the external protected runner and register a new program only in slice
  4.
- Delete no existing evidence or trial records.
