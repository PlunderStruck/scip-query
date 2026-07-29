# scip-query — Agent-design audit

Date: 2026-07-28  
Audited revision: `9de38b98ac75fe0fa620d921c83911e7634e255c` plus the concurrent working tree  
Audited package version: `0.19.8`  
SCIP generation: `df6b3874ca7b` (fresh when the review began)

Scope: the agent-facing scip-query control loop: lifecycle-hook installation
and execution, prompt routing, index freshness, diff-gate completion feedback,
output pagination, context compaction, suppression decisions, outcome history,
effectiveness metrics, and the boundary between autonomous decisions and human
oversight.

Method: this was a production-code read-only review using the `agent-design`
lens and the `scip-audit` evidence discipline. Compiler-resolved scip-query
results established identities and complete reference sets where relationships
mattered. Native reads established literal policies and branch ordering.
Disposable temporary-repository probes exercised the built CLI. No sub-agents
were used. No production code, tests, configuration, or skills were changed.

Focused existing tests passed:

- 4 test files;
- 36 tests;
- agent-hook context and feedback;
- universal output pagination;
- Stop-hook snapshot-document policy;
- `new-dead` evidence classification.

This report records **ten findings**:

- **four high-severity findings:** AD-01 through AD-04;
- **six medium-severity findings:** AD-05 through AD-10.

AD-04 deliberately does **not** recommend human approval for every
suppression. High-volume approval streams are not a credible control. It
instead specifies bounded automated adjudication: the model remains able to
suppress findings, while scip-query enforces the conditions under which that
decision is narrow, evidenced, reversible, and visible.

---

## 1. Outcome

scip-query already contains most of the right primitives for an effective
coding-agent evidence system:

- compiler-resolved graph evidence;
- explicit command evidence and coverage metadata;
- immutable result-pagination snapshots;
- generation-bound `refs` result cursors;
- bounded execution and process ownership;
- diff-gate single-flight coordination;
- required evidence-tier failure propagation;
- conflict-aware suppression records;
- durable finding-outcome events;
- skill text that distinguishes literal search from relationship evidence and
  tells agents not to optimize for health scores.

The weakness is integration at the moments where an agent decides whether it
knows enough to continue or finish. Freshness, analysis budget, generation
identity, prior attempts, suppression provenance, and unfinished pagination
exist in different subsystems but are not carried through one durable
agent-facing state.

The most consequential result was runtime-confirmed:

1. the same source edit was checked against a stale and a fresh index;
2. the stale gate reported zero changed symbols and no `new-dead` finding;
3. the fresh gate found the newly added, unconsumed symbol;
4. the installed Stop path neither establishes freshness nor reports degraded
   evidence.

Two other silent-allow paths were confirmed:

- a configured project with no index makes `hook-stop` exit zero with no
  output;
- a finding accepted through a suppression disappears from Stop feedback
  entirely.

The suppression result does not mean autonomous suppression should be removed.
It means suppression is currently an unconstrained self-adjudication action:
the model can make the finding disappear merely by producing a syntactically
valid record. The correct automation-first response is to make the action
policy-bearing rather than approval-bearing.

---

## 2. Essential concepts

An **agent control loop** is the recurring software process in which the model
observes repository state, chooses a tool or edit, observes the consequence,
and decides whether more work is required. Its concrete units here are Codex
and Claude sessions, scip-query commands, lifecycle hooks, source edits,
watcher refreshes, and Stop decisions. What makes it a control loop rather
than a command sequence is that later actions are selected from the effects
observed after earlier actions.

An **observation** is a time-bound fact made available to the model about the
environment it is changing. A command result is not one timeless fact: it is
evidence from a particular index generation, worktree state, command
invocation, analysis budget, and moment. Those identities are what let the
model decide whether two results can be combined.

An **evidence lease** is a bounded claim that a gate or query observed one
identified index generation and one identified worktree state for the duration
of its computation. Its defining characteristic is that a result is rejected
or downgraded when either state changes before the result is published.

A **suppression** is a durable classification that one detector finding does
not require the code change suggested by that detector under a stated scope
and body of counterevidence. It is not proof that the detector never found
anything, and it is not a deletion of history. A suppression remains honest
when the finding, decision maker, reason, evidence, scope, and invalidation
condition remain visible.

