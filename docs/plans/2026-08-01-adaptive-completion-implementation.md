# Adaptive completion implementation

Date: 2026-08-01
Status: implementation and verification complete; broader task-family trials remain
Governing goal: `SQG-4061E7D5D360464ED8E8B05D53BBF49D`
Governing change: `SQC-DED67E74D3898BDCA85766BE8D3C93AF`
Benchmark contract: [mission-trial benchmark charter](./2026-08-01-mission-trial-benchmark-charter.md)

## Goal

scip-query gives an autonomous coding agent only the repository evidence and
durable work state that can improve completion, then blocks a completion claim
when fixed evidence contradicts an authorized repository consequence.

Done means all of the following are true:

1. A direct local change does not require a durable plan or manual work-state
   ceremony.
2. A relational or sustained change can compile one concise plan contract into
   mergeable goal, change, and completion records with one command.
3. An explicit retirement obligation remains stronger than mere public
   reachability. A surviving alias, wrapper, re-export, configuration entry,
   test, or documentation statement must have an authorized current role.
4. Incomplete retirement evidence asks the agent for one supported disposition
   instead of silently passing or demanding deletion.
5. Architecture policy can require both closed dependency rules and removal of
   allowances that lost their current reason.
6. The private runner scores missing and contradictory plan obligations, proves
   the full released treatment setup before candidate time, and can run a
   corrected matched pair without exposing protected facts.
7. Product and benchmark tests pass, the public diff gate passes once, and the
   resulting trial claim is limited to the exact observed fixture, model, and
   runtime.

## Essential concepts

A **change contract** is a pre-edit repository work record whose distinguishing
feature is that it connects the authorized goal to concrete repository
consequences: what is affected, what must remain true, what must disappear,
what may survive, and what evidence can establish completion. It is not a list
of coding steps and it cannot weaken the goal.

A **retirement closure** is the repository relationship set that preserves a
superseded responsibility or identity. It includes the named seed and the
aliases, wrappers, re-exports, consumers, configuration, tests, documentation,
and architecture declarations that can keep that old design live or make it
look current.

A **supported survivor** is an artifact inside a retirement closure that has a
current role authorized by the goal, repository policy, or a prior delegated
decision. Survival, public reachability, a test-only reference, and agent prose
are not by themselves authority.

A **workflow class** is a group of repository changes selected by the kind of
evidence and persistent state needed for completion. Direct work needs only a
local proof. Relational work needs repository relationships. Sustained work
also needs independently verifiable state across slices or sessions.

A **reuse authority** is an existing repository symbol selected before editing
to remain the one owner of a responsibility shared by named affected
consumers. Its distinguishing fact is compiler-resolved delegation: every
named consumer calls that owner instead of retaining a parallel implementation.

A **monotonic architecture-policy tightening** is a protected configuration
edit that only removes allowed dependency edges while every boundary, policy
switch, row owner, and unrelated setting stays fixed. It can strengthen the
gate but cannot weaken it.

## Current flow and established limits

- `handleAgentHookStop` runs the isolated diff gate, fixes the repository
  observation, publishes completion decisions, and returns only when findings,
  coverage warnings, or incomplete completion state need action. The bounded
  `plan-context handleAgentHookStop` result found its production registration
  in `src/runtime/commands/command-descriptors.ts` and named
  `runIsolatedStopHookDiffGate` as the effect-producing path.
- `evaluateResidueCompleteness` is the single adapter from residue and cleanup
  evidence into completion obligations. The bounded compiler graph found one
  production caller, `publishStopCompletionEvaluations`, with downstream Stop
  rendering through `agent-hooks.ts`.
- `newlyUnreferencedResidue` compares removed calls and references with current
  callables. Its current-role proof treats a declared external root or entry
  surface as sufficient by itself. That rule explains why a compatibility
  alias can pass even when explicit retirement requires the old identity to
  disappear.
- Goal, change, and obligation records already provide durable, mergeable,
  content-addressed storage. Reuse their atomic publication and compatibility
  reporting rather than create another workflow ledger.
- Architecture analysis already exposes `requireMinimalPolicy` and stable
  `stale-allowance` findings. The generated fixture does not currently enable
  that rule, so obsolete permissions cannot become a gate result.

These graph observations are bounded to the current fresh generation. The
plan does not claim that `plan-context` enumerated every transitive consumer.

