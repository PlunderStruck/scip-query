# Autonomous completion protected-trial remediation

Date: 2026-07-31
Status: paused for benchmark-protocol redesign — retained as apparatus and product-remediation evidence, not authorized for another counted efficacy run
Governing goal: `SQG-4061E7D5D360464ED8E8B05D53BBF49D`
Governing change: `SQC-DED67E74D3898BDCA85766BE8D3C93AF`

## 2026-08-01 benchmark boundary

This plan repaired genuine product and apparatus defects, but its current Vega
runner does not isolate the product claims now being tested. It combines SCIP
planning, persistent work state, lifecycle hooks, protected outcome feedback,
completion control, and verification into one treatment; has no immutable plan
phase or pre-gate implementation snapshot; and lets the treatment consume the
protected evaluator used for outcome scoring. Its conditions also run
sequentially for as long as forty-five minutes.

Do not resume or register another counted efficacy program from this runner.
Preserve its frozen-fixture, isolation, readiness, transcript, immutable-record,
and silent-scoring mechanisms as reusable apparatus. Replace the experimental
flow according to
[the mission-trial benchmark charter](./2026-08-01-mission-trial-benchmark-charter.md),
which separates repository-understanding evidence, plan usefulness,
pre-verification implementation completeness, and verification lift under
parallel isolated conditions with a maximum fifteen-minute candidate budget.

Protected outcome scoring may remain outside the candidate worktree, but it
must be silent and symmetric. In-run feedback may contain only evidence the
released product can derive; a protected measurement evaluator may not act as
a solution-aware repair channel.

## Goal

An autonomous coding run begins from an independently fixed execution
authorization, carries its exact repository consequences to protected
completion, and receives only the evidence capable of changing its next action.

Done means a fresh protected matched-pair program observes genuine durable
completion transitions, satisfies the full-worktree completion-quality rule,
and keeps median workflow/control model-token use at or below `1.2`. Programs
`SQTP-2FB7335FEA79CDF6BA5FD67542C1B297`,
`SQTP-01A727B209830757B5612B57AE9F0453`, and
`SQTP-84CD5CE42556A96AD9E06AAD5C135E83` remain immutable evidence and are not
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
- **P8 — Trial evidence boundary.** The hook-verified registered report was
  `neutral`, with 100% hidden-evaluator completion in both conditions, median
  elapsed ratio `0.84`, and median token ratio `0.86`. Audit found all four
  durable workflow evaluations blocked with no completion transition and all
  eight worktrees carrying generated `tsconfig.json` residue. The report
  runner trusted candidate prose for controller state and the evaluator did
  not inspect the complete worktree. Source:
  `docs/validation/2026-07-31-autonomous-completion-protected-trial.md`.

State-authority map:

| State                                    | Complete writers                                                         | Complete readers                                                                                   | Authority rule                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Repository goal files                    | goal command; fixed successor materializer; planned protected activation | command status, completion context/history, ledger, obligations, restoration, transition selection | Candidate publication is data; exact protected activation or fixed predecessor supplies authority       |
| Protected work authorization             | planned principal/orchestrator issue command only                        | planned activation and completion-context lease                                                    | Configured external root must be outside and non-writable by the candidate                              |
| Completion authority assessment          | controller pure constructor only                                         | firewall, evaluation persistence, next-action policy                                               | Derived from fixed predecessor, evaluator build, fixed transition rule, and planned authorization lease |
| Agent-facing restoration/Stop projection | lifecycle hooks only; reconstructable cache claims                       | supported coding agent                                                                             | Projection is advisory input; repository records and controller decisions remain canonical              |

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

**Result (2026-07-31): apparatus hardened; governing goal not satisfied.** The
first fresh program `SQTP-01A727B209830757B5612B57AE9F0453` registered
`regressed`, but its runner passed Codex `--ignore-user-config` and thereby
disabled the checkout hooks that constituted the treatment. A real-runtime
lifecycle experiment reproduced the failure and ruled out the Homebrew Node
update. This program is immutable but invalid for the intended comparison.

The replacement program `SQTP-84CD5CE42556A96AD9E06AAD5C135E83` required a
real `SessionStart`/`UserPromptSubmit`/`Stop` preflight, captured hook events
and untracked files, and verified exact prompt activation in all four workflow
candidates. Its registered report was `neutral`: both conditions had 100%
resource-envelope completion, median elapsed ratio was `0.84`, and median
token ratio was `0.86`.