**Automated adjudication** is a tool-enforced decision process that permits
the model to accept or reject a detector finding without waiting for a person.
It differs from unconstrained self-approval because the admissible scope,
required counterevidence, risk ceiling, expiry, and visibility rules are
enforced outside the model's prose.

An **escalation** is an interruption reserved for a decision whose variety or
consequence exceeds the automated policy. Its useful units are not thousands
of individual low-risk suppressions. They are unusual policy changes, broad
waivers, safety-relevant findings, sudden detector-quality regressions, and
clusters the automated rules cannot classify.

An **effectiveness metric** is an observational summary of what happened to
findings after they were emitted. Repository-local outcome records can
describe agent behavior, but they cannot independently grade that behavior
when the same agent can modify or remove the records.

---

## 3. Environment and autonomy model

### 3.1 What the agent is trying to achieve

The desired environmental state is:

- the requested code behavior is correct;
- relevant consumers, dependencies, and changed effects were not missed;
- every relationship claim rests on evidence from a known generation;
- incomplete or degraded evidence remains visibly incomplete;
- the agent uses scip-query where compiler resolution changes the answer, but
  does not use it for ordinary literal source lookup;
- routine low-risk decisions proceed without human interruption;
- rare high-consequence or policy-changing decisions arrive with the working
  state needed to resolve them;
- watcher, query, and gate work remain bounded enough that evidence gathering
  does not dominate the engineering task.

Command counts, health scores, number of findings fixed, number of
suppressions, and a silent Stop hook are activity proxies. None is the target
state by itself.

### 3.2 What the agent can perceive

The current loop can perceive:

- repository instructions and skill descriptions;
- command arguments, output, evidence grade, analysis budget, and coverage;
- index freshness through `status`;
- watcher state and refresh activity;
- Git diffs and detector findings;
- page completion and transport cursors;
- test, typecheck, build, and gate outcomes;
- suppression and outcome-event files;
- lifecycle-hook feedback.

Important facts are missing or inconsistently retained:

- the common JSON envelope does not identify the index generation;
- the Stop wrapper drops its execution analysis budget and outcome state;
- PostCompact returns no state;
- unfinished output snapshots do not expose a discoverable session resume
  record;
- the Stop gate does not prove that the generation is fresh for the worktree
  it checks;
- repeated-finding history exists, but the installed Stop wrapper does not
  render it.

### 3.3 What the agent can change

The model can:

- edit source, tests, docs, configuration, CI, hooks, and skills;
- run queries, reindex requests, tests, gates, and builds;
- write suppression records;
- cause outcome-event records to be written;
- edit or delete repository-local evaluator inputs;
- finish a task after advisory feedback.

Because the model can change both the code and several criteria used to judge
the code, repository-local gates are evidence and workflow controls, not an
independent security boundary.

### 3.4 Safe autonomy boundary

Full autonomy is appropriate for low-variety, high-frequency actions whose
effects scip-query can verify mechanically:

- follow an immutable output continuation;
- wait for an already-active watcher;
- request one deduplicated refresh;
- rerun a gate after freshness is restored;
- write a narrow finding-ID suppression whose policy conditions all pass;
- apply an existing generated postcheck mapping;
- aggregate and report suppression and outcome statistics.

Escalation is appropriate for decisions that change policy or carry
consequences the available evidence cannot bound:

- broad detector- or file-wide suppressions;
- changes to the rules deciding which suppressions are automatic;
- safety-, security-, release-, permission-, or durability-relevant findings
  without mechanically verifiable counterevidence;
- incompatible committed records;
- a surge in one detector's suppression rate;
- contradictory graph and source evidence;
- a gate whose worktree or index generation changed during execution.

Escalation may be another automated calibration workflow or an independent
review agent before it becomes a human interruption. Human attention should
be reserved for the small residual set that remains unresolved after those
cheap automated checks.

---

## 4. Finding register

