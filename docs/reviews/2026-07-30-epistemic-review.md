# scip-query — Epistemic review

Date: 2026-07-30
Audited revision: `ab425bc5e8b578e2ef00f9b9f27644b787071f98`
Audited package version: `0.20.0`
SCIP generation: `a087adf7ceed` (fresh when the review began)

Scope: the identity, mission, evidence model, validation program, agent
workflow, public machine contract, health model, and product boundary of
scip-query.

Ongoing decisions and unresolved questions are maintained in the
[epistemic clarification notes](./2026-07-30-epistemic-clarification-notes.md).

Method: this was a read-only review using the `epistemics`, `purpose-spec`,
`intent-analysis`, `essentials`, `concept-hygiene`, `claim-audit`,
`causal-reduction`, `knowledge-integration`, `goal-reduction`, and scip-query
exploration/audit lenses. Native source and history reads established literal
claims and implementations. Compiler-resolved scip-query evidence established
symbol identities and representative dependency paths. Live command probes
tested current envelopes, health output, effectiveness telemetry, and
self-audit behavior. No production code, tests, configuration, or skills were
changed while producing the review.

Current verification:

- `npm test`: 272 files and 2,191 tests passed;
- `npm run typecheck`: passed;
- `scip-query decorative-checkers --full`: no findings;
- `scip-query not-implemented --full`: no findings;
- `scip-query doc-drift README.md --full`: no findings;
- `scip-query doc-drift docs/CLI_JSON_OUTPUT.md --full`: no findings.

---

## 1. Outcome

scip-query is an excellent repository-evidence engine and a promising control
system for coding agents. It fulfills the first half of its mission well: it
makes repository-wide structure inspectable, preserves uncertainty better
than most developer tools, and places evidence inside planning and completion
workflows.

It has not yet established the second and ultimately decisive half of its
mission: that using this evidence reliably causes agents to make better
repository-scale decisions.

The deepest issue is epistemic rather than ordinary implementation maturity.
The common machine interface loses two facts an agent needs in order to know
what an answer warrants:

1. the actual origin of each claim is compressed into coarse labels such as
   `graph-fact`; and
2. most command outputs do not identify the index generation and worktree
   state that authorized the observation.

The derived verdict is:

| Mission layer                                                                      | Verdict                   |
| ---------------------------------------------------------------------------------- | ------------------------- |
| Make repository structure cheaply queryable                                        | Established               |
| Supply accurate, scoped evidence across supported capabilities                     | Strong but conditional    |
| Integrate evidence into agent planning and completion                              | Established operationally |
| Make every machine claim carry enough provenance to justify downstream conclusions | Partially fulfilled       |
| Demonstrably reduce agent mistakes and improve task outcomes                       | Not yet established       |

`Not yet established` means that the necessary outcome experiment has not
been run. It does not mean that the tool is ineffective.

---

## 2. Review purpose and standard

The beneficiary is the coding agent changing a repository, with the human
maintainer and the repository's future users as downstream beneficiaries.

The standard is whether scip-query helps that agent avoid preventable
whole-repository mistakes and makes a completion claim defensible from
current, scoped evidence.

The review is complete when it provides:

1. one defensible definition of scip-query;
2. the mission and beneficiary hierarchy embodied by its tradeoffs;
3. a claim-by-claim judgment of mission fulfillment;
4. the structural causes of the largest gaps; and
5. a goal-backward work register in which every item names the condition it
   must produce and the evidence that would prove completion.

This review does not certify every command, propose an implementation-ready
schema, or substitute for controlled agent-outcome trials.

---

## 3. Essential concepts

A **program entity** is a language-analyzer-identified unit such as a function,
type, method, field, or module. It differs from a text string because two
entities can share the same spelling while occupying different definitions
and relationships.

A **SCIP index** is a stored map produced by a language indexer that connects
source occurrences to program entities. Its identifying contribution is that
it can preserve which entity an occurrence denotes rather than merely where
matching characters appear.

**Repository evidence** is an observation about files, program entities,
relationships, history, checks, or worktree state whose production method and
limits let an agent decide which conclusions it supports.

An **observation receipt** is a record attached to an answer that identifies
the repository, index generation, worktree state, and observation time that
made the answer valid. It differs from ordinary result metadata because its
identity fields let a consumer mechanically reject conclusions assembled from
incompatible repository states.