Transcript and durable-record audit then invalidated the controller-specific
interpretation. All four durable controller decisions said `continue` and no
completion transition existed; the runner had inferred controller success
from candidate final JSON. Setup also bound the authorization to post-setup
configuration bytes while the controller compared the Git predecessor. The
hidden evaluator never supplied goal/invariant evidence to the controller and
ignored a generated untracked `tsconfig.json` left in every candidate. All
eight `cleanup-plan --verify` calls also failed against read-only `.git`
metadata. The retained transcripts explain several favorable and unfavorable
mechanisms, but pair 02's token regression needs per-turn telemetry before its
cause can be distinguished from context replay or model variance.

No new controller trial or large-repository causal baseline may start until
slices 5-7 remove these known measurement and product defects.

### 5. Experimental-integrity boundary

- **Anchors:** external protected runner, mission-trial observation schema,
  candidate patch capture, and the fixed fixture setup path.
- **Premise:** P8.
- **Deployable:** no; this is apparatus, schema, and fixed-fixture work.
- **Change:** create one already-configured immutable fixture shared by both
  conditions; bind protected transitions to its Git predecessor; derive
  controller status only from durable evaluations and transitions; evaluate
  tracked, untracked, and deleted paths; and record per-turn token/context
  telemetry when the provider exposes it.
- **Validation:** a lying candidate final response cannot change the recorded
  controller state; a missing transition fails the coordinate; a new untracked
  file fails residue checks; preflight proves all lifecycle events; and a
  setup-time configuration mutation is impossible after program registration.
- **Order safety:** old program and run records remain immutable.

**Result (2026-07-31): complete.** The runner now starts both conditions from
the same preconfigured immutable fixture, captures tracked, deleted, and
untracked candidate changes, derives controller state only from durable
completion history, and records provider token telemetry rather than treating
missing values as zero. Principal-owned authorization and protected-evidence
commands run from the protected apparatus root with candidate automatic
operation capture disabled, so evaluator publication cannot alter the state it
judges. A fresh workflow run observed all three lifecycle events and produced a
protected receipt and completion transition over the same whole-content
digest. Earlier contaminated programs and receipts remain immutable and are
not selected by the new program.

### 6. Protected goal evidence

- **Anchors:** completion predicate evaluation, protected evaluator output,
  completion context, and transition materialization.
- **Premise:** the deterministic gate cannot prove arbitrary protected Gherkin
  merely by inspecting its own detector results.
- **Deployable:** yes, behind explicit protected-evaluator configuration.
- **Change:** add a content-identified evidence receipt issued by an
  independent evaluator for the fixed goal and exact observed candidate state;
  consume it as authority for goal, invariant, and affected-surface predicates
  without accepting candidate assertions as evidence.
- **Validation:** wrong goal, wrong worktree receipt, moved receipt, forged
  candidate receipt, evaluator error, and unknown scenario all fail closed;
  exact independently issued evidence permits a durable completion transition.
- **Order safety:** absence preserves the current blocked behavior.

**Result (2026-07-31): complete.** A protected work authorization can now fix
one evaluator by logical identity, contract version, and exact artifact
SHA-256 before candidate work. The principal-facing `protected-evidence
evaluate` command verifies those bytes, materializes the candidate's exact
tracked, deleted, and untracked state in an isolated shared checkout, and runs
the evaluator only against that snapshot. It rejects evaluator, authorization,
candidate, or snapshot movement and publishes no receipt on evaluator failure.

The resulting content-identified `SQGE` receipt binds the external
authorization byte digest, exact goal/change record digests, evaluator, and
whole-content/collaboration identities to goal, invariant, and affected-surface
judgments. Completion contexts fix the evidence ID and source digest. Stop
accepts its judgments only when the configured read-only receipt, fixed work
authorization, active goal/change, and newly observed repository content all
match exactly, then re-reads the receipt before publication. Unknown and
disproven outcomes remain blocked; established outcomes can produce a genuine
durable completion transition without trusting candidate prose.

Six end-to-end tests cover a real transition, untracked/deleted snapshot
materialization, stale-state rejection, wrong evaluator bytes, moved receipt
bytes, explicit unknown evidence, and evaluator failure. The complete
repository suite, typecheck, lint, build, API compatibility, public consumer,
and skill links pass. The command reference, agent contract catalog, autonomous
work-state documentation, and JSON schemas describe the new boundary.