| ID | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| AD-01 | High | Stop can silently miss defects against a stale index | Runtime-confirmed |
| AD-02 | High | Missing index is treated as successful Stop silence | Runtime-confirmed |
| AD-03 | High | Host timeout expires before the gate's owned timeout | Source-confirmed deadline inversion |
| AD-04 | High | Automated suppressions have no enforced adjudication policy and disappear from Stop feedback | Runtime-confirmed |
| AD-05 | Medium | Exact output continuation changes executable identity | Runtime-confirmed |
| AD-06 | Medium | Anti-truncation enforcement misses the local built CLI | Runtime-confirmed |
| AD-07 | Medium | PostCompact restores no agent evidence state | Runtime-confirmed |
| AD-08 | Medium | Installed Stop feedback drops analysis budget and repeated-finding history | Complete relationship comparison |
| AD-09 | Medium | Common evidence envelopes cannot prove cross-command generation consistency | Protocol inspection |
| AD-10 | Medium | Effectiveness is useful writable telemetry but is presented too much like an independent grade | Data-authority inspection |

---

## 5. Detailed findings

### AD-01 — High — Stop can silently miss defects against a stale index

**Evidence:** runtime-confirmed; complete freshness-reference inventory;
source-confirmed data flow.

**Current behavior**

- `runIsolatedStopHookDiffGate` resolves a workspace, checks only that the
  database path exists, and immediately starts the gate:
  `src/runtime/agent-hooks.ts:796-813`.
- `executeDiffGate` selects an analysis budget and invokes `diffGate` without
  a freshness precondition: `src/runtime/diff-gate-execution.ts:104-145`.
- `diffImpactPartial` obtains candidate changed definitions from
  `ProjectIndex.definitionsForFile`: `src/queries/impact/diff-impact.ts:205-222`.
- The complete reference set for `getIndexFreshness` contains hook context,
  status/setup, watcher, and command-handler uses, but no Stop-gate execution
  or diff-gate execution use.

**Runtime probe**

A disposable Git repository contained one committed function. The working
tree added a new exported function with zero consumers. Two equivalent fixture
indexes were used:

```json
{
  "stale": {
    "changedSymbols": 0,
    "newDead": []
  },
  "fresh": {
    "changedSymbols": 1,
    "newDead": [
      "src:internal:orphan() (src/internal.ts) was changed but has zero indexed consumers"
    ]
  }
}
```

The stale run still listed `new-dead` in `checksRun`; it did not say the check
lacked the new definition. This is therefore not merely an omitted
optimization. The observation required for the check was absent while the
check reported ordinary completion.

**Attempted refutation**

- SessionStart and UserPromptSubmit can wake or request the watcher, but
  neither proves the watcher completed after the agent's later edits.
- The gate reads Git diff and current files for several checks, but
  changed-symbol attribution and graph consumers still originate in the
  database.
- A watcher may often finish before Stop. “Often” is not a postcondition, and
  the reproduced stale result proves the gate does not defend itself.
- Reindexing blindly inside Stop would introduce competing work and repeat the
  CPU failure this repository recently fixed. The correct response is to
  observe and coordinate with the active watcher.

**Required design**

Introduce a gate evidence lease:

1. capture current worktree/diff identity;
2. inspect freshness and the published generation;
3. if stale and a watcher is busy or has a pending refresh, return explicit
   retry feedback instead of starting another reindex;
4. if stale and the watcher is idle, request one refresh and return explicit
   retry feedback;
5. run the gate only against a fresh identified generation;
6. compare worktree identity and generation again before publishing;
7. reject or downgrade the result if either changed.

**Required tests**

- The stale/fresh new-symbol probe becomes a regression test.
- Busy watcher produces “wait and retry,” not a competing refresh.
- Idle stale watcher receives one deduplicated request.
- Source mutation during a gate invalidates the result.
- Generation publication during a gate invalidates the result.
- A stable fresh run preserves current detector behavior.

---

### AD-02 — High — Missing index is treated as successful Stop silence

**Evidence:** runtime-confirmed; source-confirmed branch.

`handleAgentHookStop` emits nothing when its isolated helper returns
`undefined`. The helper returns `undefined` when no workspace or database
exists: `src/runtime/agent-hooks.ts:778-813`.

Disposable configured-repository probe:

```json
{
  "status": 0,
  "stdoutLength": 0,
  "stderrLength": 0
}
```

The agent and host cannot distinguish:

- no relevant change;
- a clean completed gate;
- no index;
- workspace resolution failure.

**Required design**

Return explicit states from Stop preparation:

```ts
type StopGatePreparation =
  | { kind: "ready"; workspace: HookWorkspace }
  | { kind: "reentry" }
  | { kind: "outside-project" }
  | { kind: "missing-index"; remediation: string }
  | { kind: "invalid-workspace"; reason: string };
```

Only `reentry` and a deliberately documented outside-project case may be
silent. A configured project with missing evidence must be “not certified.”
Block mode blocks; feedback and warn modes remain nonblocking but visible.

---

### AD-03 — High — Host timeout expires before the gate's owned timeout

**Evidence:** source-confirmed deadline inversion.

- The installed Stop hook timeout is 30 seconds:
  `src/runtime/agent-hooks.ts:620-629`.
- The non-full isolated diff-gate deadline is 60 seconds:
  `src/runtime/diff-gate-execution.ts:21`.
- The gate's owned child timeout, progress diagnosis, termination, and
  structured “cannot certify” result therefore cannot complete for a run the
  host terminates between 30 and 60 seconds.

This does not require a permanently hung gate. Any healthy 31-second run is
outside the designed completion envelope.

**Required design**

One deadline contract must derive both values. The host allowance must exceed
the internal gate deadline plus diagnostic serialization and process-reaping
grace. For example:

- bounded child deadline: 60 seconds;
- termination/reaping grace: 5 seconds;
- host hook timeout: at least 70–75 seconds.

Tests should assert the inequality instead of duplicating numeric literals.
An integration test should make the child exceed its own deadline and confirm
the host receives scip-query's explicit failure output.

---

### AD-04 — High — Automated suppressions have no enforced adjudication policy and disappear from Stop feedback

**Evidence:** runtime-confirmed; source-confirmed suppression flow.

**Current behavior**

- `applyStructuredSuppressions` moves matching findings from
  `result.findings` to `result.suppressed`:
  `src/queries/impact/diff-gate.ts:491-503`.
- `handleAgentHookStop` returns silently when there are no unsuppressed
  findings and no compatibility warning:
  `src/runtime/agent-hooks.ts:778-789`.
- A valid reason plus an ID or check is sufficient to match. Check+file
  suppressions can waive every current and future matching finding in that
  file.

**Runtime probe**

The same changed source and doc-reference finding was run twice:

```json
{
  "unsuppressed": {
    "status": 0,
    "stdoutLength": 538,
    "hasFinding": true
  },
  "suppressed": {
    "status": 0,
    "stdoutLength": 0,
    "stderrLength": 0
  }
}
```

The suppression reason was ordinary agent-authored prose. No mechanism
required counterevidence, a narrow stable ID, expiry, an invalidation rule, or
an automated risk classification.

**Rejected remedy: approve every suppression**

That remedy conflicts with the automation objective and would not be a real
control. A high-volume, near-zero-refusal approval stream trains automatic
acceptance, consumes more effort than the detector saves, and leaves the
human judging fluent plausibility instead of mechanically checkable effects.

The model must remain able to suppress findings. The missing mechanism is an
enforced automated adjudication policy.

#### Automated suppression policy

A model-proposed suppression is eligible for immediate automatic acceptance
only when all applicable conditions pass:

1. **Exact scope.** It names a stable finding ID. Check-only and check+file
   waivers are policy changes, not ordinary finding adjudications.
2. **Structured reason.** The record carries a reason code such as
   `entry-surface`, `generated-code`, `compatibility-shim`,
   `reflection-or-registration`, `test-fixture`, `intentional-twin`,
   `historical-coupling-ended`, or `detector-counterexample`, plus concise
   prose.
3. **Counterevidence.** It records the facts that make the detector's
   remediation inapplicable: exact source/config locations, relevant graph or
   source evidence, and the command/generation when applicable.
4. **Risk ceiling.** The finding is advisory, heuristic, low-confidence, or
   belongs to a detector whose autonomous-adjudication policy explicitly
   permits the supplied reason code. A graph fact is still suppressible, but
   only when the counterevidence establishes why the graph fact does not imply
   the proposed action.