## Reuse decisions

- Extend the existing autonomous work-state domain and atomic record storage.
  Do not create a second planning database.
- Add one immutable plan-contract record because the existing obligation
  record cannot preserve structured retirement seeds, survivor authority, or
  plan revisions without encoding JSON inside prose.
- Derive ordinary completion obligations from the plan contract in the same
  apply action. Existing restoration and completion status then need no second
  plan-specific workflow.
- Extend the existing residue evaluation with retirement intent. Do not add a
  second Stop gate.
- Reuse current symbol definitions, references, file dependencies, entry
  surfaces, source facts, and Git-base comparison. Native literal search is a
  valid evidence producer for configuration, tests, and documentation; it must
  report its coverage instead of being mislabeled compiler-complete.
- Reuse `requireMinimalPolicy` for stale architecture permissions. Do not add a
  fixture-only architecture detector.

## Baseline and pre-registered measurements

Before source edits:

- public working tree has one active goal and one active intended change;
- private apparatus tests passed `14/14` before scorer repair and now pass
  `18/18` after condition-neutral architecture and outcome-authority mutations
  were added;
- corrected no-agent treatment preflight
  `run-2026-08-01T18-11-47-589Z-319863` has a fresh TypeScript index, a committed
  health baseline, active `architecture` and `baseline` gate checks, and no
  skipped required check;
- the first app-server pair is diagnostic only because its fixture authority
  conflicted and its treatment lacked the architecture baseline;
- current plan scoring counts mentioned facts but does not penalize a plan that
  both promises retirement and preserves the retired identity; and
- current entry-surface proof can defeat residue suspicion without retirement
  authority.

The corrected generated pair remains diagnostic until the task-family and
repetition thresholds below have at least one calibration run. A counted
program uses six fresh seeds per supported family and fixes them before
candidate execution.

The first retry-policy calibration pair is not a product result. Its old
scorer awarded the treatment `11/11` and the control `9/11`, but the difference
was caused by two apparatus defects. It required a treatment-only
`.scipquery.json` file from the control, and it did not reject three copied
outcome-effect implementations in the treatment. The control instead reused
the existing `applyDeliveryOutcome` authority and left one coherent effect
owner. The corrected scorer applies hidden architecture facts to both
conditions, requires tool configuration only when that condition started with
it, and requires one core outcome-effect authority. A new candidate pair is
required; rescoring the observed run cannot turn it into counted evidence.

The same treatment transcript also showed avoidable workflow cost. Within one
uncompacted agent turn it called `status --capabilities` six times,
`plan apply plan.md` four times, `diff-gate` three times, `reindex` twice, and
`diff-impact` twice. Some repeats followed changed plan text or repository
state, but others repeated the same read-only observation. The product response
is a valid `plan example`, inline goal/change creation in one `plan apply`, and
an explicit rule to reuse exact read-only results until a named input changes.

Primary thresholds:

1. **Direct:** no treatment-only completion failure or false block; median
   uncached-token overhead no more than 15% when final quality is equal.
2. **Nonlocal discovery:** treatment plan covers at least one more required
   relationship in at least four of six matched seeds, with no increase in
   unsupported claims and no lower final completion rate.
3. **Retirement:** all seeded definite retirement contradictions block; at
   least five of six complete treatment states retire every required artifact;
   no benign supported survivor blocks.
4. **Architecture:** every seeded forbidden edge and enabled stale allowance
   blocks; every allowed edge and unchanged policy passes.
5. **Review lift:** SCIP review repairs more consequential true defects than
   equal-time native review in at least four of six matched states, introduces
   no regression, and makes no repair from a benign look-alike.
6. **Sustained:** after a context reset, at least five of six treatment runs
   recover the same goal, live obligations, and next evidence-producing slice
   without a human restatement; final completion is not lower than control.

A family is harmful when treatment alone produces a goal failure, regression,
unsupported scope expansion, or false completion block in two or more of six
matched seeds. It is inconclusive when neither its benefit threshold nor its
harm threshold is met. Cost is compared only among states with equal primary
quality.

## Post-trial generalization standard

The generated retry-policy fixture is a defect revealer, not the product
specification. A remediation is acceptable only when its input is a repository
relationship, a contract shape, or a fixed evidence rule that can occur in an
unrelated repository. A remediation is not acceptable when it names the
fixture's retry behavior, generated symbols, application directories, expected
patch, or hidden evaluator facts.