### 7. Remove verification residue and ceremony

- **Anchors:** TypeScript reindex invocation, cleanup verification, attempt
  journal and restoration projection.
- **Premise:** P8 and the retained transcript audit.
- **Deployable:** yes.
- **Change:** infer JavaScript index configuration without leaving a worktree
  `tsconfig.json`; make cleanup verification function in the supported
  workspace-write sandbox or report a single actionable unavailable result;
  and compact superseded attempt records without losing live failure,
  obligation, or controller evidence.
- **Validation:** reindex leaves a clean fixture clean; concurrent user-created
  configuration is never deleted or overwritten; cleanup verification does not
  cause eight identical fallback loops; and record compaction is decision-
  equivalent under restoration and completion.
- **Order safety:** use owned temporary paths and content identities rather
  than deleting an ambiguous worktree file.

**Result (2026-07-31): complete.** TypeScript and
JavaScript indexer invocations no longer pass `--infer-tsconfig`. For an
unconfigured single project, the runner publishes the same minimal root
configuration with exclusive creation and records its bytes plus its filesystem
identity—the device/inode pair the operating system uses to distinguish that
exact underlying file. It removes the path only when all three still match;
pre-existing, replaced, or edited files are retained. Pnpm workspace runs no
longer authorize the upstream indexer to create missing workspace configs.

Focused tests cover exact cleanup after success and failure, a pre-existing
user config, an in-place concurrent edit, command construction, cancellation,
and trusted project-tool execution. Twenty tests, typecheck, build, and public
API compatibility passed; the complete repository suite also passed after its
reindex mock and bounded-artifact ownership contracts were reconciled. A real
reindex of the JavaScript policy-routing fixture produced six documents and 45
symbols while leaving `git status` clean and no root `tsconfig.json`.

Cleanup verification now materializes committed `HEAD` in an isolated shared
clone. The clone reads the source object store, but its checkout, index, locks,
and administrative records all live under the system temporary directory; it
does not register a linked worktree under the candidate repository's `.git`.
The same substrate produces cleanup patches. A focused integration test makes
the source `.git` directory read-only, verifies a deletion batch, confirms no
`worktrees` record was created, and confirms the candidate file was unchanged.
If the snapshot cannot be created, JSON and human output carry one explicit
unavailable reason instead of throwing before an outcome exists. Nineteen
focused cleanup tests, typecheck, build, and public API compatibility pass.

Automatic operation publication now groups successful read-only commands by
operation role and equivalent pre/post observation state. A state is equivalent
when the receipt facts, sources, and stability proofs match; the observation
timestamp alone does not manufacture a new state. One observation-phase
attempt retains the command kinds, latest equivalent receipt, and journal
links for the group. Interrupted, failed, and mutating operations remain
individual records, and a grouped successful observation can still reconcile
one requested unknown effect. The local journal and protected trial transcript
retain each exact invocation. Focused journal, next-action, and restoration
tests establish one record for three successful same-state reads while
preserving failures, unknown effects, and reconciliation behavior.

### 8. Fresh controller and large-repository programs

- **Anchors:** slices 5-7, protected program registration, this validation
  record, README capability status, and the selected Vega fixture.
- **Deployable:** no; these are immutable evidence events.
- **Change:** first run a fresh ordinary-control/controller matched program on
  the small fixture. If apparatus and durable completion are valid, run the
  separately registered large-repository no-scip/ordinary-scip comparison with
  the exact same user prompt and independent whole-system evaluator.
- **Validation:** complete worktree and durable transitions for the controller
  program; pre-registered architecture, thoroughness, residue, behavior, cost,
  and false-blocking judgments for both programs; transcript audit before any
  generalized claim.
- **Order safety:** each changed fixture, evaluator, threshold, runtime, or
  treatment produces a new content-identified program.

**Progress (2026-07-31): controller lifecycle established; causal program
open.** Program `SQTP-182228C19EB1E390F39BBA7CB829E7CD` recorded one fresh
matched pair. Both candidates satisfied the full-worktree evaluator. The
workflow candidate's protected receipt `SQGE-D3CF57FB2ADA3A9235E05105F885FEE7`
and completion evaluation `SQE-1F526D96939107A59E7FB489812EB30E` named the
same repository-content digest, and transition
`SQCT-1CC5D8E009F531A7C18CB9B47EAF7B39` durably completed the authorized
change. Workflow/control ratios were `0.947` elapsed, `0.703` model tokens,
`0.474` tool calls, and `0.680` cached-input tokens, with no false block or
architecture regression. The program correctly classifies `insufficient`
because it has one pair and a tied completion outcome. The large-repository
no-scip/ordinary-scip comparison remains the evidence needed to test a
thoroughness advantage rather than merely lifecycle validity.