5. **Invalidation rule.** The record states when it must be reconsidered:
   detector semantic-version change, target-content change, related-config
   change, expiry, or disappearance of the cited exception.
6. **No broad authority.** The proposal does not change detector configuration,
   hook mode, baseline policy, or the rules deciding which suppressions are
   eligible.
7. **Compatibility complete.** Every committed suppression record was decoded;
   an incompatible record cannot authorize acceptance.
8. **Rate healthy.** The detector and repository remain within an explicit
   automatic-suppression rate/burst budget. A sudden spike routes to detector
   calibration rather than generating hundreds of unquestioned records.
9. **Effect visible.** Stop and JSON output report that the gate completed
   with automatic suppressions, including total, newly added, expired, and
   policy-escalated counts.
10. **Decision durable.** The existing conflict-aware exclusive writer and
    revision semantics remain mandatory.

Example additive record shape:

```json
{
  "decision": {
    "kind": "automated-adjudication",
    "reasonCode": "compatibility-shim",
    "decidedBy": "agent",
    "policyVersion": 1,
    "evidence": [
      {
        "kind": "source",
        "path": "src/compat/example.ts",
        "claim": "The duplicate surface is intentionally retained for the v1 API."
      }
    ],
    "invalidateOn": {
      "targetContentChange": true,
      "detectorMajorChange": true,
      "expiresAt": "2026-10-28"
    }
  }
}
```

#### Escalation without per-finding human review

The following leave the ordinary automatic lane:

- a check-only, detector-wide, or check+file waiver;
- changing the adjudication policy itself;
- a safety-, security-, permission-, release-, durability-, or data-loss
  finding without deterministic counterevidence;
- unsupported committed record coverage;
- contradictory graph/source evidence;
- no stable invalidation condition;
- a detector suppression-rate spike;
- repeated re-creation after the exception should have expired.

The first escalation should normally be automated:

1. rerun the narrow detector with full coverage;
2. run its calibration or counterexample workflow;
3. compare against similar accepted and fixed findings;
4. optionally ask an independent review agent to classify the cluster;
5. escalate one policy or detector-quality decision to a human only if the
   automated evidence remains ambiguous.

Humans should see a small number of cluster decisions and anomaly summaries,
not every suppression.

#### Required result semantics

A gate with suppressions should not become indistinguishable from a gate that
found nothing:

```json
{
  "outcome": "pass-with-suppressions",
  "automaticSuppressionCount": 12,
  "newAutomaticSuppressionCount": 2,
  "policyEscalationCount": 0
}
```

This is visibility, not an approval prompt. The agent may continue
automatically when `policyEscalationCount` is zero.

**Required tests**

- Exact-ID, permitted reason code, complete counterevidence, and valid
  invalidation pass automatically.
- Prose-only reasons fail policy admission.
- Check-only and check+file proposals route to policy escalation.
- A graph-fact suppression without direct counterevidence is rejected.
- A permitted graph-fact exception with deterministic evidence passes.
- Expired or source-invalidated automatic suppressions reopen findings.
- Rate bursts trigger calibration and do not create additional suppressions
  until resolved.
- Stop reports pass-with-suppressions without requiring human interaction.
- Existing legacy records remain readable but are classified as
  `legacy-unadjudicated` until replaced or sampled.

---

### AD-05 — Medium — Exact output continuation changes executable identity

**Evidence:** runtime-confirmed.

`renderInitialPageCommand` and `renderContinuationCommand` hardcode the token
`scip-query`: `src/runtime/output-pagination.ts:1186-1192`.

A page created through:

```text
node dist/cli.js outline src/runtime/agent-hooks.ts --json --output-page-size 256
```

emitted a continuation beginning with:

```text
scip-query outline ...
```

The continuation succeeded through the same local CLI and failed through the
emitted global CLI:

```json
{
  "localNext": {
    "status": 0,
    "offset": 256
  },
  "globalNext": {
    "status": 1,
    "error": "Invalid output cursor"
  }
}
```

The output snapshot itself remained valid. The defect is invocation identity.

**Required design**

Capture a safe executable prefix at registration:

- installed binary path;
- or `process.execPath` plus the canonical script path for a Node script;
- plus the filtered command arguments.