The replacement trial
`run-2026-08-01T21-29-09-251Z-47cc65` is the first locally valid full-flow
observation. Both conditions began from the same source, prompt, dependencies,
model, and reasoning setting. Setup finished before measured work. Both trusted
Stop hooks executed. The control completed `12/12`. The treatment completed
`9/12` and reached the fixed three-minute review limit. This establishes a
negative result for that exact fixture and time allocation, not for arbitrary
coding tasks.

The trial exposed four general product failures:

1. Plan decoding reports one schema defect at a time. The candidate needed five
   failed apply attempts to learn one reuse-authority object.
2. `plan-context` compares the changed target with possible reuse owners but
   does not compare the affected consumers. It can therefore find a replacement
   policy while missing an existing owner of the consumers' surrounding
   responsibility.
3. Reuse verification accepts only an immediate callee. It can reject a real
   higher-order delegation through an existing factory.
4. A failed reuse finding does not show the observed path, the missing path, or
   the shallowest evidence-producing next command. The candidate inspected the
   installed implementation instead of repairing repository code.

Each repair must pass fixture-neutral tests. Plan diagnostics use arbitrary
invalid contracts. Consumer reuse tests use generated symbol names and more
than one responsibility shape. Delegation tests cover direct, transitive,
higher-order, missing, and ambiguous paths. Finding-output tests assert evidence
fields rather than a benchmark-specific sentence.

## Ordered slices

### Slice 1 — immutable plan contract and one-action apply

Status: implemented; focused domain, runtime, CLI, and storage checks pass.

- **Anchors:** `src/domain/autonomous-work-state.ts`,
  `src/domain/autonomous-work-obligations.ts`,
  `src/storage/autonomous-work-state.ts`,
  `src/runtime/commands/work-state-handlers.ts`, and
  `src/runtime/commands/command-descriptors.ts`.
- **Change:** add a versioned plan-contract decoder and immutable record with
  workflow class, affected seeds, preservation conditions, retirement seeds,
  supported survivors, architecture conditions, completion evidence, and
  optional predecessor. Add `scip-query plan apply <path>` plus read, validate,
  and status operations. Apply reads one `scip-query-plan` JSON fence from a
  Markdown plan, resolves the current goal/change, fixes a repository receipt,
  publishes the plan record, and derives all live obligations in one action.
- **Validation:** decoder mutation tests; storage retry, collision, revision,
  fork, and malformed-record tests; command contract and one-action integration
  tests; goal/change mismatch must fail before any publication.
- **Test seam:** pure Markdown extraction and domain decoding; injected atomic
  runtime for persistence; command integration against a temporary repository.
- **Order:** record and storage land before the CLI; Stop does not trust this
  record until Slice 2.

### Slice 2 — adaptive routing without ceremony

Status: implemented; generated docs, lint, API checks, and the full suite pass.

- **Anchors:** `skills/scip-query/SKILL.md`, `skills/scip-plan/SKILL.md`,
  `skills/scip-verify/SKILL.md`, and generated command documentation.
- **Change:** define observable escalation triggers. A literal local task stays
  direct until compiler or policy evidence finds a consumer, public surface,
  retirement, architecture, migration, security, durability, or multi-slice
  consequence. Relational work writes and applies one concise contract.
  Sustained work adds ordered resumable slices. New evidence may escalate; a
  downgrade requires evidence that defeats the trigger.
- **Validation:** skill-link validation, generated command preview/reference,
  and text contract tests that direct work has no plan requirement while every
  modifier escalates.
- **Order:** may ship with the inert plan record; it does not affect Stop
  authority by itself.

### Slice 3 — retirement closure and supported survivor decisions

Status: implemented, including a repair for deleted tracked files in the
retirement scan. The repair was proven by fail-pass-fail-pass testing.

- **Anchors:** `src/domain/residue.ts`,
  `src/queries/impact/newly-unreferenced-residue.ts`,
  `src/runtime/residue-completeness.ts`, and
  `src/runtime/completion-evaluation-context.ts`.
- **Change:** load current plan contracts for each change during the fixed Stop
  context. Evaluate each retirement seed against the current repository and
  its pre-edit observation. Public reachability becomes a reachability fact,
  not an automatic current-role proof, when the plan requires that identity or
  responsibility to retire. A matching supported survivor needs non-plan
  authority and a concrete current consumer or policy referent. Definite live
  contradictions create blocking obligations. Partial closure coverage creates
  one supported-disposition obligation with exact unresolved evidence.