**Repository closeout verification (2026-07-31).** The first complete-suite
rerun caught one descriptor-contract regression that the focused protected-
evidence tests had missed: `protected-evidence <operation> [target]` did not
declare whether its targetless `status` operation was diff- or repository-
scoped. Declaring its existing whole-repository behavior as `repository` made
the narrow CLI contract pass; removing that exact fix reproduced the failure,
and reapplying it restored the pass. The corrected tree passed all 2,423 tests
in 310 files, TypeScript and fixture contracts, formatting, ESLint, build,
declaration generation, the unchanged 72-path public API, the public consumer,
and skill-link validation. Complete architecture output found no declared
boundary violation. Self-audit observed 1.0 reference precision and recall on
its 50-symbol sample; callee precision remained unclaimed because that oracle
was partial. The final diff gate passed with zero findings after replacing the
content-invalidated descriptor/handler co-change suppression with current
source and CLI-contract counterevidence.

`scip-query health --baseline` still fails against the deliberately empty
2026-07-23 repository baseline, now with 139 accumulated heuristic candidates
(the earlier program records reported 96 and then 113). This is a reproduced
program-wide baseline exception, not a green result and not attributed to the
descriptor-only closeout fix. It remains separate from the change-relative
architecture, residue, migration, dead-code, documentation, and coordination
checks that passed in `diff-gate`.

### 9. Actionable protected feedback and bounded diagnostic

- **Anchors:** protected evaluator result, Stop completion evaluation,
  autonomous policy publication, next-action selection, and the v11 Vega
  transcript.
- **Premise:** enforcement helps autonomous work only when a failed protected
  judgment preserves enough principal-approved information to select a repair,
  or explicitly directs the agent back through the fixed goal when no safe
  detail exists.
- **Deployable:** yes; protected findings remain bounded contract fields and
  raw evaluator output remains inaccessible.
- **Change:** map missed artifacts, residue defects, reintroduced behaviors,
  and architecture violations to predicate-tagged autonomous findings only
  when evidence goal/change identity matches the evaluated work. Render all
  bounded findings as closure targets. With no detailed finding, require a
  clause-by-clause audit of the fixed goal and affected surface and reject
  adjacent hardening.
- **Validation:** focused domain and publication tests; an unrelated evidence
  result must not influence another change; one newly registered workflow-only
  diagnostic must improve the fixed 101/106 protected score before another
  matched comparison is allowed.
- **Follow-up:** include repeated unchanged protected outcome digests in the
  strategy/replan budget so successful shell commands cannot conceal an
  unchanged completion failure.

**Evidence (2026-07-31): implementation complete; efficacy diagnostic invalidated by apparatus.**
Valid v11 program `SQTP-5D931AE91C6D903732E823213AAA505F` blocked four false
finishes but timed out at 2,700,024 ms with the same five protected failures as
control. The autonomous policy path discarded the evaluator's four safe
finding arrays, while the evaluator populated those arrays with only one
generic regression string. This reopens decision-equivalent compression and
makes a quality-improving treatment-only diagnostic the next evidence event.

Product commit `b4b91ebdd1c48c54019a1917bca5640d224e9feb` now carries all
four protected finding arrays through exact goal/change matching into the
autonomous next action, renders every bounded closure target, and falls back to
a clause-by-clause goal audit without adjacent hardening. Focused tests, the
complete 2,428-test suite, typecheck, lint/build/API contracts, relationship
postchecks, and `diff-gate` passed.

V12 diagnostic `SQTP-169FE0C9CC801463D195EA36536E6AAE` proved that transport:
the first protected rejection named four safe findings, and the agent traced
all four to three concrete corrections. It also reduced the old five hidden
test failures to two before feedback. The run still timed out at 1,800,070 ms.
The prepared dependency tree made an unchanged isolated API suite fail three
of 38 tests; the same source passed all 38 after an ordinary pnpm install. The
preflight did not exercise the applicable repository gate under that exact
dependency mode, so elapsed efficacy is invalid rather than negative. The
serialized ordinary-gate/evaluator/ordinary-gate Stop path independently
consumed roughly six minutes. The follow-up is therefore no longer merely
repeated-outcome accounting: preflight must prove the repository gate under
candidate-exact dependencies, and closeout must avoid redundant analysis and
reserve time for a protected repair cycle before another diagnostic.