**Claim provenance** is the inspectable path by which an answer was produced,
such as a SCIP occurrence, semantic-provider result, source attribution,
textual fallback, Git observation, or checker result. It differs from
confidence: provenance states where the observation came from, while
confidence or certification states what prior validation licenses a consumer
to conclude from it.

**Coverage** is the relation between the evidence examined and the complete
answer available under the command's declared scope. A complete result
examines the whole declared population; a bounded result may omit units
because a stated cap engaged; a sampled result intentionally examines a
subset; an unknown result cannot determine that relation.

An **action tier** is a classification of how strongly a finding warrants a
change. Direct evidence usually warrants a bounded local repair, signal
evidence warrants investigation, and support evidence informs another
decision without itself justifying an edit.

A **repository-scale mistake** is an edit that can appear correct in its local
file while conflicting with consumers, existing concepts, history,
architecture, or completion conditions elsewhere in the repository.

A **defensible completion claim** is an assertion that work is done whose
required checks observed the current repository state, whose relevant coverage
is visible, and whose unresolved findings have not been silently converted
into absence.

**Mission fulfillment** is the observed degree to which the product causes its
named beneficiary to reach its intended end under the conditions in which the
product claims to work. It differs from feature completeness because a
feature can operate exactly as designed without improving the beneficiary's
outcome.

---

## 4. What scip-query actually is

scip-query is a repository-local evidence-and-workflow-control system:
software whose concrete outputs include program-entity maps, reference and
caller relationships, source and history observations, cleanup candidates,
and diff-gate decisions, distinguished by making those observations available
when a coding agent plans a change or declares it complete.

The product has three nested layers:

| Layer                 | Concrete outputs                                                              | Essential contribution                              |
| --------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| Observation engine    | Definitions, references, dependencies, source facts, history                  | Makes repository relationships addressable          |
| Interpretation engine | Dead-code findings, similarity candidates, migration warnings, risk summaries | Converts observations into claims worth considering |
| Agent control loop    | Skills, planning context, hooks, diff gate                                    | Places claims at decision and completion points     |