- **Validation:** first add a failing fixture in which a removed consumer leaves
  a reachable alias/re-export. Add passing controls for an authorized current
  consumer, unrelated same-name code, and partial evidence. Exercise the pure
  domain seam, diff-gate producer, completion admission, and Stop output.
- **Order:** read-only plan integration precedes enforcement. Existing repos
  with no plan contract retain their current behavior.

### Slice 4 — condition-aware architecture and plan scoring

Status: implemented in the private apparatus; `18/18` apparatus tests pass.

- **Anchors:** private `lib/generator.mjs`, `lib/evaluator.mjs`,
  `tests/product-architecture.test.mjs`, and `tests/evaluator.test.mjs`.
- **Change:** enable minimal architecture policy in the generated retirement
  fixture; prove stale allowances pass before the relevant edge disappears and
  fail afterward. Change plan scoring to record obligation direction and
  authority. A plan that names a fact but preserves something the task retires
  receives a contradiction, not credit for that obligation.
- **Validation:** mutation tests for missing, correctly retired,
  contradiction, authorized survivor, stale allowance, and benign policy.
- **Order:** freeze the scorer and thresholds before any corrected candidate
  result is read.

### Slice 5 — product verification

Status: implemented; lint, API checks, focused runtime and query tests, the 25
Stop-hook tests, and the full 2,479-test suite pass.

- The corrected matched pair `run-2026-08-01T19-51-24-447Z-494df5` produced a
  real negative result: control scored 12/12 by reusing `applyDeliveryOutcome`;
  treatment scored 11/12 after retaining four outcome-effect owners. The
  treatment plan saw the existing helper but rejected it as a broader refactor
  without repository evidence of a semantic mismatch.
- The long terminal wait was a separate runner defect. The private runner now
  issues a protected goal/change authorization before candidate time, gives
  the hook read-only access, denies candidate writes, and treats a later
  authorization-only boundary as a terminal measured state. The corrected
  preflight passed in `run-2026-08-01T20-21-44-950Z-e0443f`.
- Product remediation now exposes bounded reuse candidates in `plan-context`,
  records selected shared owners in `reuseAuthorities`, checks every named
  consumer through the compiler graph at the final gate, and accepts only
  monotonic architecture-policy tightening as derived configuration authority.

- **Anchors:** every file changed by Slices 1–3 and the exact requirements in
  this plan.
- **Change:** no new behavior. Build, run focused tests, run the full suite,
  inspect final impact, validate public schemas/docs/skills, and give the public
  diff gate one owner.
- **Validation:** `npm test`, typecheck, build, public API compatibility,
  generated command docs, skill links, `scip-query diff-impact`, and one
  `scip-query diff-gate` after the watcher refreshes.
- **Order:** must pass before candidate trials use the local release.

### Slice 6 — corrected diagnostic pair and next family

Status: pending a rebuilt and installed local release.

- **Anchors:** private `run-pilot.mjs`, frozen generator seed, condition
  manifests, frozen pre-edit plan, pre-review repository snapshot, transcript,
  and silent evaluator report.
- **Change:** run one corrected matched `gpt-5.6-luna` Max pair with setup
  outside measured time, twelve minutes for planning and implementation, and
  three minutes for review. Do not disclose the clock, condition, or evaluator.
  Then add one seeded-verification state with both true residue and benign
  look-alikes before starting a counted family.
- **Validation:** readiness must prove treatment setup and control isolation;
  conditions run in separate sandboxes; both Stop hooks finish; scorer runs
  only after sessions end; immutable artifacts include transcript and phase
  snapshots.
- **Order:** diagnostic result guides later families but cannot change the
  scorer or thresholds above.

### Slice 7 — one-pass plan authoring diagnostics

Status: implemented; typecheck and 44 focused domain and CLI tests pass.

- **Anchors:** `src/change-control/plan-contract.ts`,
  `src/runtime/commands/plan-contract-handlers.ts`, and their domain and command
  tests.
- **Change:** validate independent contract sections and items before returning;
  report every presently actionable schema defect with its field path in one
  response. Keep the decoder fail-closed and preserve the canonical request
  type. Add a complete generic reuse-authority example beside the valid starter.