Bind the prefix or its identity to snapshot metadata and render continuations
through the same executable. Tests must cover global, local `.bin`, direct
Node script, spaces, quotes, and an installed version different from the
working-tree build.

---

### AD-06 — Medium — Anti-truncation enforcement misses the local built CLI

**Evidence:** runtime-confirmed.

`blindlyTruncatesScipQuery` recognizes command lines containing a binary named
`scip-query`, followed by a subcommand:
`src/runtime/agent-hooks.ts:711-717`.

Hook probes:

```json
[
  {
    "command": "scip-query outline ... | head -50",
    "blocked": true
  },
  {
    "command": "node dist/cli.js outline ... | head -50",
    "blocked": false
  }
]
```

The second form is common while developing scip-query itself, and it is the
same invocation form affected by AD-05.

**Required design**

Replace the enforcement regex with a shared invocation recognizer used by:

- output continuation rendering;
- PreToolUse anti-truncation;
- hook command installation tests;
- diagnostic messages.

Recognition should cover safe common forms without attempting to parse every
possible shell program:

- `scip-query`;
- absolute or relative paths ending in `scip-query`;
- `node <path>/dist/cli.js`;
- supported package runners followed by `scip-query`.

Unknown forms remain outside enforcement and should not be advertised as
covered.

---

### AD-07 — Medium — PostCompact restores no agent evidence state

**Evidence:** runtime-confirmed; source-confirmed branch.

`renderAgentHookContext` resets the native-search marker and returns
`undefined` immediately for PostCompact:
`src/runtime/agent-hooks.ts:877-903`.

Probe against the same indexed checkout:

```json
{"event":"SessionStart","stdoutLength":629,"hasIndexState":true}
{"event":"PostCompact","stdoutLength":0,"hasIndexState":false}
```

Compaction is exactly when conversation-held state becomes least reliable.
An unfinished output cursor may still identify a valid one-hour snapshot, but
the model may no longer retain the command needed to retrieve it. Repeated
queries and abandoned pagination are rational consequences of missing state,
not mere model stubbornness.

**Required design**

PostCompact should inject a compact session receipt, not the complete setup
instructions:

- repository identity;
- current index generation and freshness;
- whether source changed since the last recorded observation;
- unfinished scip-query output sequences for this session, with the exact
  next continuation;
- the last gate result and unresolved-finding count;
- one reminder that literal reads remain valid and relationship claims require
  scip-query evidence.

Supporting unfinished pagination requires associating snapshot metadata with a
session and retaining the sanitized original invocation. Multiple sessions in
one repository must not receive each other's cursors.

---

### AD-08 — Medium — Installed Stop feedback drops analysis budget and repeated-finding history

**Evidence:** complete relationship comparison; source-confirmed projection.

The isolated execution returns:

- `result`;
- outcome observations and optional ledger;
- `analysisBudget`.

The installed Stop helper asks for `includeOutcomeLedger: false` and returns
only `.result`: `src/runtime/agent-hooks.ts:796-813`.

The older `diff-gate --hook` renderer already includes:

- unresolved streak;
- low-resolution detector nudges;
- analysis-budget disclosure;

at `src/runtime/query-commands/impact.ts:357-381`.

The complete SCIP reference sets for `formatUnresolvedStreakLine` and
`formatLowResolutionNudges` each contain only that older renderer. The new
installed lifecycle hook never uses them.

**Consequences**

- A bounded gate can finish without the model seeing the bound.
- A finding repeated many times looks like its first appearance.
- A detector whose findings are almost always suppressed continues generating
  identical interruptions instead of routing to calibration.
- Outcome events are written but do not improve the next decision.

**Required design**

Return the full `DiffGateExecutionResult` to the Stop renderer. Keep feedback
compact:

- always disclose an active analysis budget;
- for findings, include times seen and age;
- for low-resolution detector families, recommend calibration rather than
  repeated local fixes;
- include automatic-suppression and policy-escalation counts from AD-04;
- keep a truly complete, stable, finding-free result silent if desired.

---

### AD-09 — Medium — Common evidence envelopes cannot prove cross-command generation consistency

**Evidence:** protocol inspection and command-family comparison.

`CliJsonEnvelopeV1` identifies:

- producer version;
- command;
- arguments/options;
- evidence;
- analysis budget;
- coverage;
- result.

It does not identify the opened index generation or worktree observation:
`src/runtime/cli-json-envelope.ts:18-31`.

`refs` result cursors already carry an `indexGeneration`, proving the concept
and implementation primitive exist. Other graph commands can be run on either
side of a watcher publication with no common field telling the agent that the
observed graph changed.

**Required design**

Add an optional common observation receipt:

```json
{
  "observation": {
    "indexGeneration": "df6b3874ca7b...",
    "freshness": "fresh",
    "worktreeIdentity": "sha256:...",
    "observedAt": "2026-07-28T16:00:00.000Z"
  }
}
```

For commands that do not use an index, omit `indexGeneration` and identify the
actual authority, such as Git commit/diff identity. For composite commands,
list the identities on which the conclusion depends.

The receipt supports:

- detecting mixed-generation reasoning;
- deciding whether a repeated query is redundant or legitimate;
- invalidating plans after another agent changes the worktree;
- attaching suppression counterevidence to the generation that produced it;
- reconstructing state after compaction.

---

### AD-10 — Medium — Effectiveness is useful writable telemetry but is presented too much like an independent grade

**Evidence:** data-authority inspection; complete read-consumer references.

`effectiveness` reads committed `.scipquery/events/*.json` records and computes:

- caught;
- fixed;
- suppressed;
- open;
- moved;
- unverified;
- `precision = fixed / (fixed + suppressed)`.

Source: `src/queries/health/effectiveness.ts:1-145` and
`src/storage/outcome-events.ts:132-162`.

The comparable-base rules for `fixed`, `moved`, and `unverified` are strong.
The weakness is authority:

- the coding agent can add, edit, or delete the repository-local records;
- the agent can author the suppressions that determine the suppressed count;
- `precision` is handling outcome, not a ground-truth judgment that emitted
  findings were correct;
- missing deleted history is not observable from the remaining directory.

**Required design**

Keep the repository ledger; it is valuable operational telemetry. Make its
limits explicit and attach provenance:

- `observerKind: local-agent | local-human | protected-ci`;
- originating gate run identity;
- index/worktree observation receipt;
- adjudication policy version for suppressed outcomes;
- record compatibility and missing-history caveats.

For comparing agent or detector quality, use an external measurement source:

- protected CI artifacts;
- append-only remote telemetry;
- transcript-derived command/action analysis;
- or a separately controlled calibration corpus.

Rename or qualify `precision` in agent-facing prose as observed
`resolution-vs-suppression rate` unless an independent correctness oracle is
present.

---

## 6. Findings considered and not filed

### The model must never write suppressions

Rejected. It would convert a high-frequency automatable classification into
an unscalable human queue. The filed problem is missing adjudication policy
and visibility, not model authority to suppress.

### Every suppression needs individual human approval

Rejected. High-volume approvals are not sustained oversight. Humans should
review policy changes, anomalous detector clusters, and sampled quality—not
every ordinary exact-ID exception.

### Pagination loses bytes

Not confirmed. Existing tests and runtime continuation proved immutable pages
reconstruct the exact output. AD-05 concerns the emitted executable identity,
and AD-07 concerns recovery of conversation-held continuation state.

### The CLI hides bounded coverage

Not filed as a general CLI defect. The generated AgentContract catalog marks
`diff-gate` bounded, and JSON output carries incomplete coverage plus
`analysisBudget` when active. AD-08 is specifically that the installed Stop
wrapper drops those fields.

### Prompt routing forces scip-query onto every task

Not confirmed. The prompt router requires two keyword hits unless a skill is
explicit, the native-search interruption fires once per context, and project
instructions preserve native reads for literal source. The current balance is
appropriately conservative.

### Health-score optimization is the objective

Not confirmed. Current skill references explicitly say detector counts are
clues rather than objectives and tell agents not to chase health scores.

### Codex and Claude can receive identical hook enforcement

Not assumed. Claude exposes PreToolUse and PostCompact surfaces used here;
Codex setup currently receives SessionStart, UserPromptSubmit, and Stop only.
Platform-specific enforcement asymmetry is real and should remain explicit.