### 10. Candidate-exact readiness and single-gate protected closeout

- **Current flow:** `hook-stop` materializes the local operation journal, runs
  the isolated diff gate, publishes a completion evaluation, and selects the
  next action. A protected adapter must materialize that journal before its
  evaluator observes the complete worktree, so v12 invoked the entire Stop
  path once without evidence and again with the resulting receipt.
- **Affected consumers:** compiler-resolved references show
  `runIsolatedStopHookDiffGate` has one caller, `handleAgentHookStop`, and
  `materializeAutomaticOperationAttempts` has one production consumer in that
  Stop path. The hidden command registry, cache preparation, watch auto-start,
  and update-notice boundaries also consume lifecycle command identity.
- **Reuse decision:** extract no second journal or gate. A hidden
  `hook-stop-prepare` command reuses the exact existing operation materializer;
  final `hook-stop` continues to own all diff, completion, and next-action
  judgments.
- **Product change:** let a principal adapter freeze pending operation history,
  evaluate that stable worktree, and invoke the expensive final gate once with
  the protected receipt. Candidate-facing hooks and actions remain unchanged.
- **Apparatus change:** supply the fixture's non-secret test environment before
  work and run the actual repository pre-commit gate against the exact prepared
  dependencies before measured execution. Reject a gate failure or worktree
  mutation as setup failure.
- **Validation:** focused lifecycle/journal/registry tests, typecheck, build,
  command-contract checks, a generated-principal syntax probe, a
  candidate-exact repository-gate preflight, and the normal final diff gate.

**Evidence (2026-07-31): product slice verified; candidate preflight pending.**
The product now has one hidden preparation boundary that returns the
materialized attempt summary without refreshing the index, running detectors,
publishing completion, or selecting an action. The external runner uses that
boundary instead of its first full `hook-stop`, fixes the test environment
before candidate launch, and treats the full repository gate as preflight
rather than measured setup. The complete 2,431-test suite, lint, typecheck,
build, focused lifecycle/registry/JSON-contract tests, API compatibility
contract, generated-principal syntax probe, and source-diff checks pass. The
new internal declaration is recorded as a compatible correction because the
public runtime names and signatures are unchanged. Candidate-exact repository
gate readiness remains the required apparatus proof before another measured
diagnostic starts.

## Attack record

| ID  | Invariant/lens          | Attack                                                                                           | Outcome                                                                                                                                                                                                 |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 1 / authority           | Candidate points a manual command at a fake root containing a forged envelope                    | HOLE in draft; repaired by slice 2: Stop consumes only the host-configured root/ID fixed in its context, not command-local overrides                                                                    |
| A2  | 1 / boundary            | Configured root is inside the worktree or a symlinked record escapes it                          | HELD by slice 1 regular-file/non-symlink checks and external-root assertion (P7)                                                                                                                        |
| A3  | 2 / self-easing         | Candidate changes the activated Gherkin or authorization source                                  | HELD by slice 2 full canonical goal digest equality before granting a referent                                                                                                                          |
| A4  | 3 / policy weakening    | Candidate changes `.scipquery.json` to different bytes than the pre-authorized transition        | HELD by slice 2 predecessor and successor digest equality using P6                                                                                                                                      |
| A5  | 4 / concurrency         | Principal replaces an authorization while the gate runs                                          | HOLE in draft; repaired by slice 2 pre/post byte-digest lease assertion                                                                                                                                 |
| A6  | 5 / availability        | Authorization file is missing, future-versioned, malformed, or from another collaboration domain | HELD by slices 1-2: activation reports the boundary and the existing firewall remains in force                                                                                                          |
| A7  | 2 / replay              | Candidate replays `UserPromptSubmit` with the known prompt                                       | HELD by slice 2: replay can only idempotently materialize the same protected goal/change                                                                                                                |
| A8  | 2 / prompt substitution | Candidate tries a different prompt against the configured authorization                          | HELD by slice 2 prompt SHA-256 equality before first activation                                                                                                                                         |
| A9  | 6 / efficiency          | Compression hides a blocker or drill-down needed for a different next action                     | HELD by v12: all four bounded protected findings reached the agent and changed its diagnosis without exposing private evaluator output                                                                  |
| A10 | purpose / measurement   | New code passes unit tests but does not improve autonomous outcomes                              | INVALID for v12 efficacy: feedback and three repaired hidden failures are real observations, but frozen-dependency gate failure confounded elapsed completion                                           |
| A11 | measurement authority   | Runner trusts the candidate's final `completed` claim despite a durable `continue` decision      | HELD: slice 5 derives status from durable completion history, and the fresh workflow coordinate recorded a real completion transition                                                                   |
| A12 | worktree completeness   | Evaluator and patch omit generated untracked residue                                             | HELD: protected evaluation and runner capture include tracked, deleted, and untracked state; the fresh evaluator and controller matched exact whole-content identity                                    |
| A13 | goal evidence           | Hidden evaluator passes behavior but controller never receives independent goal evidence         | HELD: slice 6 binds a pre-authorized evaluator receipt to exact goal/change records and whole content                                                                                                   |
| A14 | useful work             | Verification repeatedly fails for an apparatus reason and agents compensate ceremonially         | REOPENED by v12: candidate-exact dependency readiness omitted the repository gate, causing three compensating pre-commit attempts; serialized Stop then left less than two minutes for protected repair |