- **Validation:** one malformed contract contains independent retirement,
  evidence, reuse, and slice defects; one decode reports all of them. Existing
  valid records remain byte- and identity-compatible.

### Slice 8 — affected-consumer reuse discovery

Status: implemented; typecheck and 38 focused query and CLI tests pass.

- **Anchors:** `src/queries/impact/plan-context.ts` and
  `src/runtime/query-commands/planning.ts`.
- **Change:** compare a bounded set of compiler-resolved affected consumer
  functions with current repository owners. Report target-level replacement
  options separately from consumer-responsibility owners. Exclude the affected
  consumers themselves from owner recommendations and disclose omitted
  consumers.
- **Validation:** unrelated names and files reproduce an old target whose
  consumers duplicate an existing shared effect owner. The plan result reports
  both the replacement policy and the surrounding effect owner without knowing
  the desired patch.

### Slice 9 — evidence-complete reuse verification

Status: implemented; typecheck, eight path-verifier tests, and three
completion-reconciliation tests pass.

- **Anchors:** `src/queries/impact/plan-reuse-authority.ts` and the plan-backed
  `new-dead` gate adapter.
- **Change:** prove delegation through a bounded compiler-resolved path instead
  of one immediate callee. Record the observed path or the shallowest frontier
  for every consumer. Treat incomplete traversal as insufficient evidence, not
  contradiction.
- **Validation:** direct and transitive calls pass, a factory or injected-policy
  path passes only with compiler evidence, missing paths fail, cycles terminate,
  and an exceeded bound reports incomplete coverage.

### Slice 10 — repair-ready completion feedback

Status: implemented; lint, API checks, 74 focused runtime and query tests, the
25 Stop-hook tests, and the full 2,479-test suite pass.

- **Anchors:** `src/queries/impact/diff-gate.ts`,
  `src/runtime/agent-hooks.ts`, the completion-status command, and planning
  skills.
- **Change:** include each failed consumer, expected owner, observed path or
  frontier, and one repository command that exposes the same evidence. Make
  human completion status concise by default. Keep full record history for an
  explicit programmatic request. Tell repair agents to use repository evidence,
  not installed tool internals.
- **Validation:** Stop output is sufficient to select the next repository edit
  without reading scip-query source. Output-size tests bound default status and
  skill text. Full JSON remains available to programmatic consumers.

### Slice 11 — trustworthy frozen pilot and transcript-driven repair

Status: implemented. The protected apparatus has 24 passing tests; fixed-seed
preflight passed; matched run
`run-2026-08-01T23-00-45-817Z-bb3464` completed with an honest `time-limited`
label because workflow review reached its three-minute deadline.

- **Runner:** setup, health baseline, index, architecture activation, and a
  complete first/later Stop handshake finish outside measured time. Runs are
  classified as `valid`, `time-limited`, or `invalid`; a missing, failed, or
  unsettled required hook suppresses comparison. Replay fixes the fixture seed
  and refuses changes to the prompt, evaluator, generator, model, effort, or
  time limits. Provider sampling seed is explicitly unavailable.
- **Observed result:** control was valid and complete at 12/12 in 255,249 ms
  with 377,667 model tokens. Workflow was 10/12 before Stop and 12/12 after
  repairing three stale architecture permissions, in 657,461 ms with 1,803,892
  model tokens. Both produced identical source; their tests differed only in
  assertion organization. Workflow's plan contained 10 grounded facts versus
  control's 6, including the shared outcome owner and one additional retirement
  artifact.
- **Interpretation:** the pilot shows that scip-query enforced and repaired its
  stronger architecture-cleanliness standard. It does not show better shared
  code-task completion because control was already complete and the stale
  policy existed only in the configured workflow condition. Cost remains a
  serious regression: 4.8x total model tokens, 2.9x uncached tokens, 2.6x time,
  and 2.6x tool calls.
- **General repairs from the transcript:** aggregate workflow/slice shape errors
  with item errors on the first `plan apply`; support the documented
  `affected --full` traversal; name `.scipquery.json` and its
  `allowedDependencies` repair directly for stale allowances; and delay loading
  `scip-verify` until a coherent implementation exists. Route compiler-backed
  callee evidence through the internal query boundary, use one shared shell
  argument quoting implementation, honor source `ignore-similar` decisions in
  both exact and near-similarity checks, and retain a historical co-change
  disposition only with renewed evidence that the old coupling ended.