---

## 7. Remediation program

The findings group into eight implementation slices. Only the first three
must be strictly ordered.

### Slice 1 — Stop evidence lease

Fix AD-01 and AD-02 together:

- explicit Stop preparation states;
- immediate freshness observation;
- watcher-aware wait/request behavior;
- generation and worktree identity before and after gate;
- loud missing, stale, and changed-during-run results;
- stale/fresh false-negative regression fixture.

### Slice 2 — One gate deadline contract

Fix AD-03:

- derive internal and host deadlines from one definition;
- reserve reaping/serialization grace;
- prove the owned timeout reaches the host;
- keep single-flight behavior.

### Slice 3 — Automated suppression adjudication

Fix AD-04:

- structured reason codes and counterevidence;
- exact-ID automatic lane;
- invalidation rules;
- detector risk policy and rate budgets;
- automated calibration escalation;
- visible pass-with-suppressions outcome;
- legacy-record classification;
- no per-suppression human approval.

### Slice 4 — Preserve Stop execution evidence

Fix AD-08:

- render analysis budget;
- carry outcome observations;
- compact repeated-finding age/count;
- detector-calibration nudges;
- adjudication counts from Slice 3.

### Slice 5 — Invocation identity

Fix AD-05 and AD-06:

- shared invocation recognizer;
- same-executable continuation;
- snapshot binding;
- local/global/package-runner hook tests.

### Slice 6 — Session state after compaction

Fix AD-07:

- session-scoped evidence receipt;
- unfinished pagination registry;
- PostCompact compact restoration;
- cross-session isolation and expiry.

### Slice 7 — Common observation receipts

Fix AD-09:

- additive envelope metadata;
- index/Git/worktree authority identity;
- mixed-generation detection;
- use by suppression evidence and compaction state.

### Slice 8 — Telemetry authority

Fix AD-10:

- local/CI/human provenance;
- gate-run identity;
- calibrated metric names;
- protected or external corpus for comparative evaluation;
- anomaly and sampling reports rather than universal review.

---

## 8. Acceptance criteria

The remediation is complete when all of the following are true:

1. A stale index cannot produce an ordinary finding-free Stop result.
2. A configured missing index cannot be silent.
3. A gate owns enough host time to publish its own timeout diagnosis.
4. The model can automatically suppress routine false positives without a
   human prompt when the enforced adjudication policy passes.
5. Broad or high-consequence waivers cannot enter through the ordinary
   exact-finding lane.
6. A gate with suppressions remains visibly distinct from a gate that found
   nothing, without blocking autonomous continuation.
7. Every emitted continuation invokes the same reviewed CLI identity that
   created the snapshot.
8. Anti-truncation enforcement recognizes every invocation form scip-query
   documents as supported.
9. PostCompact restores enough session state to resume unfinished evidence
   retrieval without rerunning the original query.
10. Stop feedback carries active coverage limits and useful repeated-finding
    history.
11. Cross-command reasoning can prove whether observations share an index and
    worktree generation.
12. Effectiveness output states whether it is local writable telemetry or
    externally attested evaluation.
13. Humans receive exceptional policy and detector-quality decisions, not a
    stream of routine suppressions.

---

## 9. Derived verdict

scip-query has the correct raw components for a model-based coding agent:
compiler-resolved observations, explicit coverage, durable generation state,
immutable output continuation, bounded child processes, conflict-aware policy
records, and outcome history.

It is not yet a complete model-based control loop because those components do
not remain connected through edits, watcher publication, compaction,
suppression, and Stop. The agent can receive an ordinary silent completion
signal after missing, stale, bounded, or self-adjudicated evidence.

The right direction is not less autonomy. It is **more mechanically bounded
autonomy**:

- automatic continuation instead of discarded output;
- automatic watcher coordination instead of repeated reindexing;
- automatic finding adjudication instead of universal human approval;
- explicit generation and policy receipts instead of conversational memory;
- automated detector calibration instead of repeated false-positive handling;
- human attention reserved for changes to policy, high-consequence ambiguity,
  and anomalous clusters.

That design maximizes scip-query use where it changes the quality of the
agent's decisions without turning the tool into either context pollution or a
human-maintained suppression queue.