Coverage matrix:

| Surface or lens                    | Attack                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| Protected authorization writer     | A1, A2, A5                                                                                   |
| Goal/change activation writer      | A3, A7, A8                                                                                   |
| Completion authority reader        | A1, A3-A6                                                                                    |
| Hook/restoration projection writer | A8, A9                                                                                       |
| Valid intermediate state           | A5-A7                                                                                        |
| Reversibility and compatibility    | A6; optional fields preserve old records and absent configuration preserves current behavior |
| Efficiency and purpose             | A9, A10, A14                                                                                 |
| Experimental integrity             | A11, A12                                                                                     |
| Independent completion evidence    | A13                                                                                          |

The original three design holes were repaired in slices 1-3. The transcript
and durable-record audit exposed five empirical holes assigned to slices 5-8.
Valid v11 evidence reopened A9 and produced a negative A10 result for the
tested design. V12 holds A9 narrowly by showing that protected findings reach
and redirect the agent, but A10 is invalid for efficacy and A14 is reopened
because the apparatus manufactured gate work and left no practical repair
window. No matched comparison is accepted.
The external
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
- Provider aggregate token totals can identify a regression but cannot by
  themselves attribute it to a turn, hook payload, retrieved result, or hidden
  model variance. Per-turn telemetry is required where the runtime exposes it;
  otherwise the causal claim remains bounded to observable tool behavior.

## Execution and ship order

One commit per numbered slice. After each source change: wait for the watcher,
run the slice's focused tests, typecheck, build, matching `scip-verify`
postchecks, and `scip-query diff-gate`; record every deviation. Slices 5-7 must
land and pass adversarial fixtures before either slice-8 program is registered.
Counted programs are one-way evidence events because their records are
immutable, so every fixture, evaluator, runner, treatment, and threshold must
be content-bound before candidates start.

## Verdict

A plan is PLANNED-COMPLETE iff every state writer/reader row is covered, every
attack is held by a cited slice and premise, and no premise fails
reverification.

Result: **PLAN REOPENED FROM EVIDENCE** — 14 attacks; authority, worktree, and
lifecycle properties remain held, A9 is held by direct v12 transcript evidence,
A10 is invalid for efficacy, A14 is reopened, and 0 holes are accepted. Program
completion now requires candidate-exact gate readiness and an operational
closeout slice before another bounded large-repository diagnostic.

## Files expected to change

- Create domain, storage, runtime, command-handler, and test files for protected
  work authorization.
- Edit goal/completion context, hook, command registry, docs/schema, and skill
  contracts only where the new exact authority or compact projection is
  consumed.
- Edit the external protected runner and register a new program only in slice 4.
- Edit the protected runner, fixed fixture, observation schema, and full-
  worktree evaluator in slice 5.
- Edit completion evidence domain/storage/runtime surfaces in slice 6.
- Edit indexing, cleanup verification, and attempt-journal behavior in slice 7.
- Register new controller and large-repository programs only in slice 8.
- Delete no existing evidence or trial records.