The third layer is now the product's defining purpose. The README targets
agents that lose the whole-repository model during long tasks and states that
completion should receive a vote from repository evidence
([README](../../README.md#L23), [evidence loop](../../README.md#L27)).

The live CLI description, `Language-agnostic code intelligence CLI powered by
SCIP indexes`, now describes the historical engine rather than the whole
product ([CLI description](../../src/runtime/cli.ts#L44)). The package
description and README express the current identity more accurately
([package description](../../package.json#L4)).

The mission is therefore:

> Reduce repository-scale mistakes by making structural evidence cheap enough
> to influence agent decisions and strong enough to contest a premature claim
> of completion.

This is more fundamental than answering code-intelligence questions. If the
query engine disappeared, the hooks, gates, and skills would lose their
evidence. If the agent workflow disappeared, the query engine would remain,
but the current product mission would not. The engine is necessary; the
decision loop is what explains why the current product exists.

---

## 5. Revealed priority hierarchy

The repository's tradeoffs reveal the following order:

1. **Explicit uncertainty and fail-closed behavior over convenient certainty.**
   Unsupported capabilities, bounded scans, partial checkers, corrupt
   generations, and stale index states receive named states rather than being
   silently converted into clean answers.
2. **Operational availability and freshness over a minimal implementation.**
   Considerable effort goes to watcher lifecycle, immutable generations,
   recovery, process ownership, cache publication, and worktree isolation.
3. **Autonomous agent flow over routine human approval.** Hooks, skills, and
   automatic adjudication are designed to keep agents moving while preserving
   machine-checkable constraints.
4. **Cognitive and runtime economy over exposing the whole implementation to
   the agent.** Phase skills route agents through short command lists, and
   command startup and warm-query latency have received measured optimization.
5. **Broad language and analyzer reach after the conditions above.** Language
   support expands through explicit capability differences rather than one
   uniform claim of semantic strength.

The hierarchy is mostly coherent. The main contradiction is between the first
priority and the public evidence envelope: internal code and validation
preserve distinctions that the outer `graph-fact` label and missing receipt
then erase.

---

## 6. Where scip-query is unusually strong

### 6.1 Capability is part of an answer's meaning

The accuracy program correctly recognizes that an empty result cannot mean
`nothing exists` when indexing, semantic analysis, framework recognition, or
checking was unavailable. It records `certified`, `qualified`,
`insufficient`, `experimental`, and `unsupported` states rather than
manufacturing certainty
([accuracy certificate](../validation/2026-07-11-accuracy-program-closure.md#L12)).

The validation records preserve negative results. TypeScript dead-code
detection reached its stated certification threshold, while Rust remained
insufficient because three valid natural findings could not support the same
statistical conclusion
([before/after evidence](../validation/2026-07-11-accuracy-program-closure.md#L44)).

### 6.2 Facts are distinguished from proposed actions

The project explicitly recognizes that a relationship can be correct while
the refactoring it suggests remains contextual
([folded-back learning](../validation/2026-07-11-accuracy-program-closure.md#L100)).
The direct/signal/support tiers prevent an exact similarity or dependency
relationship from being mistaken for proof that two concepts should be
merged.

### 6.3 The operational substrate is serious

The repository contains substantive defenses around immutable index
generations, stale worktrees, concurrent refresh, crash recovery, process
ownership, bounded subprocesses, pagination, record compatibility, and hook
failure modes.

The live self-audit sampled 50 symbols. Reference results achieved precision
`1.0` and recall `1.0` against the available semantic oracle. Callee evidence
was honestly weak: only two symbols were comparable, recall was `0.5`, one
result was unverified, and 48 were skipped because the oracle was partial.
That disclosure is more informative than a composite accuracy number.

### 6.4 Evidence is inexpensive enough for routine use

Measured warmed medians were approximately 304 ms for `affected`, 374 ms for
`change-surface`, 575 ms for `diff-impact`, and 802 ms for the composite
`plan-context` workflow
([final warmed scoreboard](../benchmarks/2026-07-15-agent-command-latency-ledger.md#L131)).

This supports the operational claim that evidence is cheap to request. It
does not yet establish that agents request the right evidence at the right
time.

---

## 7. Findings

### EPI-01 — Common outputs do not carry the promised observation receipt

**Severity:** High
**Affected mission condition:** evidence must refer to the repository state
the agent is changing.

The July 28 remediation plan required observation receipts in common machine
output and then declared all eight slices complete
([receipt slice](../plans/2026-07-28-agent-design-remediation.md#L369),
[completion record](../plans/2026-07-28-agent-design-remediation.md#L481)).

The receipt implementation exists and can construct index/worktree identities
([receipt construction](../../src/runtime/observation-receipt.ts#L100)). It is
currently consumed by suppression creation, not by the common result
renderer. The stable JSON envelope has no receipt field
([envelope contract](../../src/runtime/cli-json-envelope.ts#L18)), and the
shared renderer does not construct or attach one
([shared renderer](../../src/runtime/command-kit/command-execution.ts#L343)).
Live `stats --json` and `trace --json` probes confirmed the omission.

Two complete outputs can therefore refer to different index generations or
worktree states while an automated consumer has no common-envelope mechanism
for detecting the incompatibility.

The structural cause is a partial migration: authority was added to the
high-risk suppression and Stop paths, but the older shared command transport
remained organized around a timeless result object.

### EPI-02 — `graph-fact` combines distinct evidence origins

**Severity:** High
**Affected mission condition:** an agent must know what produced a claim and
what validation applies to that production path.

The public command vocabulary contains only `graph-fact`, `heuristic`, and
`mixed`. Unless a descriptor is explicitly heuristic or belongs to four
hardcoded mixed commands, it defaults to `graph-fact`
([evidence-tier policy](../../src/runtime/command-kit/command-docs.ts#L30)).

But `trace` and `refs` do not obtain every result through one graph mechanism:

- reference resolution prefers source attribution and falls back to SCIP
  reference chunks
  ([reference policy](../../src/symbols/references/reference-sites.ts#L92));
- `refs` adds Ruby references found with source regular expressions
  ([Ruby fallback](../../src/queries/navigation/refs.ts#L32)); and
- `trace` discards the internally available provenance when constructing its
  public result
  ([trace projection](../../src/queries/navigation/trace.ts#L50)).

A live `trace planContext --json` result was labeled `graph-fact` even though
semantic enrichment was disabled and its reference policy was source-primary.

The defect is not that source evidence must be inaccurate. It is that
`graph-fact` claims to describe derivation while packaging compiler-index
relations, source attribution, semantic providers, and language-specific
textual fallbacks into one concept.

### EPI-03 — The end mission lacks controlled outcome evidence

**Severity:** High, strategic
**Affected mission condition:** the product must improve agent decisions, not
merely produce technically valid observations.

The validation program is strong at proving detector truth rules, query
relationships, failure handling, and performance. It is much weaker at
proving agent outcomes.

The principal repair-outcome study exercised one checker-backed deletion.
Signal and support examples were deliberately not edited, and the report says
that other direct repair families still need outcome validation
([residual risk](../validation/2026-06-21-agent-repair-outcomes-result.md#L101)).
Other validation records classify plausible local repairs without attempting
them in external repositories
([unused-import repair outcome](../validation/2026-06-21-direct-small-analyzer-verdicts-result.md#L41)).

The effectiveness ledger does not fill that gap. It correctly labels itself
`local-writable-telemetry`, reports no precision estimate, and currently
discloses that 479 of 536 events in the queried window lack modern observer
provenance. It can describe operational handling; it cannot independently
prove correctness or causal improvement.

The structural cause is that validation follows implementation boundaries.
Queries, detectors, stores, and gates each have strong local contracts, but
the mission-level unit is an agent completing a repository task. That unit
does not yet have a controlled comparison.

### EPI-04 — The health score measures unresolved detector pressure

**Severity:** Medium
**Affected mission condition:** summaries must preserve what their numbers
actually measure.

The current bounded health run reports:

- score `94`;
- one graph finding;
- 54 heuristic findings; and
- 586 user suppressions.

The score calculation deducts from active analyzer results, while the
suppression inventory is disclosed under evidence quality
([evidence-quality output](../../src/queries/health/health-report.ts#L204),
[score calculation](../../src/queries/health/health-report.ts#L637)).

Because analyzers honor inline suppression decisions, the scalar is best
understood as remaining detector pressure after maintainer adjudication under
the analyses that completed. That is useful, but it is not the same concept as
repository health. Suppressions can encode legitimate domain knowledge,
false-positive accommodations, or detector limitations.

The tool already warns that the score is experimental, capability-dependent,
and unsuitable for public comparison. The remaining problem is the headline
concept, not the absence of caveats.

### EPI-05 — The product boundary is wider than the essential mission

**Severity:** Medium
**Affected mission condition:** the core evidence loop must remain
understandable and maintainable as specialist capabilities grow.

The current public surface contains 93 documented commands and 68
independently published query modules. It includes navigation, cleanup,
history, framework analyzers, health scoring, release/setup infrastructure,
durable watchers, and TLA+ conformance.

The deletion test identifies the essential boundary:

- remove reliable freshness and the mission collapses;
- remove provenance and coverage and justified agent reasoning collapses;
- remove planning and diff gating and the current agent mission collapses;
- remove the health scalar, TLA integration, or many individually published
  detector modules and the core mission survives.

The existing phase skills already reduce cognitive exposure for agents, but
the implementation and public API still carry the whole surface. The likely
cause is cumulative mission expansion: a query CLI became an agent-control
product while retaining every specialist query as part of one undifferentiated
product boundary.

---

## 8. Goal reduction

### 8.1 End condition

The end is:

> On repository-change tasks, coding agents avoid preventable
> whole-repository mistakes and cannot defensibly declare completion unless
> current, scoped repository evidence supports it.

This is a condition rather than the activity `improve scip-query`. It is
checkable through observed agent outcomes and through the authority and scope
of the evidence used to justify completion.

### 8.2 Conditions immediately required by the end

| ID  | Required condition                                                                       | Current state                                    |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------ |
| C1  | Relevant repository evidence is available at planning, editing, and completion decisions | Strong                                           |
| C2  | Every observation is tied to the repository state it describes                           | Partial                                          |
| C3  | Every claim exposes its origin, coverage, validation status, and action strength         | Partial                                          |
| C4  | Facts are converted into edits only when the evidence warrants that action               | Strong in policy; incompletely outcome-validated |
| C5  | Using the system measurably improves agent task outcomes                                 | Unestablished                                    |
| C6  | The essential loop stays cheap, comprehensible, and maintainable as capabilities grow    | Runtime strong; product boundary under pressure  |
| C7  | Public descriptions cause users and agents to expect the product that actually exists    | Partial                                          |

The conditions form this dependency:

```text
Current repository state ──> authoritative observation ──> qualified claim
                                                              │
Repository task goal ──────────────────────────────────────────┤
                                                              v
                                                    warranted agent action
                                                              │
                                                              v
                                               checked completion decision
                                                              │
                                                              v
                                              better repository-task outcome
```

Availability alone cannot produce the end. Authority and qualification must
precede warranted action; warranted action must precede a defensible
completion decision; controlled task evidence must then establish that the
whole chain improves outcomes.

### 8.3 Work classification

The work items are not equally fundamental:

| Class                    | Items                  | Why                                                                                                                  |
| ------------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Mission-critical         | TODO-1, TODO-2, TODO-3 | Without them, the product cannot establish that its evidence is current, correctly interpreted, or outcome-improving |
| Conceptual coherence     | TODO-4, TODO-6         | They keep public measurements and expectations aligned with what the system actually establishes                     |
| Long-term sustainability | TODO-5                 | It protects the mission-critical loop from being obscured by specialist surface growth                               |

---

## 9. Goal-backward TODO register

### Decision prerequisite — Ratify the mission contract

This is a prerequisite rather than a seventh implementation item.

**Goal link:** every later design choice needs one beneficiary and one success
standard.

**Current fact:** the README, package description, and implemented workflow
support the mission stated in section 8.1, but the live CLI still presents the
older query-engine identity.

**Required decision:** maintainers either accept the section 8.1 end condition
as the product mission or revise it before work begins. If the intended end is
only `make code relationships queryable`, TODO-3, TODO-5, and TODO-6 change
substantially.

**Done when:** one current mission statement names the beneficiary, the
repository-scale failure being prevented, and the observable outcome; the
README, product planning, and trial design use that same statement.

**Point of no return:** running outcome trials before agreeing on the outcome
would produce measurements with no stable interpretation.

### TODO-1 — Attach authority receipts to common machine output

**Goal link:** produces C2, which is required before evidence can justify an
action or completion claim.

**Immediate required condition:** a consumer can determine whether two
answers observed the same repository, index generation, and worktree state.

**Present obstacle:** `currentCliObservationReceipt()` can build the required
identity, but `printJsonEnvelope()` and `CliJsonEnvelopeV1` do not carry it.

**Why the proposed action causes the condition:** constructing the receipt at
the shared output boundary makes every descriptor-backed structured result
carry the identity of the database and worktree actually held during that
invocation. Comparison semantics can then reject mixed-generation reasoning
before the result is used.

**Required change:**

1. add an authority/observation field to the versioned common envelope and
   JSON schema;
2. construct the strongest available receipt in the shared command renderer,
   with honest `index-worktree`, `index-only`, `worktree-only`, or
   `process-local` authority;
3. preserve the receipt through output-page snapshots and result decoding;
4. expose comparison semantics that reject complete-set claims assembled from
   incompatible receipts; and
5. retain compatibility for older envelopes whose authority is unknown.

**Done when:**

- every evidence-producing `--json` command emits an authority receipt;
- a test changes index generation or worktree identity and proves that receipt
  comparison rejects combination;
- continuation pages preserve the original receipt rather than recomputing
  one;
- legacy results decode as authority-unknown instead of being treated as
  current; and
- `docs/CLI_JSON_OUTPUT.md`, the JSON schema, fixtures, and public API contract
  describe the same field.

**Rejected substitutes:**

- a timestamp alone does not identify repository state;
- package version alone does not identify the observed generation;
- a freshness check performed before the command does not prove that two
  separately produced answers share an authority;
- adding receipts only to Stop output leaves direct command consumers unable
  to compare results.

**Dependencies:** mission contract only. TODO-3 depends on this item because a
trial cannot reliably attribute an agent decision to current evidence if the
recorded result lacks state identity.

### TODO-2 — Replace coarse evidence tiers with composable claim metadata

**Goal link:** produces C3 and strengthens C4.

**Immediate required condition:** an agent can determine how a claim was
produced, how much of the answer was examined, how strongly that production
path has been validated, and whether the claim itself warrants an edit.

**Present obstacle:** command-level `graph-fact`, `heuristic`, and `mixed`
labels combine origin, confidence, and sometimes action implication. Commands
such as `refs` can return rows produced by different mechanisms while exposing
one top-level label.

**Why the proposed action causes the condition:** preserving independent
dimensions prevents strength in one dimension from being transferred to
another. Complete coverage no longer implies compiler derivation; compiler
derivation no longer implies an automatic repair; an exact source
relationship no longer inherits certification from an unrelated language
path.

**Required change:**

1. represent evidence origin with concrete producers such as `scip-index`,
   `semantic-provider`, `source-attribution`, `textual-fallback`,
   `git-history`, `change-graph`, and `project-checker`;
2. retain coverage as the separate complete/bounded/sampled/unknown contract;
3. attach validation status such as certified, qualified, experimental,
   insufficient, or unsupported to the relevant command/language/evidence
   cell;
4. retain direct/signal/support as the independent action tier;
5. emit row-level origin when one command can mix production paths; and
6. give legacy command-level tiers an explicit compatibility interpretation
   rather than silently treating them as equivalent to the new model.

**Done when:**

- no public row produced by a textual or source fallback is represented only
  as `graph-fact`;
- tests force each fallback and verify the emitted origin;
- coverage, validation status, action tier, and authority remain independent
  fields;
- the validation registry, generated command documentation, runtime output,
  and analyzer inventory cannot drift into contradictory classifications; and
- an agent can state exactly what follows from a row without inspecting its
  producer's source code.

**Rejected substitutes:**

- adding more values to one command-level enum preserves the package-deal;
- renaming `graph-fact` to `evidence` softens wording without restoring lost
  distinctions;
- confidence numbers without a named corpus and truth rule create precision
  theater rather than qualification.

**Dependencies:** mission contract and TODO-1's authority field shape. TODO-3
depends on at least the minimum viable version of this item so trial records
can explain which evidence path influenced each decision. TODO-4 should reuse
this vocabulary instead of inventing a second classification.

### TODO-3 — Establish mission-level agent outcomes

**Goal link:** directly establishes or falsifies C5, the final causal link to
the product mission.

**Immediate required condition:** equivalent repository tasks performed with
and without scip-query yield comparable evidence about mistakes, completion
quality, time, and cost.

**Present obstacle:** existing validation establishes many component claims
but contains one actual checker-backed deletion outcome and no controlled
comparison of agent task performance.

**Why the proposed action causes the condition:** a matched comparison holds
the task, repository revision, agent model, prompt, and evaluation standard
stable while varying access to scip-query. Repeated outcomes can then estimate
whether the tool, rather than repository difficulty or evaluator preference,
accounts for the observed difference.

**Required change:**

1. construct a corpus of repository-scale tasks whose hidden ground truth
   includes consumers, reuse opportunities, migration completion, co-change
   obligations, and legitimate clean cases;
2. run repeated matched trials with equivalent agents using scip-query and a
   defined control condition such as native source search and project checks;
3. keep repository revision, model configuration, task prompt, time/tool
   budget, and stopping rules fixed within each matched group;
4. evaluate outputs independently against predeclared task facts and project
   checks;
5. record capability state, observation receipts, evidence origins, tool
   usage, edits, completion rationale, and final checker/test results; and
6. report uncertainty, failures, and language-specific conditions rather than
   one pooled success score.

**Outcome measures:**

- missed affected consumers;
- unnecessary duplicate concepts introduced;
- incomplete migrations accepted as done;
- regressions or checker failures;
- false findings correctly rejected rather than acted upon;
- task completion quality;
- elapsed time and agent/tool cost; and
- frequency with which current, relevant evidence actually enters the final
  decision.

**Done when:**

- the corpus contains both positive and clean control tasks across the
  capabilities for which a mission claim is desired;
- scoring is reproducible by an evaluator who did not observe the agent run;
- results compare scip-query and control conditions with uncertainty rather
  than isolated anecdotes;
- failure cases are preserved and used to revise the evidence/action contract;
  and
- the public mission claim is narrowed or strengthened to exactly the
  conditions the trial established.

**Rejected substitutes:**

- more query unit tests establish implementation correctness, not agent
  outcome;
- local-writable effectiveness events establish handling history, not
  independent precision or causal benefit;
- one successful repair demonstrates possibility, not comparative effect;
- asking the acting agent whether scip-query helped is testimony, not task
  evidence.

**Dependencies:** TODO-1 and the minimum viable TODO-2 should land first.
Trial design and corpus construction can begin in parallel, but outcome runs
should record the corrected authority and provenance contract.

### TODO-4 — Reframe the health surface around what it measures

**Goal link:** strengthens C3 and C7 by preventing a summary from licensing a
broader conclusion than its inputs support.

**Immediate required condition:** a maintainer can distinguish active detector
pressure, accepted suppressions, unavailable analyses, and measured
repository outcomes.

**Present obstacle:** the scalar called `health` is causally determined by
active analyzer results after suppression and by whichever capability-specific
analyses completed. The caveats are accurate, but the headline concept remains
broader than the measurement.

**Why the proposed action causes the condition:** naming the output after its
actual referents prevents a lower active-finding count from being mistaken for
independent evidence that the repository is healthier.

**Required change:**

1. make detector-family pressure, capability state, and suppression inventory
   the primary output;
2. name the scalar `unresolved structural pressure`, `active analyzer
pressure`, or another term tied to the actual computation;
3. show suppressed and unsuppressed populations by detector family and
   evidence/action class;
4. state whether changes came from code repair, policy adjudication,
   capability changes, or detector-version changes; and
5. retain any scalar only as a versioned local trend, not as a
   cross-repository or cross-language quality measure.

**Done when:**

- a suppression cannot make displayed repository quality appear to improve
  without the output showing that the change was adjudication rather than
  repair;
- unavailable or bounded analyses are visible beside the affected family;
- score/version semantics are stable enough that two local runs are comparable
  under stated conditions;
- documentation no longer needs a warning to reverse the ordinary meaning of
  the headline term; and
- public examples lead with evidence families rather than the scalar.

**Rejected substitutes:**

- retaining the name and adding another warning leaves the conceptual mismatch
  intact;
- subtracting every suppression as debt treats valid domain decisions as code
  defects;
- deleting suppressions from the report hides the detector-context boundary
  that the inventory usefully reveals.

**Dependencies:** use TODO-2's evidence and action vocabulary. This item can
otherwise proceed independently and does not block authority work.

### TODO-5 — Define and enforce a smaller product kernel

**Goal link:** produces C6 by protecting the essential agent-evidence loop from
specialist surface growth.

**Immediate required condition:** maintainers can identify which components
must remain jointly reliable for the mission and which are optional
applications of that kernel.

**Present obstacle:** 93 documented commands, 68 published query modules,
specialist analyzers, TLA+ tooling, setup, release, watcher, and health
infrastructure share one product surface even though removing many of them
would not remove the central agent mission.

**Why the proposed action causes the condition:** a named kernel gives
authority, provenance, freshness, planning, and completion contracts one
owner. Specialist detectors can grow without redefining the concepts every
consumer depends on.

**Proposed kernel responsibilities:**

- repository and generation identity;
- capability and freshness state;
- program-entity resolution;
- reference/dependency/history evidence products;
- coverage and claim metadata;
- planning and reuse context;
- diff-scoped verification;
- observation receipts and output compatibility; and
- phase routing for agents.

**Proposed extension responsibilities:**

- individual cleanup and framework detectors;
- composite health/pressure presentation;
- TLA+ conformance;
- optional repair automation;
- release/platform-specific tooling; and
- language-specific enrichments behind the common evidence contract.

**Required change:**

1. write a kernel contract that names its inputs, outputs, invariants, and
   extension points;
2. classify every public command and query export as kernel, extension,
   operational support, or compatibility surface;
3. identify which accidental public internals can be deprecated, generated, or
   grouped without breaking legitimate consumers;
4. require extensions to emit the common authority, provenance, coverage, and
   action contracts; and
5. make the phase skills and primary documentation teach the kernel workflow
   before the specialist catalogue.

**Done when:**

- the core agent workflow can be described and tested without enumerating
  every detector;
- adding one analyzer does not require new ad hoc evidence, authority, or
  coverage concepts;
- public exports have an explicit stability owner and reason to exist;
- architecture checks prevent extensions from bypassing the common evidence
  contract; and
- specialist surface growth does not increase the number of concepts an agent
  must understand to orient, plan, and verify a normal task.

**Rejected substitutes:**

- moving files without naming the contract changes shape but not concept
  count;
- hiding commands from help while retaining accidental public APIs reduces
  visibility without reducing maintenance obligations;
- splitting everything into packages before establishing the boundary turns
  uncertainty into distribution overhead.

**Dependencies:** mission contract first. It can proceed alongside TODO-1 and
TODO-2, but its extension contract should adopt their resulting vocabulary.

### TODO-6 — Align the public identity with the actual mission

**Goal link:** produces C7 and supports C1 by causing users and agents to
install, configure, and invoke the product for the behavior it actually
provides.

**Immediate required condition:** README, package metadata, CLI help, setup
guidance, and generated command documentation describe one product with
language-qualified capabilities.

**Present obstacle:** README and package metadata describe an agent evidence
and verification system, while the CLI still identifies the product as a
language-agnostic SCIP query tool.

**Why the proposed action causes the condition:** consistent identity guides
users toward the evidence loop and away from the false expectation that every
language receives equivalent semantic or detector strength merely because it
has a SCIP index.

**Required change:**

1. replace the stale CLI description with the ratified mission;
2. retain a concise statement that SCIP indexing is one observation source,
   not the whole product;
3. present language support through the capability matrix rather than one
   language-agnostic strength claim;
4. align setup and quick-start examples with orient, plan, reuse, and verify
   outcomes; and
5. retain direct query documentation for humans and scripts without making it
   the product definition.

**Done when:**

- the README, package description, CLI help, setup flow, and generated docs
  agree on the beneficiary and end;
- language claims distinguish indexing availability from semantic,
  source-fallback, detector, and checker capability;
- `doc-drift` and identity-contract tests find no stale product description;
  and
- a new user can state the product's purpose without reducing it either to an
  IDE-free query CLI or to an infallible repository oracle.

**Rejected substitutes:**

- marketing-only wording without capability qualifications would overcorrect
  the stale engine identity;
- deleting the query-engine description entirely would hide the indispensable
  mechanism;
- calling the system an oracle would contradict its bounded, qualified, and
  heuristic evidence paths.

**Dependencies:** ratified mission and the initial kernel classification. This
is low implementation risk but should follow those decisions so wording does
not churn.

---

## 10. Dependency order

The backward chain produces this execution order:

1. **Ratify the mission contract.** It fixes what counts as success for every
   later item.
2. **TODO-1: common authority receipts.** No downstream evidence or trial
   record is trustworthy across state changes without it.
3. **TODO-2: composable claim metadata.** Trials and health presentation need
   stable meanings for origin, coverage, validation, and action.
4. **TODO-5: kernel boundary.** This can begin alongside TODO-1 and TODO-2,
   but should finish after their shared contract is known.
5. **TODO-3: outcome trials.** Corpus and protocol design may start earlier;
   measured runs should use the corrected evidence contract.
6. **TODO-4: health reframing.** It should reuse TODO-2's vocabulary and the
   outcome distinctions learned from TODO-3, although the obvious naming and
   presentation corrections need not wait for the full trial.
7. **TODO-6: public identity alignment.** Final wording should describe the
   ratified mission and kernel, then be narrowed or strengthened by the
   outcome evidence.

The order is based on fundamentality rather than ease. Authority and claim
meaning make trustworthy evaluation possible; evaluation determines which
mission claim is warranted; the public identity should state the result of
that work rather than precede it.

---

## 11. Program completion condition

The program is complete when:

1. every evidence-producing machine result identifies the repository state it
   observed;
2. every claim preserves origin, coverage, validation status, and action
   strength without collapsing them into one label;
3. matched agent trials establish where scip-query improves outcomes and where
   it does not;
4. health output names the detector pressure it actually measures;
5. the product kernel and specialist extensions have an enforced contract;
   and
6. public identity claims exactly the beneficiary, mechanism, and outcome the
   evidence supports.

At that point scip-query would be more than a sophisticated code-intelligence
CLI. It would be a defensible repository reasoning system: a system whose
claims remain tied to their referents, whose limits survive transport, and
whose value to coding agents has been observed rather than inferred only from
its mechanism.