- **Validation after repair:** formatting, lint, build, type checking, generated
  docs, skill links, the public API contract, all 2,479 public tests, and all 24
  private apparatus tests pass. A real indexed `affected --full` query also
  completed successfully. The final diff gate passed with no skipped checks;
  its two remaining documentation references are advisory and still point to
  accurate documentation.

## Risks and explicit deferrals

- Compiler identity does not by itself prove that two differently named
  implementations preserve the same responsibility. The first retirement
  closure is intentionally contract-seeded and reports literal-source coverage
  separately from compiler coverage.
- A candidate-authored plan may strengthen work but cannot authorize its own
  compatibility exception or weaken a protected goal. Protected trials keep
  goal and evaluator authority outside the candidate worktree.
- The generated fixture tests mechanism, not transfer. A private short Vega
  mission is deferred until the component families pass their calibration
  thresholds.
- Universal improvement on arbitrary coding tasks is not a claim this program
  can establish.
- Per-slice commits are deferred while the repository contains user-owned
  uncommitted plan and review work. Verification and explicit path summaries
  remain mandatory; no unrelated file will be staged or rewritten.

```scip-query-plan
{
  "schemaVersion": 1,
  "goalId": "SQG-4061E7D5D360464ED8E8B05D53BBF49D",
  "changeId": "SQC-DED67E74D3898BDCA85766BE8D3C93AF",
  "workflowClass": "sustained",
  "affectedSeeds": [
    { "id": "plan-decoder", "kind": "symbol", "referent": "decodePlanContractRequest", "role": "plan contract validation boundary" },
    { "id": "planning-context", "kind": "symbol", "referent": "planContext", "role": "pre-edit repository evidence composer" },
    { "id": "reuse-gate", "kind": "symbol", "referent": "planReuseAuthority", "role": "planned shared-owner verifier" },
    { "id": "stop-output", "kind": "symbol", "referent": "renderStopHookOutput", "role": "autonomous repair feedback boundary" }
  ],
  "preserve": [
    { "id": "fixture-independence", "condition": "Product logic does not name or encode the benchmark fixture, expected patch, or evaluator facts", "evidenceIds": ["general-tests"] },
    { "id": "fail-closed", "condition": "Unknown or incomplete compiler evidence cannot establish a plan or delegation claim", "evidenceIds": ["general-tests", "gate"] },
    { "id": "public-compatibility", "condition": "Existing valid plan records and public query consumers remain compatible", "evidenceIds": ["api", "full-tests"] },
    { "id": "bounded-work", "condition": "New discovery and verification traversals disclose and obey fixed coverage bounds", "evidenceIds": ["general-tests", "docs"] }
  ],
  "retirements": [],
  "allowedSurvivors": [],
  "reuseAuthorities": [],
  "architecture": [
    { "id": "architecture-clean", "predicate": "configured-policy-clean", "condition": "The configured architecture policy remains clean and minimal", "evidenceIds": ["gate"] }
  ],
  "completionEvidence": [
    { "id": "general-tests", "description": "Run fixture-neutral contract, discovery, path, and output tests" },
    { "id": "api", "description": "Check public TypeScript API compatibility" },
    { "id": "full-tests", "description": "Run the complete repository test suite" },
    { "id": "docs", "description": "Regenerate and check command and skill documentation" },
    { "id": "gate", "description": "Run the configured final diff gate once" }
  ],
  "slices": [
    { "id": "plan-diagnostics", "outcome": "One plan validation response reports all actionable contract defects", "evidenceIds": ["general-tests"], "dependsOn": [] },
    { "id": "consumer-reuse", "outcome": "Planning reports existing owners of responsibilities repeated across affected consumers", "evidenceIds": ["general-tests", "api"], "dependsOn": ["plan-diagnostics"] },
    { "id": "delegation-paths", "outcome": "Reuse verification proves bounded direct and indirect compiler-resolved delegation paths", "evidenceIds": ["general-tests", "api"], "dependsOn": ["consumer-reuse"] },
    { "id": "repair-feedback", "outcome": "Completion feedback gives bounded repository evidence that directly supports the next repair", "evidenceIds": ["general-tests", "docs", "full-tests", "gate"], "dependsOn": ["delegation-paths"] }
  ]
}
```
