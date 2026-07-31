# scip-query epistemic redesign — session notes

Date opened: 2026-07-30
Updated: 2026-07-31
Status: live
Parent review: [Epistemic review](./2026-07-30-epistemic-review.md)

## The problem

Agents can make locally correct changes while leaving obsolete or ambiguous
artifacts that mislead future work. Teams then cannot reliably tell whether a
repository change is actually complete, and future agents can restore behavior
that was intentionally replaced.

## Where we are

All six implementation phases now exist in the product, but mission
effectiveness remains unproven. A first large-repository Vega comparison did
not establish a benefit: its raw workflow condition cost more, both conditions
missed the same real cleanup, and treatment execution was invalidated by a
Stop-hook snapshot failure. The immediate work is to repair those product and
apparatus failures, reduce repeated verification work, and rerun one
already-configured behavior-judged pair before making an effectiveness claim.

## Latest large-repository evidence

- Repository setup is not part of the intended comparison. The treatment's
  26-second activation occurred before counted agent execution and contributed
  zero model tokens, but preparing a neutral fixture still modeled adoption
  rather than normal use and created avoidable apparatus work. The replacement
  fixture must already be configured, indexed, dependency-ready, and pass a
  readiness check before either timer starts.
- The first panel-resize control completed in 1,076,204 ms with 11,813,721
  counted tokens; the treatment completed in 1,334,368 ms with 17,418,595
  counted tokens. Most counted tokens were cached. These raw values show cost,
  not a valid causal result, because the treatment did not receive the intended
  enforced Stop lifecycle and the hidden evaluator required one exact API and
  file location rather than the authorized behavior.
- Both agents produced broadly equivalent shared-resize implementations and
  both missed duplicate seam borders in three chat surfaces. scip-query's diff
  gate passed, so this trial supplies a real completeness false negative rather
  than evidence of treatment advantage.
- The treatment Stop hook found that configured TypeScript workspace
  directories were being captured as files, then returned advisory feedback
  and allowed the agent to exit. The product repair treats existing configured
  directories as project roots and makes host-authorized protected work block
  by default when Stop cannot certify completion. Ordinary non-protected work
  remains advisory unless explicitly configured otherwise.
- The next pair must clone both conditions from one preconfigured golden
  repository, disable scip-query only in the control, reject either condition
  before model execution when dependencies or lifecycle preflight fail, judge
  behavior independently of implementation shape, and derive treatment
  completion from durable controller records rather than final prose.

## Settled

- Phase 1, the problem, is closed — because the failure is stated in two
  solution-free sentences and matches the repository-residue cases that
  motivated the review.
- Phase 2, the end, is closed — because completion has a yes-or-no condition:
  the target repository fully embodies the stated goal, every affected artifact
  is reconciled, and every surviving alternative has an evidenced current role.
- scip-query is an evidence tool, an agent-reasoning system, and a
  completion-control system — because reasoning and completion depend on
  repository evidence, while evidence alone does not prevent incomplete
  changes.
- The intended operator is an autonomous coding agent carrying a large,
  long-running body of repository work from goal through verified completion
  without routine human review or approval — because scip-query is meant to
  keep the agent oriented, stateful, and independently checked rather than act
  as a dashboard for a person supervising every step.
- Human authority is supplied before or outside the execution loop through the
  authorized goal, repository policy, and delegated decision rules; inside
  that boundary the agent observes, plans, acts, verifies effects, records
  state, and replans autonomously — because removing approval prompts must not
  be confused with letting the agent rewrite the standard that judges it.
- The first implementation slice adds the existing version-1 observation
  receipt to database-backed JSON output automatically, preserves it through
  pagination, and keeps tool-only and `--result-only` output outside that
  authority claim — because provenance should be an effect of doing useful
  work, not an extra agent ritual.
- The first slice's exact local median is 243.3 ms versus a 244.0 ms committed
  baseline, with zero added commands. An intermediate worktree-hashing version
  was rejected after measuring 291–375 ms and implying observation of state
  the index-backed query had not read — because useful evidence must be both
  honest and efficient, not merely present.
- A repository change is complete only when the repository fully embodies the
  goal and reconciles every affected artifact — because local correctness can
  coexist with obsolete behavior and misleading intent.
- Authoritative results use one self-contained evidence context with a compact
  observation receipt and a separate analysis manifest — because state
  compatibility and analysis limits answer different questions but must travel
  together.
- Observation receipts use both a conservative repository-wide content
  identity and a claim-specific relevant-input identity — because whole-state
  equality supplies a safe default while certified narrower equality permits
  evidence reuse after unrelated edits without pretending the whole
  repository is unchanged.
- Repository-wide content identity covers tracked files, untracked non-ignored
  files, and explicitly declared ignored or generated repository inputs;
  external dependencies and toolchains remain analysis conditions — because
  the receipt must include repository state that can change a result without
  absorbing caches, secrets, and machine state into project content.
- Completion-authoritative commands analyze fixed repository inputs that
  cannot change during the observation; before-and-after comparison remains a
  lower-authority fallback, and scip-query does not globally lock the
  workspace — because endpoint equality cannot prove that a command observed
  one stable state, while a global lock would obstruct normal development and
  still fail to control every reader and writer.
- Receipt version 2 represents observed sources, stability proof, and state
  authority independently; coverage, producer validation, and permitted action
  remain separate claim qualifications — because the presence of an index or
  worktree cannot establish how stable or complete an observation was or what
  policy may do with its result.
- Evidence producers record checkable facts rather than authority labels;
  versioned scip-query product policy derives state authority, and repository
  policy separately selects permitted actions — because a producer cannot
  certify itself, consumers must not invent conflicting interpretations, and
  product evidence meanings must remain distinct from repository governance.
- Receipts remain immutable factual records; authority is recomputed whenever
  evidence is used against a target state, while consequential prior judgments
  are retained as separate versioned evaluation records — because target
  changes can make an old judgment inapplicable without changing what the
  original observation established.
- Receipt comparison returns independent named relationship judgments as
  established, disproven, or unknown with reasons; it does not compress them
  into one boolean or strength score — because collaboration, workspace,
  content, input, generation, and stability matches are different facts that
  different claims require.
- Unknown relationships remain distinct from disproven ones but cannot satisfy
  a required completion condition; they may orient advisory work only with
  explicit disclosure — because absent proof neither establishes
  incompatibility nor warrants a completion claim.
- Index alignment is established only when an immutable generation's stored
  versioned index-input identity exactly equals the identity computed from the
  fixed repository snapshot under the same projection — because timestamps,
  commits, and local generation names can all match while dirty, untracked, or
  configured index inputs differ.
- Evidence context follows the meaning of an output rather than its command
  subsystem: every repository-state assertion requires it, pure tool
  information does not, and a mutation records consumed evidence separately
  from its resulting state — because neither uniform decoration nor an
  index-only rule preserves honest provenance.
- Command descriptors declare operation-specific result roles selected from
  parsed arguments before execution, and the envelope names the selected role
  — because one public command may observe, preview, mutate, or combine those
  behaviors without every mode sharing one evidence contract.
- Ordinary human output shows a compact evidence summary for every repository
  observation, promotes unknown, stale, or incompatible conditions to visible
  warnings, and leaves full identities and reasons to structured or explicitly
  expanded output — because both hidden authority and always-expanded receipts
  make results harder to interpret correctly.
- Repository lineage, workspace instance, content state, and collaboration
  domain remain distinct — because shared ancestry, identical files, and shared
  decision authority do not imply one another.
- Merge-intended branches, clones, worktrees, and contributor forks share one
  committed collaboration-domain identity; independent derivatives detach —
  because durable project decisions must merge without leaking into separately
  governed projects.
- Record persistence scope, knowledge role, and lifecycle remain independent —
  because retaining a record as history does not mean it may alter a current
  gate.
- Shared type contracts define fixed scope, role, and lifecycle meanings, while
  records serialize only values that can genuinely vary — because this keeps
  one vocabulary without creating repetitive or stale instance fields.
- One intended code change is a first-class persistence scope between a
  workspace and collaboration history — because its plans and temporary
  decisions must survive Git movement without becoming permanent policy.
- Each intended change receives one generated opaque identity — because it
  must survive rebases, branch renames, worktrees, and contributor forks
  without depending on a hosting provider.
- Closing a merged change explicitly classifies every active record as
  fulfilled, carried forward, or historical-only — because merging code neither
  finishes every obligation nor turns temporary work into permanent policy.
- A record is fulfilled only when current target-state evidence meets its
  type-specific satisfaction contract — because the working agent's bare status
  assertion cannot prove that an obligation's condition changed.
- Cross-change carry-forward is limited to unresolved repository consequences
  that matter to the larger goal's completeness — because tracking all TODOs
  would turn scip-query into a project manager, while tracking none would lose
  partial-migration residue.
- Carry-forward requires a linked, active destination record that preserves the
  original requirement and evidence before the source becomes inactive —
  because an unfinished obligation must never lack a current owner.
- Historical-only is an inactive retention state reached after substantive
  disposition, not a reason for closing an obligation — because archiving a
  record does not establish that its unresolved consequence disappeared.
- Invalidation requires either current evidence defeating the obligation's
  factual premise or an authorized revision to its governing goal — because
  missing or stale evidence establishes uncertainty, not irrelevance.
- Persistence has four scopes—invocation, local, change, and collaboration
  history — because these correspond to the command desk, local toolbox,
  traveling change folder, and shared project archive without confusing
  retention with evidence applicability.
- Observation and claim are distinct record roles — because reporting what was
  measured and concluding what it establishes carry different evidence and
  authority responsibilities.
- Completion obligation is distinct from its source claim and requires explicit
  policy-governed promotion — because a warranted conclusion does not by itself
  acquire authority to block goal closure.
- Decision is distinct from the claim or obligation whose treatment it governs
  — because choosing a disposition must not rewrite observations, claims, or
  the fact that an obligation once existed.
- Goal is a distinct versioned record role referenced by obligations and
  completion claims — because the intended destination must not be inferred
  from current code or replaced by a checkpoint's smaller result.
- The canonical goal is an independent structured record that plans reference
  by stable identity and version — because a route can be replaced without
  changing its destination.
- Goal-aware skills must create or reuse the goal before planning, preserve its
  exact reference while editing, and verify against the same version afterward
  — because the goal contract fails if it exists only in storage and not in the
  agent workflow.
- A model-written goal is active only when it faithfully records explicit
  authorized intent; an inferred or reconstructed goal remains proposed until
  an authorized owner accepts it — because writing a destination does not grant
  the power to choose that destination.
- Authorized instructions combine according to their scope and revision
  authority rather than a fixed source ranking — because repository policy,
  current requests, and accepted work items govern different parts of the same
  change and none should be silently discarded.
- Evidence-established necessities may be incorporated under the current goal,
  while changes to intended behavior, beneficiaries, compatibility, scope, or
  tradeoffs require authorized revision — because completeness must expose the
  full cost of the destination without becoming permission to choose another
  destination.
- Goal text remains a concise statement of the destination rather than an
  implementation specification — because a goal that duplicates the plan or
  code costs more to maintain than the distinction is worth.
- The concise Gherkin `Feature` line is the canonical goal, while
  `Given`/`When`/`Then` scenarios are optional supporting examples — because
  scenarios add behavioral precision without making every goal a test
  specification.
- Every Gherkin scenario attached to the canonical goal is required but
  non-exhaustive — because each listed case must hold while the broader goal
  continues to govern unlisted cases.
- Authorized behavior and compatibility requirements bound acceptable
  outcomes; coherence and clarity govern completion within those bounds; speed
  is optimized afterward — because process cost cannot redefine a satisfactory
  repository state.
- A pre-existing problem enters the current change only when the change makes
  it inconsistent or it prevents the authorized goal — because discovery,
  proximity, and age do not create causal responsibility.
- Completion follows every necessary consequence of the authorized goal while
  reporting repository readiness separately from required external state —
  because local evidence can establish “prepared” without establishing
  “delivered.”
- A retained compatibility path is current only when its protected contract,
  authorized purpose, connection to current behavior, and revalidation
  condition are evidenced — because mere continued execution does not
  distinguish support from residue.
- Multiple implementations are legitimate variants only when their selection
  boundary, shared contract, current evidence, and authority overlap are
  explicit — because working implementations can still contradict one another
  about which design is current.
- Necessary deferred work permits checkpoint completion only while its larger
  goal and active obligation remain preserved — because a safe intermediate
  state is not the same condition as reaching the destination.
- A necessary obligation leaves the current completion boundary only through
  factual invalidation, authorized goal revision, or checkpoint carry-forward
  — because an “out of scope” label changes neither evidence nor intent.
- Origin, coverage, validation status, state authority, and action tier remain
  independent claim qualifications — because strength in one respect cannot
  establish strength in another.
- A completion obligation remains active until fulfilled, invalidated, or
  atomically carried into an active successor — because suppression, deferral,
  and archival do not substantively reconcile the consequence.
- The stable product core owns the shared identity, evidence, goal,
  obligation, planning, verification, and compatibility contracts, while
  specialist capabilities extend those contracts without redefining them —
  because normal workflows must not depend on the full specialist catalogue.
- New contracts migrate through explicit versions and additive readers, while
  new checks begin advisory and earn blocking authority through validation,
  policy, and a tested demotion path — because deployment cannot manufacture
  semantic compatibility or enforcement authority.
- The mission-level hypothesis compares otherwise identical agents on
  supported non-trivial changes and predicts fewer missed artifacts, residue,
  and behavior reintroductions without unacceptable regressions, false
  blocking, or review cost — because the product's intended causal effect must
  be testable before it is asserted.
- Repository-declared architecture conformance is part of the intended product,
  not merely a specialist report — because a repository cannot remain a
  coherent source of intent when changes may silently violate structural rules
  its owners have chosen to preserve. The current feature combines descriptive
  structure mapping with an opt-in baseline ratchet; “strict” applies to active
  rules, not to report-only signals or unconfigured repositories.
- An agent action is mandatory only when it changes the target state, supplies
  information capable of changing the next decision, preserves work state that
  would otherwise be lost, verifies an effect, or records a still-live
  obligation — because steps that do none of these things consume time and
  tokens without advancing the goal.
- Required evidence and bookkeeping are produced at shared execution
  boundaries, cached by compatible state identity, and triggered by uncertainty
  or changed effects rather than repeated as fixed rituals — because the tool
  should remove re-discovery and rework instead of replacing them with forms.
- Verification gives each claim one cheapest discriminating proof and each
  final gate one execution owner; standalone detectors run only for uncovered
  risks or reported findings, and repeated checks require changed evidence —
  because duplicating direct tests, a detector battery, and an ambient Stop
  gate burns resources without increasing completion coverage.
- Efficiency is measured to verified completion, including failed attempts and
  rework, rather than per command — because a cheap narrow run that leaves
  residue is not efficient and an expensive check that prevents a larger retry
  may be.
- The scip-query workflow must not be dominated on both elapsed time and model
  tokens by the same agent without scip-query once completion quality is held
  constant; it must improve at least one efficiency axis without an
  unacceptable regression in the other — because correctness is the threshold
  and the tool still has to make autonomous work economically better.
- Editable tests, fixtures, baselines, configuration, suppressions, and
  documentation may support completion but cannot alone certify the same
  change that edited them — because otherwise the working agent can make its
  own grade easier instead of making the repository correct.
- A protected standard is an immutable authorized version of the goal,
  repository invariants, policy, and transition rules for one run. The agent
  may author successor versions when authorized, but the successor governs the
  same run only when a previously protected rule independently validates that
  transition — because autonomy requires legitimate evolution without
  self-promotion.
- scip-query product maintainers own released evidence meanings and producer
  certification; repository and task authority own the active goal and local
  policy; the agent owns implementation and disposition choices delegated by
  those inputs — because separating these powers removes runtime approval
  without letting execution manufacture authority.

## Vocabulary

- **Repository residue** — an artifact left after its original role was
  superseded that still looks intentional enough to guide future work. Covers
  obsolete but live code, configuration, tests, documentation, exports, and
  concepts. Does not cover an evidenced compatibility path or intentional
  current variant.
- **Autonomous repository agent** — a software agent that carries an
  authorized repository goal through observation, planning, mutation,
  verification, correction, and closure using persistent work state. It does
  not depend on routine human approvals, and it does not acquire authority to
  alter its goal or grading standard merely by operating without supervision.
- **Autonomy envelope** — the pre-authorized goal, repository policies,
  available actions, tradeoff rules, and protected constraints within which an
  agent may make binding implementation decisions without asking a person. It
  enables independent execution; it does not authorize changing its own
  boundary.
- **Protected evaluation standard** — the goal, invariants, policies, and
  independently evaluated effects that determine whether autonomous work
  succeeded while remaining outside the agent's ability to weaken them for the
  same change. It may permit authorized test or policy evolution; it does not
  let an agent count its own convenient rewrite as proof of success.
- **Persistent work state** — the durable record of the current goal, plan,
  observations, attempts, effects, decisions, obligations, and next action
  carried across turns and context loss. It lets the agent distinguish a new
  situation from a repeated failed attempt; it does not substitute remembered
  claims for fresh repository observations.
- **Ceremonial agent action** — a required workflow step whose result neither
  changes repository state, changes a supported next decision, preserves
  otherwise-lost work state, verifies an effect, nor records a live
  obligation. It covers repeated status prose, duplicate checks, and manual
  metadata entry that the tool can derive. It does not cover a cheap
  information-gathering action that materially lowers expected rework.
- **Efficiency to verified completion** — the elapsed time and model tokens
  consumed from an authorized goal until the repository satisfies its
  protected completion conditions, including retries and corrective work. It
  does not treat a fast incomplete attempt as efficient.
- **Repository-change completeness** — the condition in which the repository
  fully embodies a change goal and every affected artifact has a coherent
  current role. Covers goal satisfaction, integration, supersession, and
  explanatory consistency. Does not mean merely compiling, passing tests, or
  editing every possible file.
- **Collaboration domain** — the branches, clones, worktrees, and contributor
  forks whose code and durable decisions are intended to merge into one shared
  project history. Does not cover a derivative whose future decisions are
  independently governed.
- **Observation receipt** — a compact record identifying the repository state
  an observation describes and the authority it can carry. It does not describe
  how broad or reliable the analysis itself was.
- **Repository-wide content identity** — a versioned fingerprint of the
  canonical repository-owned content conservatively treated as capable of
  affecting authoritative results. It permits a safe same-content comparison;
  it does not represent Git history, external dependencies, toolchains, or the
  identity of a particular workspace.
- **Relevant-input identity** — a versioned fingerprint of the exact
  repository-owned input projection a certified producer used for one kind of
  claim. It permits that claim's evidence to survive unrelated repository
  changes; it does not prove whole-repository equality or cover undeclared
  inputs.
- **Declared repository input** — an ignored or generated file inside the
  repository that repository policy or a certified producer identifies as
  capable of changing an authoritative result. It joins the content identity
  despite default ignore rules; it does not turn installed dependencies,
  caches, secrets, or arbitrary machine files into repository-owned content.
- **Fixed observation snapshot** — a readable representation of a command's
  repository inputs whose bytes cannot change during that command's analysis.
  It establishes one stable observed content state; it does not establish that
  the selected inputs were complete or that external analysis conditions were
  stable.
- **Bracketed observation** — a live-workspace analysis surrounded by
  before-and-after content comparisons. It detects a state that remains
  changed at the end; it does not rule out a temporary change and restoration
  during the command.
- **State authority** — the relationship binding evidence to the exact
  repository state or states it may describe. It establishes where the
  evidence applies; it does not establish analysis breadth, producer
  validation, claim truth, or permission to block an action.
- **Authority derivation** — a versioned evaluation that applies shared
  scip-query policy to recorded evidence facts and a target-state comparison.
  It determines what state relationship those facts establish; it does not let
  the evidence producer certify itself or decide which repository actions are
  permitted.
- **Authority evaluation record** — a historical record of one consequential
  authority judgment, naming the source evidence, target state, derivation
  policy, time, and result. It explains why an earlier action was warranted; it
  does not remain automatically current after the target changes.
- **Compatibility relationship** — one named comparison between observations,
  such as same whole content or same index inputs, whose result is established,
  disproven, or unknown with reasons. It answers only that stated sameness
  question; it does not imply other relationships or a permitted action.
- **Fail-closed completion rule** — a decision rule that withholds a successful
  completion judgment when any required relationship remains unknown or
  disproven. It does not claim that missing evidence proves a defect; it keeps
  uncertainty from being converted into success.
- **Index alignment** — the established relationship between one immutable
  index generation and the fixed repository snapshot whose index-relevant
  inputs have the same canonical identity under the same projection version.
  It proves which inputs the index represents; it does not prove whole-content
  equality, complete analysis coverage, or current target applicability.
- **Repository observation command** — a command operation whose result states
  a fact or claim about repository content, history, configuration, records, or
  derived index state. Its result requires an evidence context; it does not
  include pure tool help or an operation outcome merely reporting that a write
  occurred.
- **Repository mutation command** — a command operation that changes
  repository-owned content, a derived index, or project-local control state.
  It records the evidence and preconditions authorizing the operation plus the
  resulting state; the write itself is not evidence that its intended
  postcondition holds.
- **Operation-specific result role** — the observation, preview, mutation, or
  composite meaning selected for one concrete command invocation after its
  arguments are parsed. It determines the evidence and state-transition
  records that invocation owes; it does not require splitting every mode into
  a separate public command.
- **Human evidence summary** — a compact rendering of the observed-state
  status, stability, index alignment, and coverage attached to an ordinary
  repository result. It makes limitations visible without printing complete
  receipt identities or replacing the machine-readable evidence context.
- **Analysis manifest** — the record of how an observation was produced and
  which conclusions its coverage and capabilities permit. It does not establish
  that the observed repository state is still current.
- **Intended code change** — the goal-directed body of work that may cross
  branches, worktrees, rebases, and contributor forks before it merges, splits,
  or is abandoned. It does not cover unrelated work sharing a branch or durable
  policy governing future changes.
- **Change identity** — a generated opaque token that lets every record
  belonging to one intended change continue to name that change across Git
  movement. It does not derive meaning from a branch, commit, issue, or pull
  request.
- **Change closure** — the reconciliation that accounts for every active record
  when an intended change ends. It does not treat merging code as proof that
  every obligation was fulfilled.
- **Completion obligation** — a current unresolved consequence of a repository
  change that must receive a justified disposition before the relevant goal can
  close. It does not cover optional ideas, general TODOs, or unrelated future
  work.
- **Persistence scope** — the future work contexts in which a record continues
  to exist: one invocation, local tool state, one intended change, or
  collaboration history. It does not determine which repository state the
  record describes or whether it currently has authority.
- **Observation** — a record of a measured repository state or event tied to
  stated conditions and limits. It does not assert what action or larger
  conclusion follows.
- **Claim** — a conclusion-bearing statement whose truth depends on identified
  observations and reasoning. It does not become a required action merely by
  being stated.
- **Decision** — an authorized selection of how an existing claim or obligation
  will be treated. It does not alter the underlying observation, claim, or
  historical existence of the obligation.
- **Goal** — the authorized future repository condition that work is intended
  to make true. It does not claim the condition already holds or prescribe
  every implementation step.
- **Architecture contract** — a repository-owned structural policy that maps
  files into named responsibility groups and declares which dependency
  relationships, cycles, policy gaps, size limits, and test reaches the project
  will permit. It turns observed imports and re-exports into project-specific
  judgments without claiming that one structure fits every repository.
- **Architecture ratchet** — a comparison between current architecture
  violation identities and a committed set of previously reviewed identities.
  It permits known structural debt to remain visible while rejecting new
  violation identities; it does not establish that the repository has zero
  architecture debt.

## Open

- [x] Define the autonomy envelope that lets an agent resolve ordinary design,
      remediation, suppression, and sequencing choices without runtime human
      approval while preventing it from changing its own goal or grading
      standard. — settled at the program level; exact schemas are slice-local.
- [x] Define which evaluation artifacts remain protected from the working
      agent and how authorized changes to tests, policy, baselines, goals, or
      suppressions are independently checked. — settled through immutable
      governing versions and independently validated transitions.
- [x] Define the architecture-enforcement contract and extend the
      mission-level hypothesis to cover violations of repository-declared
      structural rules. — settled as repository-declared core completion
      behavior with ratcheted enforcement.
- [x] Reconcile the proposed identity, evidence, record, planning, completion,
      and effectiveness contracts with the existing implementations before
      assigning production slices. — blocks parallel schemas and accidental
      replacement of working foundations. — existing foundations and migration
      constraints are mapped; each slice must refresh its local impact.
- [x] Assign authority for shared product meanings and certification separately
      from authority for repository goals, local policy, and durable
      dispositions. — settled through product, repository/task, and delegated
      agent authority.
- [x] Define the exact scope, role, and lifecycle values and their allowed
      transitions. — blocks record validation and target-branch revalidation.
      — program meanings settled; record-specific encodings are slice-local.
- [x] Define how merged records become active, inactive, historical, or
      escalated against the target state. — blocks collaborative gate behavior.
      — substantive closure and target-state revalidation rules are settled;
      storage mechanics are slice-local.
- [ ] Derive repository lineage without treating a remote URL as proof of
      identity. — blocks cross-clone evidence attribution.
- [ ] Specify canonical content encoding, certified relevant-input
      projections, fixed-snapshot mechanics, index alignment, and named receipt
      comparisons. — blocks authoritative observation receipts.

## Next step

Implement honest operation roles and receipt version 2. Settle the exact
schema, comparison, migration, and role-registry choices at that slice boundary
from the already agreed facts; do not resume program-wide question-by-question
design unless implementation evidence contradicts a settled premise.

## Set aside

- Final public mission wording remains deferred until outcome trials establish
  which product claims are warranted.
- Field names and encodings that no active implementation slice consumes
  remain deferred until that slice can test them against real producers and
  consumers.

## Detailed decision record

These notes preserve the collaborative reasoning that follows the formal
review. They are organized by the fundamental decision being made rather than
by conversation date. A decision remains provisional until its consequences
have been checked against every affected TODO. New discussion should extend or
qualify an existing category before creating another.

Each decision records:

- the referents and distinction being clarified;
- the current conclusion;
- why the conclusion follows;
- consequences for the work register; and
- the next unresolved question.

### Standing discussion format

The session follows the updated five-phase design arc. A phase opens with a
plain statement of what it is establishing and what that unblocks. It closes as
soon as its observable done-condition holds.

Phase 1, the problem, and Phase 2, the end, are closed. Phase 3, the backward
chain, is active. Each turn establishes one condition required immediately
before a condition already in the chain:

1. state the condition and what it unblocks;
2. give one concrete mental model;
3. state the recommendation when one exists; and
4. ask one question.

User-facing text remains at or below 120 words unless one idea is genuinely
indivisible or the user explicitly asks for depth. The clarification register
below remains an inventory, not a plan: entries phrased as `define`, `decide`,
or another topic must be converted into observable conditions before entering
the chain.

### Current backward chain

1. **End:** the target repository fully embodies the stated change goal, every
   affected artifact is reconciled, and every surviving alternative has an
   evidenced current role.
2. **Immediately required:** the completion claim names the exact target state
   and is supported by evidence with sufficient authority and analysis
   coverage.
3. **Immediately required:** no consequence of the goal remains both current
   and without a justified disposition.
4. **Immediately required:** every completion obligation is fulfilled,
   invalidated, or carried forward through evidence-governed rules.
5. **Immediately required:** obligation records preserve their identity,
   meaning, and active owner across workspaces, branches, merges, and tool
   sessions.
6. **Current branch:** every consequential record has a defined persistence
   scope, knowledge role, and lifecycle contract.
7. **Established leaf:** the complete persistence-scope set is invocation,
   local, change, or collaboration history.
8. **Established leaf:** records that report observations remain distinct from
   records that state conclusions drawn from those observations.
9. **Established leaf:** a claim becomes a completion obligation only through
   an explicit promotion rule that identifies why it must block goal closure.
10. **Established leaf:** a decision changes how a claim or obligation is
    treated without changing what was observed or originally claimed.
11. **Established leaf:** the goal being protected is an explicit record rather
    than an intention inferred from the current code or implementation plan.
12. **Established leaf:** the goal remains canonical outside any replaceable
    plan, while plans reference its stable identity and version.
13. **Established leaf:** a model-written goal becomes active only through
    authority that already exists outside the act of writing the record.
14. **Established leaf:** when authorized instructions disagree, their
    relationship produces one unambiguous governing goal or an explicit
    unresolved conflict.
15. **Established leaf:** evidence discovered during work may make an existing
    goal's necessary consequences explicit without silently changing its
    authorized destination.
16. **Established leaf:** an active goal states the minimum destination
    boundary needed to classify newly discovered work without duplicating the
    plan or implementation.
17. **Established leaf:** every Gherkin scenario attached to a goal has one
    unambiguous effect on what completion must establish.
18. **Established leaf:** when legitimate beneficiary interests conflict, one
    explicit priority rule determines which completion policy governs.
19. **Established leaf:** a pre-existing repository problem becomes part of
    the current change only through an evidenced relationship to its goal or
    effects.
20. **Established leaf:** every required consequence is represented in the
    completion judgment even when its state lies outside the repository.
21. **Established leaf:** a surviving compatibility path has enough evidence
    of its current purpose to remain without creating ambiguous repository
    intent.
22. **Established leaf:** multiple implementations survive only when their
    distinct operating conditions and common responsibility are explicit.
23. **Established leaf:** intentionally postponed work cannot disappear from
    the larger goal merely because the current repository state is safe.
24. **Established leaf:** every removal of a necessary obligation from the
    current completion boundary has an explicit truth-preserving cause.
25. **Established leaf:** every claim preserves the independent facts needed to
    judge how it was produced, how broadly it applies, and what may follow.
26. **Established leaf:** every active completion obligation remains
    continuously accounted for until one of a closed set of substantive exits
    occurs.
27. **Established leaf:** every shared contract needed by a normal
    evidence-to-completion workflow has one stable owner that extensions cannot
    bypass.
28. **Established leaf:** new contracts preserve old meanings during
    migration, and new checks gain blocking authority only through explicit
    evidence and policy.
29. **Established leaf:** the product's intended effect is stated as one
    falsifiable comparison between agents using and not using its complete
    workflow.
30. **Current branch:** the completion workflow also enforces explicit
    repository-owned constraints on dependency direction and structural
    boundaries.
31. **Pending branch:** every normative decision is attributable to a role that
    already has authority over the thing being decided.

---

## 1. Product identity and mission

### Decision

scip-query has three cumulative identities:

1. a repository-evidence tool that makes program and repository relationships
   knowable;
2. an agent-reasoning system that uses those observations to improve planning,
   editing, and verification; and
3. a completion-control system that prevents an agent from treating narrow
   local success as proof that a whole repository change is done.

The identities are dependencies rather than alternatives. The reasoning and
completion systems require the evidence substrate, while evidence alone does
not fulfill the intended agent-development mission.

### Mission statement

> scip-query makes repository structure knowable, uses that evidence to guide
> whole-repository changes, and verifies that completed work leaves the
> repository as a coherent source of current intent—not merely a collection of
> artifacts that still compiles.

### Basis

An agent can produce a technically correct local implementation while leaving
obsolete implementations, tests, configuration, documentation, exports, or
concepts behind. Those artifacts can remain referenced and compilable, so
ordinary dead-code detection does not identify them. Future agents can then
mistake them for current design, reconnect old behavior, or create a third
competing implementation.

### Consequences

- Completeness becomes an explicit product concern, not merely one diff-gate
  check.
- Outcome trials must measure repository coherence and residue, not only test
  success or changed-consumer coverage.
- Product identity must retain all three layers while explaining their
  dependency order.
- The evidence substrate remains the kernel; reasoning and completion are the
  product behaviors it enables.

### Next choice: priority when interests conflict

The four interests in M-02 are not all the same kind of thing. Agent speed is a
cost of doing the work. Repository coherence and maintainer clarity are
properties of the resulting repository. Compatibility is a requirement to
preserve behavior for existing consumers when an authorized goal or policy
makes that preservation necessary.

Recommendation: first satisfy the authorized behavior and compatibility
requirements. Within those bounds, require a coherent repository whose current
intent maintainers and future agents can identify. Optimize agent speed only
among outcomes that satisfy those conditions. A required compatibility path
does not oppose coherence when its current purpose is explicit; an ambiguous
old path does.

The mental model is construction: the permitted structure and required access
come first, a sound and understandable building comes next, and construction
speed is optimized only among designs that meet those conditions.

Decision settled: authorized behavior and compatibility requirements bound the
acceptable outcomes. Repository coherence and maintainer clarity govern
completion within those bounds. Agent speed is optimized only after those
conditions hold.

### Open question

None on the three-layer identity. The exact public wording remains dependent
on the outcome evidence eventually established by TODO-3.

---

## 2. Repository residue and coherence

### Repository residue

Repository residue is code, configuration, tests, documentation, exports, or
concepts left behind after their original behavioral role has been
superseded, distinguished by still looking intentional enough to influence
future reasoning.

Residue is not identical to dead code. It may have callers, tests, exports,
registrations, or compatibility-shaped paths. Its defining harm is that it
presents obsolete or ambiguous intent as if it were current.

### Coherent repository

A coherent repository is one in which the implementation, entrypoints,
configuration, tests, and current documentation relevant to a capability
present a consistent account of its current behavior, while any surviving
alternatives have explicit, non-conflicting roles.

### Enforcement decision

A strong residue signal does not establish that the artifact is wrong. It
does establish that an unsupported completion claim is premature.

Before completion, the agent must give the suspected artifact a disposition:

- remove it;
- migrate it;
- identify and evidence its current role; or
- explicitly retain it under a bounded compatibility or variation policy.

Weak signals may remain advisory. Strong, unresolved signals become
completion obligations. This makes completion an adjudicated gate rather than
an assertion that every suspicious artifact is a defect.

### Consequences

- Action metadata must distinguish `artifact is obsolete` from `artifact's
current role is unresolved`.
- Suppression is not enough unless it records the current purpose and the
  evidence that defeats the residue interpretation.
- Completion trials need cases where obsolete behavior remains technically
  live and cases where similar-looking compatibility paths are intentional.
- Health and effectiveness output must not count an adjudicated alternative as
  equivalent to a removed obsolete path.

### Next choice: current consequence versus pre-existing debt

Discovering a repository problem while making a change does not by itself make
that problem part of the change. File proximity, age, shared ownership, or
being noticed by the same analysis also does not establish the relationship.

Recommendation: a pre-existing problem enters the current completion boundary
only when current evidence establishes either that the change alters the facts
that gave the affected artifact its role, so leaving it would create or worsen
inconsistency, or that the problem prevents the authorized goal or a protected
condition from becoming true. Otherwise it remains separately reportable debt
and cannot block this goal.

The mental model is a renovation. Damage caused by the work and an old defect
that prevents the new room from functioning belong to the job. An unrelated
leaking faucet elsewhere does not, even if the same inspector notices it.

Decision settled: a pre-existing problem enters the current completion boundary
only when the change alters the facts that gave the artifact its role, so
leaving it creates or worsens inconsistency, or when the problem prevents the
goal or a protected condition. Other debt may be reported separately but
cannot block the current goal.

### Next choice: required state outside the repository

Some code changes require repository artifacts such as migration files,
generated output, or deployment configuration. Others also require an action
or agreement outside Git, such as applying a database migration, changing a
hosted setting, or coordinating an external API contract. Ignoring the latter
can produce a false completion claim, while claiming scip-query verified them
without access would also be false.

Recommendation: completion follows the authorized goal's necessary
consequences, not the storage boundary. Report repository readiness separately
from required external consequences. A required external consequence becomes a
completion obligation and closes only with suitable external evidence. Without
that evidence, the repository portion may be ready, but the overall goal
remains unresolved, checkpoint-complete, or unsupported according to the
goal's scope.

The mental model is preparing and sending a package. The packed package can be
ready while delivery remains unconfirmed; “packed” must not silently mean
“delivered.”

Decision settled: completion follows every necessary consequence of the
authorized goal rather than stopping at the repository boundary. Repository
readiness is reported separately. Required external actions or agreements
remain completion obligations until suitable external evidence closes them;
without that evidence, the overall goal is unresolved, checkpoint-complete, or
unsupported according to its scope.

### Next choice: current compatibility path versus residue

A compatibility path is code that deliberately preserves an earlier interface
or behavior for consumers while connecting them to the repository's current
design. Old code that merely still executes is not thereby a compatibility
path.

Recommendation: retention requires evidence of the protected contract or
consumer class, an authorized reason that protection is current, a demonstrated
connection from the old surface to the current behavior, and a revalidation or
removal condition unless policy explicitly makes support indefinite. If any
part is missing, the path remains an unresolved residue claim rather than
silently becoming legitimate.

The mental model is an electrical adapter. Its supported plug, destination
socket, and reason for remaining in service are identifiable; a dusty cable
kept because someone might need it is not an adapter policy.

Decision settled: a compatibility path may survive only when evidence
identifies the protected contract or consumer class, its authorized current
purpose, its connection to current behavior, and a revalidation or removal
condition unless support is explicitly indefinite.

### Next choice: legitimate variants versus conflicting implementations

A legitimate variant is one of several current implementations of a shared
responsibility, distinguished by serving an explicit operating condition such
as a platform, storage backend, protocol version, or policy choice. Two
implementations that claim the same responsibility under the same conditions
without an authoritative selection rule are conflicting accounts, even if both
work.

Recommendation: variants require an explicit selection boundary, a shared
behavioral contract, current evidence that each implementation serves its
named condition, and no ambiguous overlap in which more than one implementation
can claim authority. Intentional overlap for fallback or comparison must itself
have an explicit selection policy.

The mental model is PostgreSQL and SQLite adapters selected by a declared
backend and governed by one storage contract. Two unlabeled storage
implementations both registered as the default are not variants.

Decision settled: legitimate variants require an explicit selection boundary,
a shared behavioral contract, current evidence that each serves its named
condition, and no ambiguous authority overlap. Intentional overlap requires its
own explicit selection policy.

### Open question

The evidence threshold separating advisory residue from a blocking unresolved
completion obligation remains to be designed after the provenance model is
clarified.

---

## 3. Completeness vocabulary

### Repository-change completeness

Repository-change completeness is the condition in which a repository fully
embodies a stated software-change goal: the intended behavior exists; every
code, data, configuration, test, documentation, and interface element whose
role or truth is altered by that goal agrees with the resulting design; and
every superseded element has been removed or retained under an explicit
current purpose.

Its essential characteristic is that the repository has absorbed all
consequences of the change. Nothing relevant remains in an unexplained
intermediate state.

Completeness is relative to a stated goal, but the causal consequences of
reaching that goal cannot be declared out of scope merely because they were
absent from the original request.

### State conditions

| Condition                 | Meaning                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Goal satisfaction         | The intended post-change behavior or constraint exists                                                             |
| Integration completeness  | Affected consumers, producers, interfaces, data flows, configuration, and generated surfaces agree with the change |
| Supersession completeness | Replaced behavior and concepts are removed, migrated, or retained for an explicit current purpose                  |
| Explanatory completeness  | Names, tests, comments, examples, and current documentation no longer communicate a conflicting design             |
| Repository coherence      | Relevant artifacts jointly present one intelligible current design                                                 |

These are necessary conditions of one concept, not five independent meanings
of `complete`.

### Terms that must remain separate

| Term                           | Referent                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------- |
| Repository-change completeness | The actual state of the repository relative to the change goal                |
| Completion evidence            | Current, scoped observations that justify believing the state is complete     |
| Completion claim               | The agent's assertion that the complete state has been reached                |
| Completion gate                | The stopping policy that accepts or rejects the claim from available evidence |

A repository can be complete before adequate evidence has been gathered.
Conversely, a polished verification report can support a false completion
claim when it omitted an affected consumer or superseded path.

### Exclusions

Completeness does not require:

- repairing unrelated pre-existing debt;
- removing an intentionally supported compatibility path;
- performing optional stylistic cleanup; or
- making the entire repository perfect before one change can finish.

An intentionally retained path counts as complete only when it has a current
purpose rather than merely surviving mechanically.

---

## 4. Checkpoint and full change completeness

### Decision

Long work has two distinct completion conditions:

- **Checkpoint completeness:** an intermediate repository state is coherent
  and safe to continue from, while an explicitly named larger goal remains
  unfinished.
- **Full change completeness:** every consequence of the stated overall goal
  has been reconciled.

An intermediate checkpoint may retain old and new paths only when their
temporary roles are explicit and they cannot reasonably be mistaken for two
equally current designs.

### Consequences

- Agents and hooks must not render `checkpoint complete` as an unqualified
  `done`.
- Multi-stage migrations need a durable record of the larger unfinished goal,
  the current phase, the temporary roles, and the condition that ends the
  temporary state.
- A checkpoint can pass its local checks while the overall completion gate
  remains open.
- Outcome trials should include multi-stage work so checkpoint safety is not
  confused with final completion.

### Next choice: intentionally deferred necessary work

Intentionally deferred work is a known requirement deliberately postponed
beyond the current stopping point. If it remains necessary for the authorized
goal, naming it “deferred” does not make that goal complete.

Recommendation: necessary deferred work permits checkpoint completeness only
when the current state is safe and coherent, the larger goal remains active,
and the deferred requirement survives as an active obligation with a linked
owner or successor change. Full completion remains blocked. Work that is
merely a future enhancement and unnecessary for the current goal is not a
completion obligation and may remain an ordinary TODO.

The mental model is an overnight stop on a longer trip. Reaching a safe hotel
can complete today's stage, but it does not mean the destination was reached or
erase tomorrow's route.

Decision settled: necessary deferred work blocks full completion. It permits
checkpoint completion only when the current state is safe and coherent, the
larger goal remains active, and the requirement survives as an active
obligation with a linked owner or successor change. Optional future
enhancements remain ordinary TODOs.

### Next choice: excluding a known necessary obligation

A completion obligation is necessary because an evidenced repository
consequence must be reconciled for a named goal to close. Calling that
obligation “out of scope” cannot change either the evidence or the goal.

Recommendation: a necessary obligation leaves the current completion boundary
only in one of three ways: current evidence defeats its factual premise; an
authorized revision narrows the goal and preserves the prior version; or a
checkpoint carries the active obligation into a linked successor while the
larger goal remains open. A scope label by itself does nothing.

The mental model is an amount due on an invoice. It can disappear because it
was shown not to be owed, the order was formally revised, or the balance was
transferred—not because someone crossed out the line.

Decision settled: a necessary obligation leaves the current completion boundary
only when evidence invalidates it, an authorized goal revision removes the
requirement, or a checkpoint carries it forward while preserving the larger
goal. A scope label alone has no effect.

### Next choice: independent claim qualifications

One label such as `graph-fact`, `heuristic`, or `strong` combines different
questions and lets an answer that is strong in one respect appear strong in
all. Compiler production, for example, says how an observation was obtained;
it does not say that every relevant result was examined or that an edit is
authorized.

Recommendation: keep five qualifications independent. Origin says how the
supporting observation was produced. Coverage says how much of the relevant
space was examined. Validation status says how the producer has performed
against a named test corpus. State authority says which exact repository state
the evidence may govern. Action tier says what response policy permits from the
claim. No value in one dimension may imply a value in another.

The mental model is a laboratory result: sample identity, measurement method,
amount tested, validation of the method, and permitted clinical response answer
different questions even when printed on one report.

Decision settled: origin, coverage, validation status, state authority, and
action tier are independent qualifications. No value in one dimension implies
a value in another.

### Next choice: closed completion-obligation lifecycle

The prior decisions establish how an obligation begins and every reason it may
stop being active. It begins only when an explicit rule or authorized decision
promotes a claim whose consequence must block a named goal.

Recommendation: the obligation then remains active until current target-state
evidence fulfills it, current evidence or an authorized goal revision
invalidates it, or an atomic carry-forward creates and links an active successor
before deactivating the source. Suppression applies to a claim, deferral retains
an active obligation under checkpoint completion, and historical-only describes
retention after a substantive exit; none is an additional exit.

The mental model is custody of a required item. It remains assigned until it is
delivered, proven unnecessary, or handed directly to another accountable
custodian. Hiding the paperwork is not a transfer.

Decision settled: a completion obligation remains active until current
target-state evidence fulfills it, evidence or an authorized goal revision
invalidates it, or an atomic carry-forward creates an active linked successor.
Suppression, deferral, and historical retention are not lifecycle exits.

### Next choice: stable product core versus extensions

The stable product core is the smallest set of responsibilities whose joint
correctness every normal evidence-to-completion workflow depends on. Removing
one breaks the product's three-layer mission; adding or replacing a specialist
capability does not change the core concepts.

Recommendation: the core owns repository, workspace, change, and collaboration
identity; freshness and capability state; entity resolution and base evidence;
receipts, manifests, and claim qualifications; goals, decisions, obligations,
and their lifecycle; planning and verification context; and common output and
compatibility contracts. Specialist detectors, language enrichments, health
presentations, TLA+ tooling, repair automation, and release tooling remain
extensions or operational support.

Extensions may add observations and actions only through core contracts; they
cannot invent a parallel meaning for authority, coverage, goals, obligations,
or completion. The mental model is an operating system kernel and drivers:
drivers add devices, but do not redefine process identity or memory ownership.

Decision settled: the stable product core owns repository, workspace, change,
and collaboration identity; freshness and capability state; entity resolution
and base evidence; receipts, manifests, and claim qualifications; goals,
decisions, obligations, and their lifecycles; planning and verification
context; and common output and compatibility contracts. Specialist
capabilities remain extensions or operational support behind those contracts.

### Next choice: compatibility and rollout

Schema migration and enforcement promotion share one governing requirement:
new behavior must preserve the meaning of existing evidence while earning any
new authority explicitly.

Recommendation: version every persisted and public contract. Introduce new
fields and readers additively before removing old forms. Decode missing legacy
meaning as unknown or lower-authority rather than inventing stronger values.
Run new detectors and completion policies as advisory first; promote them to
blocking only after validation on a named corpus, predeclared harm thresholds,
an authorized decision, and a tested demotion path. Demotion preserves prior
records and explains the policy change.

The mental model is opening a new bridge lane before closing the old one, then
allowing heavy traffic only after the lane has passed its load tests.

Decision settled: persisted and public contracts are versioned and introduced
additively. Missing legacy meaning remains unknown or lower-authority. New
detectors and completion policies begin advisory and become blocking only after
named-corpus validation, predeclared harm thresholds, an authorized decision,
and a tested demotion path that preserves historical records.

### Next choice: mission-level outcome hypothesis

The product's mission claim must name the agents and tasks affected, the
workflow being added, the comparison condition, the expected improvement, and
the harms that would defeat the claim. Until tested, this is a hypothesis rather
than a product fact.

Recommendation:

> On non-trivial repository changes in language and capability combinations
> where the required scip-query evidence and checks are available, giving an
> otherwise identical coding agent scip-query's evidence-to-plan-to-verify
> workflow causes fewer missed affected artifacts, less repository residue, and
> fewer reintroductions of superseded behavior than native search plus existing
> project checks, without unacceptable increases in regressions, false
> blocking, or human review cost.

“Unacceptable” is fixed through thresholds before trial results are observed.
The mental model is a controlled comparison: the agent and task remain the
same; the complete scip-query workflow is the changed cause.

Decision settled: the mission-level hypothesis is the controlled comparison
above. It remains a hypothesis until independent trials support it; public
claims must remain no stronger than the resulting evidence.

### Repository-grounded condition: architecture conformance

The existing feature has two inseparable layers.

First, `scip-query architecture` constructs the actual directed file-dependency
graph from compiler-resolved imports plus source-resolved imports and
re-exports. It maps files into repository-named responsibility groups and
reports mapping coverage, cross-group edges, reciprocal dependencies, cycles,
hidden internal cycles, unused permissions, boundary growth, single-import
edges, and test reach. These outputs remain observations or inspection signals
unless repository configuration gives them policy force.

Second, repository configuration can turn selected structural conditions into
closed rules. The enforceable families are:

- omitted targets in a declared dependency row;
- missing dependency rows when complete policy is required;
- cycles between named groups;
- cycles hidden inside groups that are too coarse;
- declared dependency permissions that no observed edge uses;
- group fan-out and file-count ceilings; and
- tests that reach beyond the dependency neighborhood of the code they cover.

The stable violation identity names the structural responsibility at issue
rather than the example file that happened to reveal it. The default
`diff-gate` then compares current identities with the committed health
baseline. It blocks a newly appearing identity but accepts a reviewed existing
identity as visible debt. Thus the current enforcement mechanism is strict
about new violations of active rules, but it is a ratchet rather than an
absolute demand for a debt-free repository.

No configuration means no inferred policy and no architecture gate. A boundary
without a dependency row remains descriptive unless complete policy is
explicitly required. Report-only evidence such as unmapped files, reciprocal
pairs, and fragile single-import edges does not block merely because it looks
unusual.

This repository exercises the full contract: 35 named groups have 35 closed
dependency rows; complete and minimal policy, inter-group and hidden
within-group acyclicity, test reach, fan-out, and file-count rules are active.
The current report maps 393 of 410 indexed files, observes 209 allowed group
edges, and reports no declared violations. Its 17 unmapped files and 40
single-import edges remain descriptive evidence rather than failures.

Recommendation: treat architecture conformance as a core
completion-control capability with a discovery-to-declaration-to-ratchet
workflow. scip-query owns the shared evidence and rule semantics; the target
repository owns the structural model and the authority to activate it; agents
may propose that model but do not acquire authority by writing it. Extend the
mission-level hypothesis to predict fewer newly introduced violations of
active repository architecture contracts.

### Existing-feature alignment checkpoint

The redesign is not greenfield. Several current features already implement
parts of the proposed kernel, sometimes with meanings that conflict with the
settled model. The implementation plan must classify each as a reusable
foundation, a contract to migrate, a narrow specialization to preserve, or a
surface to retire.

| Existing feature                                                                                                | What it already establishes                                                                                                                                                                                                                                                 | Alignment consequence                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observation receipts, Stop-hook leases, agent-session state, and Git/cache identities                           | Versioned receipts name an index generation and worktree observation; Stop refuses a clean result when the index is stale or changes during the run; local session state preserves the latest Stop result and unfinished paginated output.                                  | Extend the existing receipt contract rather than create a second one. Its current `projectIdentity`, repository cache identity, and worktree identity are derived from local paths, so they cannot serve as the settled cross-clone collaboration-domain identity.        |
| CLI JSON envelope, invocation coverage, analysis budgets, and capability reports                                | Machine output already versions its outer envelope and per-command result, states evidence class, reports result coverage, and can disclose bounded analysis and available language/checker capabilities.                                                                   | This is the natural carrier for the proposed evidence context and analysis manifest. Ordinary command envelopes do not yet carry the observation receipt, so the shared context is incomplete rather than absent.                                                         |
| Per-file suppression records, automated adjudication, revision-aware writes, and record-compatibility summaries | Suppressions are versioned, merge-friendly files with stable identities, evidence, content-change invalidation, compare-and-replace protection, and explicit accounting for malformed or unsupported records.                                                               | Reuse the storage and compatibility patterns. Keep suppression as a decision about one detector proposal; do not let its existing agent-authorized automatic lane become a general power to dispose of goals or completion obligations.                                   |
| Per-file outcome events, local finding ledger, cross-HEAD replay, and effectiveness reporting                   | Immutable committed events merge across branches; local transactions track what one machine observed; comparable-base replay prevents disappearance after a commit from being mislabeled as a fix; protected external attestations remain distinct from writable telemetry. | Reuse this as the event and evaluation substrate. It currently tracks detector finding transitions, not intended changes, goals, obligations, or repository-change completeness, so those require distinct roles rather than overloaded finding outcomes.                 |
| `diff-gate`, the Stop hook, health baselines, architecture ratcheting, and incomplete-coverage disclosure       | The current completion-control path checks the changed repository, rejects stale or changing evidence, distinguishes findings from accepted suppressions, warns on skipped or failed evidence, and can prevent new baselined violations.                                    | The new completion judgment should orchestrate this path instead of bypassing it. Stop defaults to agent feedback rather than hard blocking, and the gate is finding-relative rather than goal-relative; both facts must remain explicit in rollout and authority design. |
| `plan-context`, the `scip-plan` skill, `cleanup-plan`, and compiler-backed cleanup verification                 | Planning can aggregate flow, consumers, impact, reuse, history, and suppressions; one specialized deletion plan can be applied cumulatively in a throwaway worktree and checked for new compiler errors.                                                                    | Preserve these evidence producers, but do not mistake them for the proposed change record. No source type or repository store currently represents a canonical goal, intended-change identity, completion obligation, or general obligation lifecycle.                    |
| Coverage contracts, incomplete-migration, new-dead, doc-reference, co-change, twin, and architecture checks     | Existing checks detect several concrete ways a locally correct edit can leave stale enumerations, half-migrated call sites, unwired code, stale documentation, missed partners, divergent variants, or forbidden structure.                                                 | Treat them as evidence producers for completeness reasoning, not as one undifferentiated proof of incompleteness. Each needs a promotion rule describing when its result becomes a blocking obligation and when counterevidence keeps it advisory.                        |
| Health reports, baselines, finding-outcome statistics, and committed effectiveness reports                      | Repository pressure, detector handling, and independently attested outcomes are already separated in parts of the implementation, even though the legacy scalar and terminology still combine meanings.                                                                     | Build mission trials and detector certification on the protected-authority path. Do not relabel local suppression/fix telemetry as proof that the full evidence-plan-verify workflow improves goal-complete changes.                                                      |

The leading implementation correction is therefore to begin with a
compatibility map, not a fresh schema. The map must name the existing producer,
consumer, persistence scope, authority, and migration path for every proposed
record role.

### Detailed alignment trace: observation receipts and identity

The current receipt is a real foundation, but several of its field names
combine referents that the settled design now keeps separate:

- `projectIdentity` is a SHA-256 hash of the resolved local project-root path.
  It therefore identifies one workspace location, not a collaboration domain,
  repository lineage, or content state.
- An ordinary command's `worktree.identity` hashes the local `worktreeId`,
  `HEAD`, porcelain status, and tracked binary diff. This combines the identity
  of a concrete checkout with facts about its mutable state. Status includes
  untracked paths but the hash does not include the bytes inside those
  untracked files, so an untracked file can change without changing this
  identity.
- A Stop-hook leased `worktree.identity` is produced differently: it hashes the
  tracked binary diff used by the evidence lease. It does not carry the same
  workspace component and does not cover untracked files. The same field
  therefore has producer-dependent meaning.
- `index.generationIdentity` identifies one produced index generation. Shared
  generation identities also incorporate a local, path-derived repository
  cache identity, so content-identical clones are not guaranteed to receive
  the same generation identity.
- `index.alignment` distinguishes an ordinary, uncertified observation from
  one protected by the Stop evidence lease, but receipt comparison currently
  ignores this distinction.

The current comparator accepts two receipts only when the path-derived project
identity, index generation, and mixed worktree identity are all equal. It is
therefore an exact-local-run compatibility test, not the named content,
workspace, lineage, analysis, and completion compatibility relations required
by the settled model. It is publicly exported but has no production caller;
current receipts primarily preserve provenance in suppressions, outcome
events, diff-gate outcomes, and agent-session state rather than actively
governing evidence combination.

The existing `ProjectInputFingerprint` is a useful narrower primitive. A
project-input fingerprint is a versioned state fingerprint whose identifying
characteristic is the normalized indexer configuration plus the path, size,
and byte hash of every source or configuration file the current indexer
recognizes. It includes tracked and untracked non-ignored relevant files. It
deliberately excludes unrelated repository files and scip-query record
artifacts. Consequently it can support an **index-input identity**, but it
cannot honestly stand for the whole repository-content identity of every
command: documentation analysis, history analysis, suppressions, architecture
baselines, ignored-but-consumed inputs, and other command-specific evidence may
depend on state outside that fingerprint.

The implementation must therefore preserve five distinctions:

1. collaboration-domain identity says which shared body of durable decisions a
   record may join;
2. workspace-instance identity says which concrete checkout was observed or
   may be mutated;
3. relevant-content identity says which repository-owned inputs capable of
   changing the particular claim were observed;
4. index-input and index-generation identities say which inputs an index was
   built from and which actual index artifact answered the query; and
5. alignment evidence says whether those identities remained matched for the
   full observation interval.

This trace establishes an additive migration constraint. Receipt schema
version 1 is embedded in other versioned records, and their current validators
accept only the present receipt shape. A replacement must read legacy receipts
as lower-authority evidence with unknown distinctions, introduce the new
meaning under an explicit schema version, and avoid silently relabeling old
path or mixed-state hashes as stronger identities.

#### Settled design consequence

The compact receipt carries both:

1. a conservative repository-wide content identity used as the safe default
   for combining observations; and
2. a claim-specific relevant-input identity used only when a certified
   producer defines the input projection and establishes that changed content
   falls outside it.

The mental model is a seal on a whole case file plus a seal on the pages used
for one conclusion. Matching whole-file seals support general same-content
reuse. If those differ, matching page seals may preserve only the conclusion
whose certified input rule selected those pages. Neither seal covers Git
history, external state, toolchains, or analysis breadth; those remain in the
analysis manifest.

Decision settled: choose the hybrid design. Whole-repository identity provides
the conservative compatibility relation; a relevant-input identity permits
narrower reuse only under a versioned, producer-certified projection. A
producer's unverified list of convenient inputs cannot create this authority.

The conservative boundary includes tracked files, untracked non-ignored files,
and ignored or generated files explicitly declared as repository inputs.
Dependencies, toolchains, environment variables, caches, secrets, and other
machine state remain analysis conditions in the manifest rather than
repository content. If a command knows an undeclared input can change its
answer, it must lower its authority instead of issuing a complete receipt.

Decision settled: use that boundary. It captures ordinary in-progress edits
and deliberately consumed repository artifacts without making incidental
machine state invalidate every repository comparison. Canonical encoding of
file kinds, executable modes, symlinks, and submodules remains a slice-level
schema question; it must preserve any distinction that can change a supported
command's answer.

#### Observation-interval stability

A completion-authoritative command must analyze a fixed observation snapshot.
An immutable index generation already supplies such a snapshot for facts read
entirely from that index. A command that reads repository files directly must
read from an equivalent fixed copy or another mechanism that prevents the
selected bytes from changing during its analysis.

Before-and-after comparison remains useful as a bracketed observation, but it
has lower state authority: equal endpoint hashes cannot reveal a file that
changed and then returned to its original bytes while the command ran. A
global workspace lock is not the default because it disrupts collaborators and
cannot reliably control every external process.

Decision settled: fixed inputs are required for completion-authoritative
repository evidence. Bracketed live-workspace checks may orient work and
support explicitly weaker claims, but may not be promoted merely because their
before-and-after identities match. A detected change invalidates the result
rather than attaching it to either endpoint.

#### Independent receipt facts

Receipt version 2 replaces the current combined `authorityKind` with
independent facts:

- observed sources identify whether the result used an index generation, a
  repository snapshot, both, or neither;
- stability proof identifies whether those sources were immutable, bracketed,
  or not established; and
- state authority identifies the exact state relationship the evidence may
  govern.

Coverage, producer validation, and permitted action remain separate
qualifications in the evidence context. Adding an index source cannot
implicitly upgrade stability; an immutable snapshot cannot imply complete
coverage; and either fact alone cannot authorize blocking.

Decision settled: use the independent representation. Legacy version-one
`authorityKind` values decode only into the facts they actually establish;
missing distinctions remain unknown and lower authority rather than receiving
inferred stronger values.

#### Authority derivation ownership

An evidence producer records identities, observed sources, stability proofs,
and other checkable facts. It does not write its own final authority level.
Shared, versioned scip-query product policy derives state authority from those
facts and the state against which they are being evaluated. Repository policy
then decides whether the resulting claim may advise, warn, require
adjudication, or block.

The derivation records its policy version. A later policy version may
re-evaluate old facts, but it does not silently rewrite the historical judgment
or make old evidence stronger by assumption.

Decision settled: producers report facts, the product core owns authority
derivation, and repository owners govern permitted actions within the shared
meaning of those qualifications. Plugins and commands cannot gain completion
power merely by emitting a strong label.

#### Authority-evaluation lifecycle

The receipt remains an immutable record of what was observed. Whenever a gate
or other consequential consumer uses it, the product core compares it with the
current target and derives authority under the current named policy. A
consequential judgment is retained separately with the receipt identity,
target identity, policy version, evaluation time, result, and reasons.

If the target changes, the prior evaluation remains valid history but no
longer governs the new target. The gate recomputes rather than mutating the
receipt or treating its old conclusion as current. A newer policy may also
re-evaluate the same facts while preserving the earlier judgment that
explained an earlier action.

Decision settled: choose use-time derivation plus separate historical
evaluation records. This preserves both current correctness and an audit trail
without turning authority into a stale property of evidence.

#### Named compatibility relationships

The comparison API returns separate judgments for:

- collaboration-domain identity;
- repository-lineage identity when it can be derived;
- workspace-instance identity;
- repository-wide content identity;
- a named, versioned relevant-input projection;
- index-input identity;
- index-generation identity; and
- observation stability.

Each judgment is `established`, `disproven`, or `unknown` and carries reasons
and the facts used. There is no total strength score: same workspace is not
inherently stronger than same content, and same generation does not imply that
a live target remains current. A consumer names the relationships its claim
requires; authority policy composes those judgments without making one imply
another.

Decision settled: replace the current universal compatibility boolean with
independent named relationships. Exact serialized field names remain
slice-local, but the distinctions and three possible judgment states are part
of the shared contract.

#### Unknown versus disproven

An unknown relationship means the available facts cannot decide the named
comparison. A disproven relationship means available facts establish that it
does not hold. Both fail to satisfy a required completion condition, but they
produce different reasons and remedies:

- unknown requests stronger evidence, re-observation, or an explicitly weaker
  advisory use; and
- disproven rejects that evidence combination until one of the compared
  referents changes.

Advisory workflows may use unknown-authority evidence for orientation only
when the limitation remains visible. Repository policy cannot configure an
unknown required relationship to count as established; it may instead choose
not to require that relationship for a different, explicitly weaker claim.

Decision settled: completion fails closed on both unknown and disproven
required relationships without equating them. Missing evidence does not prove
a defect, and it cannot be converted into completion.

#### Index-alignment proof

Every immutable index generation stores the canonical identity and projection
version of the source and configuration inputs from which it was built. The
fixed repository snapshot independently computes the same projection.
Alignment is established only when both projection versions and identities
match exactly.

A freshness timestamp, `HEAD` commit, Git tree, or generation name is
supporting diagnostic information, not a substitute. Those values can omit
dirty files, untracked inputs, indexer configuration, or path-independent
equality across clones. If either fingerprint is missing, unreadable, or uses
an incompatible projection version, alignment is unknown. If both are
comparable and differ, alignment is disproven.

Decision settled: exact versioned index-input identity equality between an
immutable generation and fixed snapshot is the index-alignment proof. Producer
and toolchain compatibility remain separate analysis-manifest questions.

#### Command evidence-context inventory

The public registry currently exposes 70 query commands and 23 additional
maintenance or lifecycle commands. The inventory below classifies actual
operations, not merely command names.

**Read-only repository observations.** These require a repository receipt and
analysis manifest:

- navigation and graph: `stats`, `files`, `methods`, `refs`, `trace`, `deps`,
  `rdeps`, `system`, `surface`, `hotspots`, `imports`, `imported-by`,
  `unused-imports`, `outline`, `members`, `fan-in`, `fan-out`, `coupling`,
  `cycles`, `architecture`, `bottlenecks`, `isolated`, `by-kind`,
  `kind-counts`, `deep-chains`, `hierarchy`, `call-graph`, `affected`,
  `change-surface`, `code`, `complexity`, `dataflow`, `slice`, and
  `diff-impact`;
- candidate and residue analysis: `dead`, `similar`, `similar-files`,
  `react-component-duplicates`, `react-hook-candidates`,
  `react-large-component-pressure`, `vue-component-duplicates`,
  `vue-composable-candidates`, `vue-large-view-pressure`, `similar-chains`,
  `extract-candidates`, `locality-candidates`, `cleanup-plan`, `co-change`,
  `recent-duplicates`, `doc-drift`, `unused-params`,
  `incomplete-migration`, `drift`, `wrapper-candidates`,
  `passthrough-candidates`, `stale-abstractions`, `complexity-hotspots`,
  `self-audit`, `convergence`, `redundant-reexports`, `duplicate-bodies`,
  `twin-drift`, `not-implemented`, `decorative-checkers`, `test-quality`, and
  `similar-signatures`; and
- planning and stored-state reports: `plan-context`, `config-validate`, and
  `effectiveness`.

`cleanup-plan --verify` remains an observation of a disposable verification
run: its temporary worktree activity does not make it a target-worktree
mutation, but the checker and temporary snapshot belong in its manifest.

**Mode-dependent observation and mutation.** These require a contract selected
by the invoked operation:

- `health` reports repository observations normally, compares current findings
  with stored policy under `--baseline`, and mutates repository policy under
  `--write-baseline`;
- `diff-gate` observes and judges the diff while also appending outcome records;
- `cleanup-apply --dry-run` observes and verifies a proposed deletion, while an
  applying mode mutates the target worktree;
- `tla verify` and `tla trace-check` observe repository, model, tool, and trace
  inputs, while `tla scaffold`, `tla instrument`, and `tla fetch-tools` create
  repository or tool artifacts;
- `watch --status` observes service and generation state, while foreground,
  daemon, refresh, and stop modes change process or derived-index state;
- `setup-ci --dry-run` and `uninstall --dry-run` preview operations, while
  their applying modes mutate project or user state; and
- `setup-hooks --dry-run` previews hook removal, while its other applicable
  modes mutate checkout-local agent settings.

**Repository, index, or decision mutations.** These record consumed evidence
and preconditions separately from a resulting-state receipt or operation
outcome:

- `reindex`, `augment-sources`, and `augment-vue` create or modify derived index
  generations;
- `twin-ab`, `init`, `suppress`, `setup`, `setup-agent`, and applying
  `setup-ci` modes write repository-owned or checkout-local state;
- `install-skills` and global `uninstall` modes change user-level tool state;
  and
- `diff-gate`, `hook-stop`, and suppression handling may create durable records
  whose post-write content state differs from the state they evaluated.

**Repository-plus-environment or artifact observations.** `bench`,
`work-audit`, `check-deps`, `capabilities`, `capability-matrix`, `doctor`, and
`status` need an analysis manifest that identifies machine, dependency, or
profile inputs. They also require a repository receipt whenever their result
depends on the target repository. A repository receipt alone cannot make an
environment or external profile reproducible.

**Tool-only surfaces and internal workers.** CLI help and version output need
no repository receipt. The hidden `typescript-semantic-compare` operation is a
repository observation. Internal diff-impact, diff-gate, and health workers
must preserve the parent operation's evidence context rather than issue a
second unrelated authority claim. `hook-context` and `hook-pretool` are
control-flow operations; `hook-stop` owns the outer diff-gate evaluation and
its session-state effects.

The current descriptor model cannot express this inventory. It has only
`graph-fact`, `heuristic`, or `mixed` evidence origin. When no value is
declared, every non-heuristic command—including setup and mutation
commands—defaults to `graph-fact`; that default feeds both generated
documentation and runtime envelope metadata. It describes neither result role
nor mutation boundaries.

Decision settled: receipts follow repository-state assertions; mutations use
separate input and resulting-state records; pure tool information remains
undecorated. The exact public command inventory above is the starting
compatibility map rather than a new parallel registry.

#### Operation-specific descriptor roles

Each descriptor declares the operation variants its command supports. Argument
parsing selects one variant before the handler performs observations or
writes. The selected variant supplies:

- its result role: observation, operation preview, mutation, or composite;
- the repository, environment, or external-artifact inputs it observes;
- whether it requires an input evidence context;
- which state domains it may mutate;
- whether it owes a resulting-state receipt; and
- the result-unit, coverage, and evidence-origin contract that already exists
  in narrower form today.

The public envelope identifies the selected variant. A composite operation
keeps observation results, decisions, writes, and resulting state in separate
nested fields rather than letting one receipt ambiguously describe all stages.
The existing public command names remain stable; a future command split is a
usability decision, not a prerequisite for semantic correctness.

Decision settled: use operation-specific descriptor roles. A single static
role is insufficient, and splitting every mode would create avoidable
compatibility cost. Exact property names and TypeScript shapes remain
slice-local.

#### Layered human evidence rendering

Every ordinary repository-observation result ends with a compact evidence
summary stating:

- whether the repository state was fixed, bracketed, or unknown;
- whether any used index was aligned;
- whether invocation coverage was complete, bounded, sampled, or unknown; and
- whether a required compatibility or authority evaluation was performed and
  its result.

The normal established case remains one concise footer. Unknown, stale,
changing, incompatible, or incomplete conditions appear as prominent warnings
beside the affected result rather than being hidden in a footer. Full receipt
identities, comparison reasons, manifest details, and policy versions remain
in the structured JSON envelope and an explicit detailed human view.

Decision settled: use layered human rendering. Do not always print the full
receipt, and do not hide the authority state. Exact wording, color, and detail
flag name remain interaction-design work.

The `--result-only` compatibility question remains open, but the newly stated
autonomy constraint precedes it because it changes who consumes these
contracts and who may make decisions during a long-running change.

#### Autonomy constraint and control loop

The product is intended to support an autonomous coding agent carrying a
large, long-sustained body of repository work to verified completion without a
person reviewing or approving each step. Human monitoring is not the safety
mechanism.

The execution loop therefore must let the agent:

1. load an explicit authorized goal and the repository policies that govern
   it;
2. observe the current repository and external conditions through
   self-describing evidence;
3. maintain persistent goal, plan, attempt, decision, and obligation state
   across turns and context loss;
4. choose and perform authorized edits, cleanup, migrations, tests,
   documentation changes, suppressions, and repository record updates;
5. observe the effects of each action rather than assuming the action worked;
6. use scip-query's independent checks to verify progress against the goal and
   discover remaining consequences;
7. replan when evidence contradicts the current route or repeats a failed
   attempt; and
8. close only when the protected completion conditions are established.

Routine uncertainty does not trigger an approval prompt. The agent first
gathers more evidence, tries a reversible experiment, repairs the problem, or
selects among alternatives using pre-authorized tradeoff policy. Suppressions
and other dispositions may complete autonomously when a versioned policy
validates the required counterevidence; the agent's assertion alone does not
validate them.

Autonomy does not mean self-authorization. The goal, required invariants,
promotion rules, and success criteria must be fixed by the task's initial
authority or repository policy and protected from being weakened merely to
make the current run pass. Tests, baselines, configuration, suppressions, and
goals that the agent can edit cannot be the sole independent judge of the same
work. Authorized evolution of those artifacts must be part of the goal or
checked by an evaluation rule the change cannot silently redefine.

If the available goal and policy genuinely do not authorize any choice needed
to proceed, the system must report that unresolved boundary loudly rather than
quietly weakening the goal. That is a missing autonomy contract, not a planned
human approval step.

This correction reopens the earlier decision-ownership wording. Repository
owners still supply goals and policy, but an autonomous agent may make binding
implementation and disposition decisions whenever those rules pre-authorize
the decision and independently check its effects. “Agents may not promote
their own proposals” now means they cannot invent promotion authority; it does
not mean a person must approve every promotion.

#### Standing autonomous decision authority

When several implementation outcomes satisfy the authorized goal and no
explicit choice was supplied, the agent has standing authority to choose among
them using this ordered rule:

1. satisfy the explicit goal and every protected constraint;
2. preserve required behavior, compatibility, and repository policy;
3. maximize repository coherence and full-change completeness;
4. prefer the outcome with the smaller irreversible effect and narrower blast
   radius; and
5. optimize execution cost and speed only after the preceding conditions are
   equal.

The agent records the alternatives considered, the decisive evidence, the rule
that selected the outcome, and the observed effects. It may gather more
evidence or run a reversible experiment when the ordering does not yet select
an outcome. If no available outcome is authorized, it records an unresolved
authority boundary; it does not invent permission or weaken the success
condition.

Decision settled: this ordering is standing delegated authority for ordinary
implementation ambiguity. It removes routine design approval from the
execution loop without turning operational autonomy into authority to rewrite
the goal.

#### Efficient autonomy and protected evaluation

The workflow is not justified by compliance with a prescribed sequence. A
required step is justified only by the difference its result can make: it
changes the target state, changes a supported next decision, preserves work
state that would otherwise disappear, verifies an effect, or records a live
obligation. A step whose output cannot do any of those things is ceremony and
must be removed or made an automatic implementation detail.

Cheap information gathering remains rational when it lowers expected rework.
The system therefore uses condition-triggered checks rather than a fixed
ritual: observe before a decision that depends on unknown or stale state;
re-observe after a relevant change; reuse compatible evidence; and skip a
duplicate check when its inputs and required claim relationship are already
established. Receipts, manifests, attempt records, and ordinary progress
transitions are produced at shared boundaries instead of being typed by the
agent.

Efficiency is measured from authorized goal to verified completion. Failed
attempts, repeated exploration, context reconstruction, and residue repair
count against the workflow that caused them. Once both conditions reach the
same completion-quality threshold, the scip-query workflow must improve either
elapsed time or model-token use without an unacceptable regression in the
other. A fast incomplete run is a failure, not an efficiency win.

The protected evaluation boundary has two layers:

1. The governing layer is the immutable authorized version of the goal,
   invariants, repository policy, certification policy, and transition rules
   for the current evaluation.
2. The working layer contains code, tests, fixtures, documentation,
   configuration, baselines, suppressions, plans, and proposed successor
   versions that the agent may edit when authorized.

Working-layer artifacts may contribute evidence but cannot be the sole judge
of their own change. A successor governing artifact becomes authoritative for
the same run only when a transition rule already present in the protected
version validates the successor from independently observed effects. Examples
include a baseline ratchet that proves no new violation identity was hidden, a
suppression policy that checks named counterevidence, and a goal rule that
allows evidence-established consequences without changing the destination.

If no protected rule authorizes a needed governing change, the run records an
unresolved authority boundary. It does not prompt as part of normal execution,
silently weaken the standard, or count its proposed replacement as active.
Another authorized run may later supply a revised goal or policy.

Decision settled: use condition-triggered, automatically recorded evidence and
the two-layer protected-evaluation model. This closes the program-level
autonomy envelope; exact schemas and checker-specific transition rules are
decided and tested in the slices that consume them.

### Earlier decision-ownership recommendation — reopened

Decision authority is the recognized power to make a choice binding on the
product or repository it governs. Writing, recommending, or enforcing a choice
does not create that power.

Earlier recommendation: scip-query product maintainers own shared concept meanings,
schemas, producer certification, and default enforcement policy. Each target
repository's authorized owners own its goals, compatibility promises, local
policy adoption, and durable dispositions. Agents may gather evidence, create
claims, propose goals or decisions, and execute already authorized rules; they
may not promote their own proposals. CI and hooks enforce accepted policy but
do not create it.

Every normative decision records its role-derived authority, evidence, policy
version, and history. Repository owners may revise local intent but cannot
redefine shared scip-query meanings; product maintainers cannot choose a
repository's destination. The mental model is standards authors, building
owners, contractors, and inspectors: each can bind a different kind of fact or
choice.

The ownership separation remains, but the statement that agents only propose
decisions is too narrow for the newly explicit mission. It is reopened pending
the autonomy-envelope rule: pre-authorized automated promotion and disposition
must not depend on runtime human approval.

### Open question

The durable representation of an unfinished multi-stage goal is not yet
chosen. It may belong to session state, repository-owned migration records, or
a more general completion-obligation ledger.

---

## 5. TODO-1 — Observation authority

### Distinction under review

Observation authority and reproduction context are different:

- observation authority identifies the repository state an answer describes
  and determines whether it can be combined with another answer;
- reproduction context records the tools, versions, configuration,
  capabilities, invocation, and analysis limits needed to interpret or rerun
  the analysis.

Combining them would turn one precise compatibility concept into a large audit
record with unclear equality rules.

### Receipt-content recommendation

Use a compact observation receipt as the compatibility identity. It should
contain:

- schema and canonicalization versions;
- observation time;
- collaboration-domain, repository-lineage when established, and
  workspace-instance identities as separate facts;
- the repository-wide content identity;
- each applicable relevant-input identity and its projection version;
- index-input and index-generation identities when an index was observed;
- observed-source facts; and
- the proof that each observed source was fixed, bracketed, or not established.

Keep command, arguments, producer version, analysis budget, coverage,
capabilities, evidence provenance, and certification in an adjacent evidence
manifest or existing envelope fields. Do not serialize a producer-asserted
final authority label on the receipt. Shared policy derives authority against
the target at use time and records consequential evaluations separately.

### Proposed completion policy

- Every observation used as completion evidence must carry a receipt.
- Incompatible receipts cannot jointly support a complete-set claim.
- Unknown-authority evidence may orient an agent but cannot prove
  completeness.
- Evidence observed before a later edit must be re-observed or mechanically
  shown to remain valid.
- Human rendering may hide receipt details while preserving them internally.
- `--result-only` output abandons the common authority contract and cannot
  stand alone as completion evidence.

### Consequences for other TODOs

- TODO-2 defines the adjacent evidence manifest and row-level provenance.
- TODO-3 trial records must preserve the receipt that authorized each decisive
  observation.
- TODO-4 health comparisons need compatible receipts or an explicit statement
  that they compare different repository states.
- TODO-5 places receipt generation and comparison in the product kernel.

### Option comparison

An **evidence manifest** is a structured production record that identifies how
an observation was obtained, what part of the possible answer was examined,
which capabilities were available, and what prior validation applies. Its
distinguishing purpose is interpretation and reproduction rather than
repository-state compatibility.

The apparent binary choice contains two independent decisions:

1. whether authority and production context are one concept or two; and
2. whether two concepts travel in one result envelope or in separate records.

That produces three real options:

- **Option A — physically separate records:** a compact receipt travels or is
  stored independently from an evidence manifest.
- **Option B — one undifferentiated audit manifest:** authority, invocation,
  capability, coverage, provenance, and validation fields form one object with
  one apparent identity.
- **Option C — one self-contained evidence context with two nested
  contracts:** every result carries both a compact authority receipt and a
  logically separate analysis manifest.

| Axis                       | Option A: separate records                                                        | Option B: one manifest                                                                     | Option C: nested self-contained context                                                               |
| -------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| State-combination question | Precise when the receipt is present                                               | Ambiguous unless a compatibility subset is defined inside the manifest                     | Precise through the nested receipt                                                                    |
| Result portability         | Weak unless the records are always bundled or durably linked                      | Strong                                                                                     | Strong                                                                                                |
| Risk of lost context       | Highest: receipt or manifest can be copied without the other                      | Lowest physically, but semantic distinctions can still be lost                             | Low: both travel together and retain separate meanings                                                |
| Schema stability           | Receipt can remain stable while manifest evolves independently                    | Unrelated analysis changes churn the same large schema                                     | Receipt and manifest can version independently inside one envelope                                    |
| Comparison semantics       | Simple receipt equality/compatibility; a second join is needed for interpretation | Either overly strict equality or ad hoc field subsets                                      | Simple authority comparison plus explicit analysis-compatibility checks when needed                   |
| Payload size               | Smallest when consumers fetch only what they need                                 | Largest unavoidable payload                                                                | Larger than receipt-only, but structured consumers can ignore the manifest fields they do not need    |
| Privacy and disclosure     | Fine-grained distribution, but more storage/access policy                         | One object tends to expose every recorded field together                                   | One transport policy by default; sensitive manifest fields can still be omitted or hashed by contract |
| Row-level mixed provenance | Manifest can support it, but the link to the result must remain intact            | Often encourages one command-level summary                                                 | Fits naturally inside the analysis sub-contract                                                       |
| Human readability          | Compact receipt can stay hidden; external manifest may be hard to discover        | Large object is unsuitable for ordinary rendering                                          | Human output can summarize the context while structured output remains complete                       |
| Trial and audit capture    | Requires collecting and joining both records correctly                            | Convenient self-contained artifact                                                         | Convenient self-contained artifact with clearer interpretation                                        |
| Current architecture fit   | Requires a new external store, sidecar, or binding mechanism                      | Replaces current envelope fields with one broader public object                            | Extends the existing envelope by grouping authority and analysis contracts                            |
| Dominant failure mode      | Orphaned evidence or broken record binding                                        | Treating all metadata as one kind of authority and confusing equality with reproducibility | More schema design and two explicit compatibility operations                                          |

### Fundamentality verdict

Logical separation is essential. Changing authority fields must alter whether
two results can describe one repository state; changing an analysis budget or
validation certificate must not, by itself, imply that the repository states
differ. If those fields inhabit one undifferentiated identity, every consumer
must rediscover the hidden subset that really governs compatibility.

Physical separation is incidental. The receipt and manifest can travel in the
same envelope without becoming one concept. Co-location preserves portability
and auditability while nesting preserves the distinct comparison rules.

### Current synthesis

Option C best satisfies the combined purpose:

- the result is self-contained for agents, CI, trials, and stored records;
- authority comparison remains small and mechanically decidable;
- reproduction and qualification metadata can evolve without redefining
  repository-state identity; and
- row-level provenance has a natural owner without bloating the receipt.

The likely conceptual shape is:

```text
result envelope
├── authority receipt
│   └── which repository state was observed?
├── analysis manifest
│   └── how was it observed, how much was examined, and what does validation support?
└── command result
    └── what was observed?
```

This is not yet a field-level schema decision. The analysis manifest may reuse
existing envelope fields rather than wrap them immediately. The decision at
this stage is that every authoritative structured result is self-contained
while authority and analysis retain separate contracts and comparison
semantics.

### Decision status

Settled: adopt Option C.

Every authoritative structured result will be self-contained. A compact
observation receipt and a logically separate analysis manifest will travel
together inside one evidence context. The receipt answers whether observations
describe a compatible repository state; the manifest answers how the
observations were produced and what their limits permit a consumer to
conclude.

This settles the conceptual and transport boundary. Exact receipt fields,
manifest fields, nesting names, versioning, and compatibility behavior remain
open slice-level design questions.

### Project, workspace, and state identity

#### Settled decision

Two clones containing identical repository-owned content may count as
observations of the same repository content state while retaining distinct
workspace-instance identities.

The identities remain separate:

- **Repository lineage identity** groups checkouts that belong to the same
  logical repository history.
- **Collaboration-domain identity** groups branches, clones, linked worktrees,
  and contributor forks whose code and durable project decisions are intended
  to merge into one shared project history.
- **Workspace-instance identity** identifies one concrete clone or linked
  worktree in which commands and edits occur.
- **Repository-content identity** identifies the exact repository-owned inputs
  whose values can affect the observation.

Same lineage does not imply same content. Same content does not imply the same
workspace. Shared ancestry does not by itself imply shared decision authority.
None of these relations alone implies that two analyses are interchangeable.

#### Vocabulary correction: collaborating fork versus independent derivative

The earlier word `fork` compressed two importantly different referents:

- A **collaborating fork** is a Git repository copy whose changes and durable
  project decisions are intended to return to the shared project through a
  merge or pull request. Its essential characteristic is participation in the
  same decision-and-merge process, not where the copy is hosted.
- An **independent derivative** is a repository descended from another
  repository whose future project decisions are no longer governed by that
  shared merge process. It may retain ancestry and identical content while
  becoming a separate collaboration domain.

A feature branch off `dev`, a linked worktree, a local clone, and a
contributor's pull-request fork should therefore normally share one
collaboration-domain identity. Assigning every Git fork a new project identity
would fragment exactly the suppression, event, obligation, and outcome history
that must travel with a change. A derivative should detach from that identity
only when it becomes an independently governed project.

Git topology cannot settle this distinction by itself. Two repositories can
look like forks while participating in one project, or share ancestry while
having permanently diverged. An explicit, committed collaboration-domain
identifier will represent the decision boundary: ordinary branches, clones,
worktrees, and contributor forks inherit it; an independent derivative
deliberately replaces it.

Decision settled: use one committed collaboration-domain identity inherited by
merge-intended branches, clones, linked worktrees, and contributor forks, with
explicit detachment when a derivative becomes independently governed.

#### Repository-owned records and branch collaboration

A **durable project record** is a version-controlled statement about a code
finding, decision, obligation, or outcome whose future interpretation of the
repository should preserve. Its essential characteristic is that it changes
what later collaborators are warranted in concluding, so it belongs with the
code and policy state that justify it.

The intended flow is:

1. A branch changes code and produces a finding.
2. A collaborator records a justified disposition, such as a suppression,
   alongside that code.
3. The pull request merges both code and record into the target branch.
4. scip-query re-evaluates whether the merged target state still satisfies the
   record's applicability conditions.
5. Applicable decisions remain active; decisions invalidated by the merge
   become inactive or require renewed adjudication; resolved findings remain
   historical rather than silently suppressing a later, unrelated finding.

The current storage layout already supports part of this collaboration model.
Suppressions are stored as one JSON file per suppression, and the store
explicitly chooses that layout so unrelated additions on concurrent branches
merge without conflict. Event records use separately named JSON files, making
independent additions append-like. A collision on the same finding is not
ordinary storage noise: if two branches made different decisions about the
same finding, that disagreement should be exposed and resolved rather than
silently won by one branch.

The record needs three distinct kinds of identity:

- Its **home** is the collaboration domain whose durable knowledge it joins.
- Its **origin** is the exact workspace, content state, analysis, and policy
  context in which the decision was warranted.
- Its **current applicability** is determined against the merged target
  content and current detector and policy versions.

The origin receipt is evidence about where a decision came from; it must not
become the namespace that prevents the decision from merging. Conversely, a
shared project identity permits a record to be considered after merge; it does
not prove that the old decision remains applicable.

This produces the following collaboration rules:

- Do not scope committed record filenames or primary identities to a branch,
  worktree path, or clone identifier.
- Give stable findings stable semantic identities so the same issue converges
  on the same record across branches.
- Let unrelated records merge as separate files.
- Treat divergent records for the same finding as a meaningful adjudication
  conflict.
- Revalidate every merged record against the target content, detector version,
  policy version, and any recorded invalidation conditions.
- Distinguish durable repository knowledge from temporary session notes or
  branch-local waivers; only the former should enter shared history by default.
- When a project becomes an independent derivative, explicitly detach its
  collaboration-domain identity and re-evaluate inherited decisions under the
  derivative's own policy.

The simple mental model is that branches are separately edited copies of one
manual. The JSON records are durable editorial decisions that travel back with
the changed pages. A receipt says which copy and draft justified a decision.
After merging, the editor checks the decision against the final combined
draft. The fact that the note came from another copy does not disqualify it;
the fact that it once applied does not make it permanently true.

#### Collaboration risks and guardrails

1. **Divergent decisions for one finding.** Two branches may suppress or
   disposition the same finding differently. Converge them on one stable
   identity and require explicit resolution when their substantive fields
   disagree.
2. **Stale decisions after merge.** Combined code may remove the original
   reason for a suppression or change the evidence. Revalidate on the target
   state instead of treating successful Git merge as semantic validity.
3. **Accidental resurrection.** A finding fixed on one branch could later
   receive an old suppression from another. Bind applicability to the finding's
   semantic identity and invalidation evidence, and keep resolved records from
   matching a new occurrence merely because a path or check name is reused.
4. **Temporary waiver leakage.** A local or checkpoint-only decision may be
   merged as permanent project policy. Give records explicit scope and
   lifecycle rather than inferring permanence from file existence.
5. **Independent-policy leakage.** A derivative project can inherit decisions
   whose reasons no longer match its goals. Require deliberate identity
   detachment and re-adjudication when governance separates.
6. **Unstable finding identities.** Rebases and nearby edits may generate
   different IDs for one issue or reuse an ID for another. Define finding
   identity from the enduring subject and claim, with content anchors used for
   applicability rather than raw line positions alone.
7. **Duplicate append records.** Independently written event files can describe
   one logical event twice. Give each consequential logical operation one
   stable operation ID, so recording that operation again is recognized as a
   repeat rather than counted as a second event.

#### Next clarification: what should survive, and in what role?

##### Ultimate problem

scip-query must preserve the facts and decisions that future collaborators need
without turning every intermediate observation into permanent project truth.
Dropping too much makes the project forget why it behaves as it does. Retaining
too much without status or scope produces the residue problem inside
scip-query's own records: stale plans, provisional waivers, and old
observations continue to look current and authoritative.

##### Role of this question

This question determines which records:

- stay on one machine;
- travel with one in-progress change;
- merge into the collaboration domain's shared history; and
- may currently alter a gate or completion judgment.

It therefore controls both collaboration and epistemic authority. `Is this
record retained?` and `May this record change today's conclusion?` are
different questions.

##### Concept repair

The binary phrase `durable versus temporary` collapses three distinctions:

1. **Persistence scope** is a record property specifying the set of future
   work contexts that should retain it: one execution or workspace, one
   in-progress change, or the collaboration domain's continuing history.
2. **Epistemic role** is the way a record contributes to knowledge: an
   observation reports what was seen, a decision records a justified policy
   choice, and derived state is a reproducible result computed from other
   inputs.
3. **Lifecycle state** says whether the record can act now: proposed, active,
   expired, invalidated, superseded, or historical.

These dimensions cannot be replaced by file location. A record may be
permanently retained as history while being forbidden from authorizing a
current exception.

Concrete durable-project-knowledge referents include:

- a suppression decision with inspectable reasons and invalidation conditions;
- an immutable event recording that a stable finding was caught, resolved,
  suppressed, or reopened; and
- a disposition establishing why a suspected residue remains current,
  compatible, removed, or intentionally deferred.

Nearby records that do not automatically qualify include:

- a rebuildable local index or evidence cache;
- an unadjudicated command result or standalone receipt from one execution;
- scratch reasoning and an incomplete plan; and
- a provisional waiver whose purpose ends with one checkpoint.

A receipt embedded in a durable decision may remain with that decision as
origin evidence. That does not make every standalone receipt durable or give
the receipt independent decision authority.

##### Current implementation evidence

The code already contains the beginning of this separation:

- `.scipquery/events/*.json` is the team-shared complement to a per-machine
  database. Each file is an immutable transition observation; retries and
  merged duplicates collapse by the stable tuple of check, finding ID,
  transition, and commit.
- `.scipquery/suppressions/*.json` contains decision records. A current record
  can waive a matching finding only after policy, counterevidence, expiry, and
  invalidation checks.
- `evidence.db` records what one machine has seen and is rebuildable rather
  than shared project memory.

The fact that event and suppression files are both committed does not make
them the same kind of record. An event contributes historical evidence; a
suppression can authorize a current gate exception.

##### Alternatives

**Option A — binary by storage location**

Everything committed under `.scipquery/` is durable and active; everything
local is temporary.

Advantages:

- simplest rule to explain and implement;
- Git supplies distribution and retention; and
- few schema fields are required.

Costs:

- confuses historical retention with present authority;
- makes expired and superseded records look current;
- encourages branch-local scratch state to leak into shared policy; and
- recreates repository residue in the tool's own knowledge store.

**Option B — fixed behavior by record type**

Suppressions and outcome events are always durable; receipts, caches, and plans
are always temporary.

Advantages:

- fits much of the existing implementation;
- commands can apply safe defaults without asking users; and
- each storage directory has predictable merge behavior.

Costs:

- one type can have different legitimate lifetimes: a receipt can be
  standalone scratch evidence or retained origin evidence inside a decision;
- provisional and active decisions need different behavior even when they have
  the same substantive shape; and
- new record types repeatedly reopen the same classification problem.

**Option C — independent scope, role, and lifecycle**

Every consequential record type has an explicit persistence scope, epistemic
role, and lifecycle contract. Commands still provide strong defaults by record
type, but correctness does not depend on those defaults remaining implicit.

Advantages:

- preserves the difference between retained history and active authority;
- supports local work, checkpoint work, and collaboration-domain history
  without inventing unrelated storage models;
- allows a merged provisional record to become historical rather than silently
  permanent; and
- gives future agents explicit evidence about why a record exists and whether
  it may still act.

Costs:

- adds schema and migration complexity;
- invalid combinations must be rejected, such as a rebuildable cache claiming
  permanent decision authority;
- lifecycle transitions need ownership and audit rules; and
- raw JSON becomes harder for humans unless commands render and modify it.

##### Recommendation

Decision settled: choose Option C, with record-type defaults so ordinary
workflows remain simple. The schema will express the distinctions; scip-query
commands should normally choose the fields rather than making users construct
them manually.

The working classification would be:

| Record referent                | Default persistence scope | Epistemic role        | Default lifecycle behavior                                      |
| ------------------------------ | ------------------------- | --------------------- | --------------------------------------------------------------- |
| Index, cache, execution trace  | Workspace/session         | Derived or diagnostic | Rebuild or discard                                              |
| Standalone observation receipt | Execution or change       | Observation           | Expires when its observed state is no longer compatible         |
| In-progress plan or checkpoint | Change                    | Proposal              | Resolve, explicitly carry forward, or make historical           |
| Outcome event                  | Collaboration history     | Observation           | Immutable historical fact; never independently waives a finding |
| Suppression or disposition     | Collaboration history     | Decision              | Active only while its evidence and invalidation contract hold   |
| Completion record              | Collaboration history     | Judgment              | Historical claim tied to its exact goal, state, and authority   |

This table is a conceptual default, not yet a field-level schema. In
particular, `change` needs a stable identity across branch renames and rebases,
and the allowed lifecycle transitions remain open.

#### Next choice: how Option C appears in record schemas

##### Ultimate problem

Every reader, gate, and future agent must interpret record scope, role, and
lifecycle consistently. If the distinctions remain only in prose, record types
will drift apart. If every distinction becomes a required field on every JSON
object, the files will repeat fixed facts, admit meaningless combinations, and
create migration work without adding knowledge.

##### Role of this question

This question determines where the meaning lives: in every record instance, in
the code for each record type, or in a shared taxonomy combined with
type-specific contracts. It is an encoding question, not a reconsideration of
Option C's conceptual distinctions.

##### Simple mental model

Think of a library catalog. The library needs one shared classification system,
but it does not need every page of every book to repeat the book's category.
The catalog can declare the properties fixed for a kind of item, while an
individual item records only the properties that can actually differ.

##### Alternatives

**Encoding A — universal instance fields**

Every committed record contains explicit `persistenceScope`, `epistemicRole`,
and `lifecycleState` fields.

Advantages:

- each JSON object is superficially self-describing;
- generic tools can inspect the fields without consulting a type registry; and
- cross-type queries are mechanically straightforward.

Costs:

- immutable outcome events repeatedly store the same fixed values;
- meaningless combinations must be rejected everywhere;
- an `active` field can become stale even though the evidence that determines
  activity has changed; and
- adding or revising a universal value forces broad record migrations.

**Encoding B — entirely type-owned meaning**

Each record kind defines its own behavior without a shared vocabulary or common
contract.

Advantages:

- individual schemas stay small;
- each type can model only the distinctions it needs; and
- current suppression and outcome-event structures require less change.

Costs:

- `active`, `historical`, `local`, and similar ideas can silently acquire
  different meanings in different modules;
- generic health, migration, and audit tools cannot compare record behavior
  reliably; and
- new record types must rediscover the same distinctions.

**Encoding C — shared taxonomy with type contracts**

Define one normative vocabulary for scope, role, and lifecycle. Each record
kind declares which values are fixed, which are allowed to vary, and which
current states are computed. Serialize an instance field only when the value
can legitimately vary between records of that kind.

Examples:

- An outcome-event contract fixes its scope to collaboration history, its role
  to observation, and its lifecycle to immutable history. Individual event
  files need not repeat those values.
- A suppression contract fixes its role to decision and its default scope to
  collaboration history. The record stores expiry, counterevidence,
  invalidation conditions, and supersession facts; the reader computes whether
  it is currently active instead of trusting a stored `active` boolean.
- A receipt contract fixes its role to observation, while its container or an
  explicit instance field determines whether it is execution-scoped,
  change-scoped, or retained as origin evidence inside a durable decision.

Advantages:

- preserves a common meaning across all record kinds;
- avoids redundant fields and impossible combinations;
- separates durable causal facts from computed current state; and
- lets generic tooling ask one registry how a record may be interpreted.

Costs:

- the type-contract registry becomes a public semantic dependency that must
  remain synchronized with schemas and readers;
- a raw record is not fully interpretable without its `kind` contract; and
- migrations must preserve both record bytes and the historical meaning of the
  contract version that wrote them.

##### Recommendation

Decision settled: choose Encoding C. It gives Option C a single vocabulary
without pretending that every distinction varies on every record. It also
prevents a stored `active` label from becoming residue: current lifecycle
should be computed from durable evidence and transition facts whenever
possible.

#### Next choice: whether one intended change owns records

The immediate problem is that plans, checkpoints, and provisional waivers can
outlive one checkout and move through rebases or contributor forks, while still
not being permanent project policy. Treating them as workspace-owned loses them
when work moves. Treating them as collaboration-history decisions makes
unfinished or temporary state look permanent.

The proposed middle scope is one intended code change: the goal-directed body
of work that may cross branches, worktrees, and contributor forks before being
merged, abandoned, or divided. It covers the plan and temporary decisions for
that change. It does not cover unrelated work on the same branch or durable
policy that should govern future changes.

The mental model is a folder traveling with a pull request. Different copies of
the repository may work from that folder. Once the change merges, each record
in the folder must resolve, explicitly carry forward, or remain only as
history; none silently becomes active project policy.

Decision settled: make `change` a first-class persistence scope, identified by
a stable change identity rather than a branch name.

#### Next choice: stable change identity

The identity must remain the same when a branch is renamed, commits are
rebased, work moves to another checkout, or a contributor fork opens a pull
request. It must also work without a hosting provider.

Branch names fail because they are mutable and can be reused. Commit IDs fail
because rebasing replaces them. Pull-request and issue IDs fail as the primary
identity because they may not exist yet, are provider-specific, and can refer
to coordination units larger or smaller than one intended change.

Decision settled: scip-query generates one opaque random identifier when the
change record is created. The identifier carries no inferred meaning and
remains stable because the record itself travels with the work. Branch, pull
request, issue, and initial-commit identifiers are optional links rather than
identity sources. Splitting a change creates child identities that cite the
original; combining independently started changes records an explicit
relationship instead of pretending their histories were always one.

#### Next choice: reconciling records when a change merges

Merging code does not determine what its plans, checkpoints, waivers, and
obligations now mean. Automatically promoting every record would make temporary
work permanent policy. Automatically archiving every record would silently
discard unfinished obligations.

The proposed closure rule requires every active change-scoped record to receive
one disposition:

- **fulfilled** — the merged repository now satisfies what the record required;
- **carried forward** — an active obligation or decision is explicitly moved to
  a successor change or collaboration-owned record; or
- **historical-only** — the record remains as context but has no current
  authority.

A record with no valid disposition remains unresolved. It may accompany an
explicit checkpoint, but it prevents the merged change from supporting a full
completion claim.

The mental model is closing a project folder: every live item must be checked
off, moved into a named successor folder, or stamped reference-only. Simply
putting the folder in the archive does not finish its contents.

Decision settled: require this explicit reconciliation at change closure, with
record-type contracts determining which dispositions are legal and what
evidence each requires.

#### Next choice: evidence for fulfillment

`Fulfilled` is a conclusion that the merged target state now satisfies what one
active record required. It is not an author-controlled label. A bare status
would let the same agent that performed the work erase an obligation without
showing that the relevant condition changed.

A universal check suite would be stronger than a label but would still be
wrong: different records require different evidence. A test obligation, stale
registration, documentation mismatch, compatibility decision, and
human-judgment residue question do not share one satisfaction test.

Decision settled: each record-type contract defines its satisfaction condition
and acceptable evidence. A closure record names the obligation, the target
content state, and the evidence that met that contract. Mechanically checkable
conditions require a current authoritative observation. Judgment-dependent
conditions require a named adjudicator, reasons, and the observations on which
the judgment rests. Readers derive `fulfilled` from that evidence and current
compatibility rather than trusting a stored status by itself.

#### Next choice: evidence for carrying work forward

Carrying a record forward means moving an unfinished requirement to another
active owner. It does not satisfy, weaken, or summarize away that requirement.
A source record cannot become inactive merely because it names a future branch
or says `deferred`.

Boundary settled: only completion obligations travel this way. A completion
obligation is a current unresolved repository consequence that must receive a
disposition before the larger goal can close. General TODOs, optional
improvements, and unrelated future work remain outside scip-query's
cross-change memory.

Decision settled: closure accepts this disposition only when the target
repository state already contains a valid destination record. The source and
destination identify one another; the destination preserves the original
requirement, evidence lineage, and any deadline or invalidation conditions; and
the source becomes inactive only after that destination is readable and active.
The destination may belong to a successor change or to collaboration history as
an explicit project obligation. It does not silently become project policy.

The mental model is handing off a physical file: the recipient's copy must
exist and contain the live contents before the sender marks its copy
transferred.

#### Next choice: historical retention versus substantive disposition

The earlier closure list treated `historical-only` like a reason an active
record could close. That creates a loophole: an agent could archive an
unfinished obligation without fulfilling it or handing it off.

Historical retention answers whether an inactive record remains available for
future understanding. It does not answer why the record lost authority. An
active completion obligation needs a substantive disposition first:

- **fulfilled** — current evidence shows its required condition now holds;
- **invalidated** — current evidence shows its premise no longer describes a
  consequence of the current goal or repository state; or
- **carried forward** — a linked active destination preserves the unfinished
  requirement.

After one of those dispositions, the source may remain as historical context.
Observations and non-obligating proposals may be historical by their
type-contract lifecycle without needing an obligation disposition.

Decision settled: remove `historical-only` from the set of obligation-closing
reasons and retain it only as a resulting inactive lifecycle state.

#### Next choice: evidence for invalidation

Invalidating an obligation means establishing that its unresolved consequence
no longer belongs to the current goal and repository state. It does not mean
that the old supporting evidence became stale, a deadline passed, a detector
changed, or the obligation became inconvenient. Those conditions require
re-evaluation; they do not prove the obligation false.

Decision settled: permit invalidation through two routes:

- current authoritative evidence defeats the obligation's factual premise; or
- an authorized goal decision explicitly revises the goal or scope that made
  the consequence obligatory.

The invalidation record names the route, the target state, the evidence or goal
revision, the decision authority when judgment is involved, and the
record-type invalidation contract it satisfies. If evidence is merely missing,
stale, or incompatible, the obligation remains unresolved.

The mental model is cancelling a requirement: show either that the condition
which created it never applies now, or that the person who owns the goal
changed the requirement. Losing the supporting paperwork is neither.

#### Next choice: complete persistence-scope set

Persistence scope answers where a record should continue to exist and which
future work contexts inherit it. It does not answer which repository state the
record describes, whether its evidence is compatible, or whether it currently
has authority.

Decision settled: use four scopes:

- **invocation** — available only within one command execution unless embedded
  into a broader record;
- **local** — retained in tool-controlled local state across invocations but
  never merged as project knowledge;
- **change** — travels with one intended code change until closure; and
- **collaboration history** — version-controlled shared knowledge inherited by
  the collaboration domain.

The mental model is four containers: the current command's desk, the local
toolbox, the traveling change folder, and the project's shared archive. A
receipt may begin on the desk and later be embedded in a change or archive
record, but that movement must be explicit.

This set deliberately omits branch scope because branch names are mutable and
one branch can contain unrelated changes. It omits content-state scope because
content compatibility controls where evidence may be reused, not where a
record is retained.

#### Next choice: observation versus claim

A record that reports what a tool saw and a record that states what those
observations mean perform different jobs.

An **observation** reports a measured repository state or event tied to its
receipt and analysis limits. Examples include a resolved symbol reference, a
content hash, or a gate transition. It does not by itself assert that an
artifact is obsolete, that a change is incomplete, or that an action is
required.

A **claim** states a conclusion whose truth depends on observations and
reasoning. Examples include `this symbol has no consumers`, `this artifact is
suspected residue`, or `this change is complete`. Its defining responsibility
is to identify the observations and analysis contract that warrant it.

The mental model is a photograph and a conclusion drawn from it. The photograph
records what was visible under stated conditions. The conclusion may be sound,
but it is not part of the photograph.

Decision settled: make observation and claim distinct record roles. Every
claim must identify its supporting observations; an observation cannot inherit
a claim's action or authority merely because they travel in one evidence
context.

#### Next choice: claim versus completion obligation

A claim says what the evidence establishes. A completion obligation says that a
current consequence must receive a disposition before the governing goal can
close. A claim can be warranted and still remain advisory; truth does not by
itself decide workflow priority or blocking authority.

The mental model is a diagnosis and a release-blocking checklist item. The
diagnosis may be correct without automatically stopping the release. A
governing rule must connect that diagnosis to the release goal.

Decision settled: make completion obligation a distinct record role created
only by an explicit promotion contract. The obligation identifies its source
claim, the goal it protects, the policy or authorized decision that makes the
consequence blocking, and the evidence/coverage threshold that the claim met.
Detector output alone cannot create blocking authority unless a declared policy
grants that detector and claim class such authority.

#### Next choice: decision as a distinct role

A decision selects an authorized treatment for an existing claim or obligation.
Examples include suppressing a detector claim, retaining a compatibility path,
invalidating an obligation after its premise is defeated, or carrying an
obligation into a successor change.

The decision does not change what was observed, make the original claim
unwritten, or erase that an obligation once blocked completion. It adds a
governed consequence.

The mental model is a diagnosis and a treatment decision. Choosing treatment
does not alter the test result or pretend the diagnosis was never made.

Decision settled: make decision a distinct record role. Every decision
identifies its subject, deciding authority, controlled reason, supporting
evidence, policy version, and invalidation conditions. Suppression and
disposition become decision types rather than edits to the claim or obligation
record.

#### Next choice: goal as a distinct role

A goal states the future repository condition that authorized work is intended
to make true. It gives completion claims their comparison target and gives
completion obligations the end they protect.

The goal does not assert that the condition already holds, prescribe every
implementation step, or become whatever the current code happens to suggest.
It records its deciding authority, version, parent goal when one exists, and
explicit revisions.

The mental model is a destination card. Observations say where the repository
is; claims interpret that position; obligations identify unresolved
consequences; the goal says where the work is supposed to arrive.

Decision settled: make goal a distinct record role. Every completion claim and
completion obligation references the exact goal version it evaluates. A
checkpoint retains the larger unfinished goal instead of replacing it with the
smaller condition reached so far.

#### Next choice: canonical goal record versus plan-owned goal

The goal is the destination; a plan is one proposed or selected route to it.
Plans may be rewritten, split, or replaced while the destination remains the
same. Therefore the plan should not own the canonical goal.

Decision settled: store the goal as an independent structured record with a
stable goal ID and version. A plan references that ID and version in
machine-readable metadata and displays the exact goal condition for humans.
scip-query either generates that display or validates it against the canonical
record so the two cannot silently drift.

Completion claims, obligations, checkpoints, and successor plans all reference
the same goal version. Changing the destination creates an authorized goal
revision and a new version; editing plan prose cannot revise it implicitly.
The exact directory and frontmatter field names remain slice-local schema
choices.

The mental model is a destination card stored separately from route maps.
Replacing a route map does not move the destination.

This requires a goal-aware skill contract. Planning skills create or reuse the
canonical goal before producing a plan. Editing skills carry its exact ID and
version rather than inferring a destination from the current diff. Verification
skills evaluate the resulting repository state against that same version.
Exploration and diagnostic skills may supply observations or claims, but do not
silently replace the governing goal.

#### Next choice: authority of a model-written goal

Writing down a goal and authorizing it are different acts. The model may encode
an active goal when it is faithfully recording an explicit user instruction,
accepted issue, or repository policy and preserves that source as provenance.
When it reconstructs a possible goal from code, conversation, or surrounding
evidence, the record should remain proposed until an authorized goal owner
accepts it.

The model's confidence cannot create authority. Acceptance promotes a proposed
goal to active; later destination changes create authorized revisions rather
than silent edits.

The mental model is a clerk preparing a destination card. The clerk may copy an
already authorized destination, but writing a plausible destination does not
give the clerk the power to choose it.

Decision settled: a model may create an active goal only by faithfully encoding
an explicit user instruction, accepted work item, or repository policy and
preserving that source. A goal inferred or reconstructed from other evidence
remains proposed until an authorized owner accepts it. Model confidence cannot
promote it.

#### Next choice: disagreement among authorized goal sources

An explicit user instruction, an accepted issue or plan, and a checked-in
repository policy can each legitimately constrain the intended destination, but
they do not necessarily have identical authority or scope. If their
requirements conflict, silently choosing one would make the active goal
ambiguous even though every input was explicit.

Recommendation: repository policy supplies the durable boundaries within which
work is allowed; the user's current instruction selects the change-specific
destination inside those boundaries; accepted work items contribute
requirements and context unless the user explicitly revises them. A genuine
conflict that this relationship cannot resolve keeps the goal proposed and
records the conflicting requirements for an authorized owner.

The mental model is a trip with traffic law, today's requested destination, and
an earlier itinerary. The itinerary helps describe the trip, but neither it nor
the destination silently suspends the traffic law.

Decision settled: apply each instruction according to its scope and the
authority behind it rather than assigning every source a fixed rank. Repository
policy supplies durable boundaries; the current request selects the
change-specific destination; accepted work items supply existing requirements
and context. An authorized instruction may explicitly revise an earlier source.
A conflict this relationship cannot resolve leaves the goal proposed.

#### Next choice: necessary consequence versus changed destination

Repository evidence can reveal work the request did not name. Updating a public
symbol, for example, can require changes to consumers, tests, documentation, or
configuration for the requested outcome to become true. These are newly
discovered consequences of the same destination, not automatically new goals.

Recommendation: the system may make a requirement explicit without goal-owner
approval when current evidence establishes that the requirement is necessary
for the authorized repository condition. If the new requirement changes the
intended users, behavior, compatibility promise, scope boundary, or accepted
tradeoff, it changes the destination and must become a proposed goal revision.
Uncertain necessity produces a claim for adjudication rather than automatic
goal expansion.

The mental model is discovering that the only bridge to an already authorized
destination is damaged. Repairing or avoiding the bridge may be necessary to
arrive; choosing a different destination is not.

Decision settled: evidence-established necessities may be incorporated under
the current goal. A requirement that changes intended behavior, beneficiaries,
compatibility, scope, or accepted tradeoffs becomes a proposed goal revision.
Uncertain necessity becomes a claim for adjudication rather than automatic
scope expansion.

#### Next choice: minimum content of an active goal

The consequence-versus-revision rule can work only if the active goal identifies
the destination's meaningful boundary. A sentence such as “improve the API” is
too vague to show whether compatibility work is required or whether a behavior
change is permitted.

The initial recommendation of three mandatory sections is rejected as too
heavy. A goal that restates the implementation, plan, evidence procedure, or
task list would make writing the code the cheaper source of truth.

Revised recommendation: require one short clause naming the observable
destination. Add a preservation clause or exclusion clause only when omitting
it would change a reasonable completion judgment. Every phrase must change what
would count as complete. Implementation steps belong in the plan; discovered
consequences belong in obligations; proof belongs in evidence records. Identity,
version, and source are tool-managed metadata.

Suggested human form:

> Make `<observable repository condition>` true, while preserving `<material
condition>`, excluding `<material non-goal>`.

Only the first clause is required. The mental model is a label on a destination,
not the turn-by-turn directions for reaching it.

Gherkin is a scenario notation that identifies a starting situation, an event,
and the observable result through `Given`, `When`, and `Then` steps. It is
excellent for concrete behavior examples, but a complete scenario usually
contains more detail than the destination itself and multiple scenarios can
turn a concise goal into a test specification.

Recommendation: keep the canonical goal as the short outcome statement. Allow
optional Gherkin scenarios to clarify disputed boundaries or provide
verification examples. The scenarios reference the goal version but do not
replace it. A Gherkin `Feature` title may display the goal, while its scenarios
live with the plan or verification evidence.

Decision settled: the concise Gherkin `Feature` line is the canonical goal.
`Given`/`When`/`Then` scenarios are optional supporting examples rather than
mandatory goal content.

#### Next choice: authority of an attached Gherkin scenario

An attached scenario can either constrain completion or merely illustrate what
the goal author had in mind. Mixing those meanings would make a passing
completion judgment depend on how a reader happened to interpret the example.

Recommendation: every scenario attached to the canonical goal is required but
non-exhaustive. The completed repository must satisfy each scenario, but
satisfying every listed scenario does not prove the broader `Feature` goal.
Adding, removing, or changing an attached scenario therefore creates a new goal
version. Non-binding illustrations belong in ordinary documentation rather
than the canonical goal record.

The mental model is a contract with concrete cases. Every included case must be
honored, but the contract still governs cases it did not enumerate.

Decision settled: every Gherkin scenario attached to the canonical goal is
required but non-exhaustive. Completion must satisfy each attached scenario,
but satisfying all scenarios does not by itself establish the broader feature.
Changing the attached scenarios creates a new goal version; non-binding
illustrations remain ordinary documentation.

#### Risks

1. **Incomplete content identity.** A fingerprint limited to tracked source can
   miss staged, unstaged, untracked, generated, submodule, symlink, file-mode,
   or repository configuration inputs that affect an answer.
2. **History-dependent disagreement.** Two clones can contain the same files
   while one is shallow, has different reachable history, or lacks commits
   used by co-change and doc-drift analysis.
3. **Environment-dependent disagreement.** Dependency installations,
   toolchains, environment variables, filesystem case behavior, and external
   workspace packages can make identical repository content produce different
   semantic or checker results.
4. **Path-dependent behavior.** Absolute-path configuration, symlink layout,
   nested-project discovery, and linked-worktree placement can affect an
   analysis even when file content matches.
5. **Lineage and governance ambiguity.** Forks, mirrors, remote URL changes,
   and rewritten history make a remote URL or current commit insufficient as a
   universal logical-project or collaboration-domain identity.
6. **Wrong mutation target.** A finding produced in one clone can be
   mechanically applicable to another content-identical clone while still
   referring operationally to the first workspace. Losing workspace identity
   can direct a later edit, suppression, or stored obligation to the wrong
   checkout.
7. **Observation races.** A clone can change after its content identity is
   computed but before or during analysis. A matching old fingerprint then
   appears current when the command did not hold one stable observation.
8. **Privacy and fingerprinting.** Stable repository or remote identifiers can
   disclose project identity across logs. Raw paths and remotes can reveal
   local or proprietary information.
9. **Canonicalization defects.** Different path ordering, case normalization,
   line endings, file modes, or hash-input schemas can make equal states hash
   differently or unequal states appear equal.

#### Guardrails

Avoid one universal `same repository` comparison. Provide named compatibility
relations:

- **Lineage-compatible:** the observations concern the same logical repository
  history.
- **Content-compatible:** every repository-owned input relevant to the claim
  has the same canonical identity.
- **Workspace-identical:** the observations were made in the same concrete
  checkout or linked worktree.
- **Analysis-compatible:** the manifest shows that the capabilities, history
  coverage, toolchain, configuration, and analysis limits required by the
  conclusion are compatible.
- **Completion-authoritative:** the observation is current for the workspace
  whose completion claim is being decided and has sufficient authority and
  analysis coverage for that claim.

Completion authority is stronger than content compatibility. Cross-clone
evidence can be reused when content and required analysis context are
compatible, but the final completion decision should include an observation
of the target workspace or a mechanical proof that the target still has the
same relevant state.

Additional safeguards:

- include every repository-owned input that can alter the relevant answer, not
  merely committed source;
- represent Git-history coverage in the manifest for history-derived claims;
- represent environment, toolchain, dependency, and filesystem-sensitive
  capability in the manifest rather than pretending they are repository
  content;
- retain origin workspace identity on mutations, suppressions, and obligations
  even when the durable records belong to a shared collaboration domain;
- compute receipts under an evidence lease that detects state changes during
  the observation;
- use versioned canonicalization and cryptographic hashing; and
- expose opaque identities rather than raw paths, remotes, or content.

#### Why collaboration identity precedes lineage derivation

The ultimate problem is preventing an agent from using evidence about the
wrong evolving software project while still allowing code and durable
decisions made on different branches and checkouts to converge. Cross-clone
reuse and record merging are valuable only when scip-query can recognize one
shared decision domain without confusing that fact with same workspace, same
content, same ancestry, or same analysis conditions.

Collaboration-domain identity answers `which shared body of project decisions
is this record intended to join?` Repository lineage answers `which continuing
code history did this observation descend from?` Neither establishes that two
worktrees have the same files, that two analyses used the same capabilities,
or that either result is current enough to prove completion.

Use a manuscript as the mental model:

- collaboration domain is the group jointly deciding what the book will say;
- repository lineage is the continuing history of that book's drafts;
- a workspace instance is one physical copy on an editor's desk;
- repository-content identity is the exact draft in that copy;
- an index generation is a table of contents made from that draft;
- the analysis manifest records how the editor inspected it; and
- a completion claim concerns one exact draft in one target copy.

Two editors can hold identical drafts of the same book. Their copies remain
different physical objects. Two different books can also contain identical
pages temporarily; content equality alone does not make them one continuing
work. Repository lineage supplies the continuing-work identity that content
hashes and checkout paths cannot.

The collaboration-domain question controls:

- whether records from clones and linked worktrees can be grouped as knowledge
  about one project;
- whether suppressions, obligations, and outcome history may transfer across
  workspace instances;
- whether cross-clone cache and evidence reuse is even considered; and
- whether a stored completion record is later attributed to the correct
  project.

If collaboration identity is too narrow, branches and contributor forks
fragment one project's durable knowledge. If it is too broad, decisions leak
into independently governed derivatives. The next choice therefore concerns
how scip-query represents the shared decision-and-merge domain. Exact Git
lineage derivation remains a separate later question.

#### Remaining decision

The layered identity model and collaboration rule are settled: use a committed
collaboration-domain identifier inherited by branches, clones, linked
worktrees, and pull-request-intended forks, with deliberate detachment when a
derivative becomes independently governed.

After that, the derivation of repository lineage identity remains open.
Candidates include explicit repository configuration, Git-object ancestry,
normalized remote identity, or a composed identity with declared confidence.
The comparison must not treat a remote URL as proof that two histories,
collaboration domains, or projects are equivalent.

---

## 6. Pre-implementation clarification register

This register contains every currently known decision that must be settled,
clarified, or explicitly deferred before implementation can be called ready.
Implementation may reveal new facts and therefore new questions; `complete`
here means complete against the present review, not immune to later knowledge.

### 6.1 Status and timing

| Status      | Meaning                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| Settled     | The collaborative discussion has selected a conclusion and recorded its basis                           |
| Provisional | A recommendation exists, but its consequences or owner have not yet been accepted                       |
| Open        | More reasoning or evidence is required                                                                  |
| Slice-local | The decision does not block the whole program but must be settled before the named implementation slice |

Two readiness gates prevent opposite planning failures:

- **Program gate:** settle the small set of shared meanings and public
  invariants that every implementation slice would otherwise guess
  differently.
- **Slice gate:** settle local schema, interaction, detector, migration, and
  validation choices immediately before the slice that needs them.

Requiring every slice-local detail before any code would manufacture decisions
without implementation evidence. Starting code before the program gate would
let incompatible local decisions harden into public contracts.

### 6.2 Program gate — required before production implementation

| ID    | Decision                                                                                   | Status                                                                                                                  | Why every slice depends on it                                                                                         |
| ----- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| PG-01 | Three-layer product identity                                                               | Settled                                                                                                                 | Determines whether evidence, reasoning, and completion are one product or unrelated capabilities                      |
| PG-02 | Repository-change completeness                                                             | Settled                                                                                                                 | Defines the state the product is trying to establish                                                                  |
| PG-03 | Checkpoint versus full change completeness                                                 | Settled                                                                                                                 | Prevents staged work from being mislabeled as final completion                                                        |
| PG-04 | Residue adjudication principle                                                             | Settled                                                                                                                 | Establishes that strong ambiguity blocks an unsupported completion claim without asserting automatic defect certainty |
| PG-05 | Separation of repository state, completion evidence, completion claim, and completion gate | Settled                                                                                                                 | Prevents implementation from equating a report, assertion, and actual state                                           |
| PG-06 | Observation receipt boundary                                                               | Settled                                                                                                                 | Option C: one self-contained evidence context containing a compact authority receipt and separate analysis manifest   |
| PG-07 | Independent claim-metadata dimensions                                                      | Settled: five independent qualifications                                                                                | Determines how every command represents provenance, coverage, validation, and action strength                         |
| PG-08 | Completion-obligation lifecycle                                                            | Settled: active with three substantive exits                                                                            | Determines how unresolved consequences are created, carried, adjudicated, invalidated, and closed                     |
| PG-09 | Product kernel boundary                                                                    | Settled: stable core with contract-bound extensions                                                                     | Determines which modules own the contracts above and which capabilities are extensions                                |
| PG-10 | Compatibility and rollout principle                                                        | Settled: versioned, additive, evidence-gated rollout                                                                    | Determines whether new contracts are additive, versioned, advisory-first, or immediately blocking                     |
| PG-11 | Mission-level outcome claim to test                                                        | Settled as a pre-trial hypothesis covering completion quality, architecture conformance, elapsed time, and model tokens | Determines the trial design and the strongest public promise the product may make                                     |
| PG-12 | Decision ownership                                                                         | Settled: product, repository/task, and delegated agent authority remain separate; no runtime approval                   | Determines who can ratify definitions, certification states, blocking policy, and exceptions                          |
| PG-13 | Autonomous execution and protected evaluation                                              | Settled: persistent condition-triggered loop with immutable governing versions and validated transitions                | Determines whether the agent can sustain work without approval while remaining unable to weaken its own success test  |

The program gate does not require final field names, every residue detector, or
the completed trial corpus. It requires enough agreement that those details
will implement one system rather than several locally plausible systems.

### 6.3 Mission, beneficiary, and scope

| ID   | Clarification required                                                                                                                                                 | Status                                                                                   | Needed before                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------- |
| M-01 | Ratify the three-layer mission statement as the normative product goal                                                                                                 | Settled in discussion; not yet adopted in product docs                                   | Any public behavior change       |
| M-02 | Rank beneficiaries when agent speed, maintainer clarity, repository coherence, and compatibility conflict                                                              | Settled: non-flat constraint-and-outcome rule                                            | Program gate                     |
| M-03 | Decide which artifact supplies the authoritative change goal: user request, accepted plan, issue, repository policy, or an ordered combination                         | Settled: scope-and-authority relationship                                                | Completion-control design        |
| M-04 | Define how a change goal may be refined when repository evidence reveals necessary consequences absent from the request                                                | Settled: consequence-versus-revision rule                                                | Completion-control design        |
| M-05 | Define the boundary between causal consequences of a change and unrelated pre-existing debt                                                                            | Settled: evidenced causal or goal-blocking relation                                      | Residue and gate policy          |
| M-06 | Decide whether completeness covers only repository-owned state or also required data migrations, generated artifacts, deployment configuration, and external contracts | Settled: layered repository and overall completion                                       | Completeness contract            |
| M-07 | State which agent workflows the mission covers: local edits, refactors, migrations, feature work, cleanup, incident repair, and multi-stage programs                   | Mission includes long-sustained autonomous work; exact trial corpus open                 | Trial corpus and public identity |
| M-08 | State which language/capability combinations may receive completeness claims rather than navigation-only claims                                                        | Open                                                                                     | Trial corpus and public identity |
| M-09 | Decide whether humans and scripts are secondary beneficiaries under the same contract or distinct product surfaces                                                     | Agent is the primary operator; exact secondary surfaces open                             | Kernel and public API design     |
| M-10 | Define the conditions under which a narrower user request may legitimately override a broader repository-coherence recommendation                                      | Open                                                                                     | Gate adjudication                |
| M-11 | Decide whether routine execution, remediation, suppression, sequencing, or completion requires a human approval                                                        | Settled: no routine human approval inside the control loop                               | Program gate                     |
| M-12 | Define the agent's standing authority when several implementation outcomes satisfy the authorized goal                                                                 | Settled: ordered constraint, coherence, reversibility, and efficiency rule               | Autonomy envelope                |
| M-13 | Define the persistent work state required to survive context loss, restarts, failed attempts, and multi-stage execution                                                | Persistent state required in principle; exact contracts open                             | Completion-control design        |
| M-14 | Define which success criteria and evaluation artifacts the working agent may modify, and how modified criteria receive independent validation                          | Settled at program level: editable working layer under immutable governing versions      | Protected evaluation standard    |
| M-15 | Define autonomous rules for suppression, baseline change, goal refinement, exception handling, and unresolved authority boundaries                                     | Settled at program level: pre-authorized validated transitions or loud unresolved result | Autonomy and gate policy         |

### 6.4 Completeness boundary and vocabulary

| ID   | Clarification required                                                                                                                                              | Status                                                                                       | Needed before                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------- |
| C-01 | Repository-change completeness definition                                                                                                                           | Settled                                                                                      |
| C-02 | Necessary state conditions: goal satisfaction, integration, supersession, explanation, and coherence                                                                | Settled after compatibility, migration, variant, residue, and external-state referent checks | Program gate                      |
| C-03 | Checkpoint and full change completeness distinction                                                                                                                 | Settled                                                                                      |
| C-04 | Decide whether a safe intermediate state needs a distinct public status or only internal program state                                                              | Open                                                                                         | Completion interaction design     |
| C-05 | Define what makes an intentionally retained compatibility path a current purpose rather than residue                                                                | Settled: four-part current-purpose evidence                                                  | Residue adjudication              |
| C-06 | Define what makes two implementations legitimate variants rather than conflicting accounts of one concept                                                           | Settled: explicit selection and shared-contract rule                                         | Residue adjudication              |
| C-07 | Define how intentionally deferred work affects checkpoint and full completion claims                                                                                | Settled: checkpoint-only with preserved obligation                                           | Completion-obligation lifecycle   |
| C-08 | Define whether a known relevant obligation can ever be excluded from the current goal without making the goal itself narrower                                       | Settled: three explicit truth-preserving causes                                              | Goal and gate policy              |
| C-09 | Define how unknown external consumers affect completeness for public APIs                                                                                           | Open                                                                                         | Evidence and compatibility design |
| C-10 | Define the repository-coherence observations that are mechanically checkable and those that require authorized agent judgment                                       | Open                                                                                         | Residue model                     |
| C-11 | Decide the public vocabulary for `complete`, `checkpoint complete`, `incomplete`, `unresolved`, `not analyzed`, and `unsupported`                                   | Open                                                                                         | Output and hook design            |
| C-12 | Define how newly discovered facts revise an earlier completion judgment and whether the historical claim remains recorded as justified-at-the-time or becomes false | Open                                                                                         | Outcome and event records         |

### 6.5 Repository residue

| ID   | Clarification required                                                                                                                                                                                                           | Status  | Needed before                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------- |
| R-01 | Repository-residue definition                                                                                                                                                                                                    | Settled |
| R-02 | Build a referent taxonomy: superseded implementation, stale contract, obsolete configuration, misleading test, historical documentation presented as current, dormant registration, compatibility path, and conceptual duplicate | Open    | Residue detector planning        |
| R-03 | Identify evidence that establishes an artifact's current role                                                                                                                                                                    | Open    | Adjudication design              |
| R-04 | Identify evidence that establishes supersession rather than mere similarity or disuse                                                                                                                                            | Open    | Detector design                  |
| R-05 | Separate mechanically detected residue from agent-raised suspicion and policy-backed architectural judgment                                                                                                                      | Open    | Claim metadata                   |
| R-06 | Set the threshold that changes an advisory residue signal into a blocking unresolved completion obligation                                                                                                                       | Open    | Gate design                      |
| R-07 | Define the allowed dispositions: removed, migrated, current-role-established, compatibility-retained, intentional-variant, deferred-under-checkpoint, false signal                                                               | Open    | Obligation schema                |
| R-08 | Define the evidence each disposition requires and what later changes invalidate it                                                                                                                                               | Open    | Obligation schema                |
| R-09 | Decide whether residue dispositions use suppression records, a new obligation ledger, or a shared adjudication record with distinct outcome types                                                                                | Open    | Storage design                   |
| R-10 | Define expiry and revalidation for compatibility and intentional-variant decisions                                                                                                                                               | Open    | Storage and gate design          |
| R-11 | Define false-positive tolerances separately for advisory and blocking residue paths                                                                                                                                              | Open    | Calibration and rollout          |
| R-12 | Choose the first languages and frameworks for which residue detection can support blocking behavior                                                                                                                              | Open    | Rollout and trial design         |
| R-13 | Decide how Git history contributes without treating age or prior wiring as proof of current intent                                                                                                                               | Open    | Detector design                  |
| R-14 | Decide how tests and docs count as current-role evidence without letting self-consistent obsolete artifacts validate one another                                                                                                 | Open    | Detector and adjudication design |

### 6.6 Observation authority and receipts

| ID   | Clarification required                                                                                                                | Status                                                                                           | Needed before                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------- |
| A-01 | Compact compatibility receipt versus one self-contained audit manifest                                                                | Settled: nested self-contained context                                                           | Program gate                 |
| A-02 | Exact project identity and behavior across clones, symlinks, nested projects, and linked worktrees                                    | Layered model and collaboration rule settled; current mapping audited; lineage derivation open   | TODO-1 schema                |
| A-03 | Exact dirty-worktree identity, including staged, unstaged, untracked, renamed, and ignored inputs that can affect an answer           | Hybrid form, content set, and fixed-snapshot principle settled; canonical encoding open          | TODO-1 schema                |
| A-04 | Index-generation identity and the proof that it aligns with the observed worktree                                                     | Exact versioned index-input equality settled; canonical encoding and migration mechanics open    | TODO-1 implementation        |
| A-05 | Authority kinds and which conclusions each kind can support                                                                           | Independent dimensions, central derivation, and use-time lifecycle settled; exact judgments open | TODO-1 schema                |
| A-06 | Which commands are evidence-producing and therefore require receipts                                                                  | Semantic rule, current inventory, and operation-specific descriptor roles settled                | TODO-1 command inventory     |
| A-07 | Whether human output hides, summarizes, or always prints authority                                                                    | Layered compact summary, prominent limitations, and explicit full-detail view settled            | TODO-1 interaction design    |
| A-08 | Whether `--result-only` is explicitly non-authoritative or gains an optional sidecar mechanism                                        | Open                                                                                             | TODO-1 compatibility design  |
| A-09 | How output pagination preserves one original receipt across every page                                                                | Principle settled; exact contract open                                                           | TODO-1 pagination changes    |
| A-10 | How receipt comparison handles index-only, worktree-only, unknown, and process-local observations                                     | Named three-valued relationships and fail-closed completion settled; exact API mapping open      | TODO-1 comparison API        |
| A-11 | Which edits invalidate prior results and whether any unaffected-result proof is worth implementing                                    | Open                                                                                             | Completion control           |
| A-12 | How long-running commands react when worktree identity changes during execution                                                       | Principle settled: fixed snapshot or lower authority; detected change invalidates; retry UX open | TODO-1 runtime behavior      |
| A-13 | How legacy envelopes without receipts decode and what conclusions they may support                                                    | Additive lower-authority migration required; exact decoder contract open                         | TODO-1 migration             |
| A-14 | Whether receipts expose sensitive paths or content-derived identifiers and what must be hashed or omitted                             | Open                                                                                             | TODO-1 schema                |
| A-15 | Which receipt fields are public compatibility commitments and which remain diagnostic                                                 | Open                                                                                             | TODO-1 API review            |
| A-16 | Whether one committed collaboration-domain ID is inherited by merge-intended forks and explicitly replaced by independent derivatives | Settled: yes                                                                                     | TODO-1 schema and migration  |
| A-17 | Which records are durable shared project knowledge versus temporary session or branch-local state                                     | Settled: independent scope, role, and lifecycle                                                  | Record schema and workflow   |
| A-18 | How merged records are revalidated, made inactive, or escalated against the target branch                                             | Principle settled; exact contract open                                                           | Gate and storage design      |
| A-19 | Whether scope, role, and lifecycle are universal fields, type-owned meanings, or a shared taxonomy with type contracts                | Settled: shared taxonomy with type contracts                                                     | Record schema                |
| A-20 | Whether one intended code change is a first-class persistence scope between workspace and collaboration history                       | Settled: yes                                                                                     | Record schema and workflow   |
| A-21 | How one intended change keeps a stable identity across branch renames, rebases, worktrees, and contributor forks                      | Settled: generated opaque ID                                                                     | Record schema and workflow   |
| A-22 | How active change-scoped records are reconciled when the change merges                                                                | Settled: explicit closure dispositions                                                           | Completion and record gates  |
| A-23 | What evidence is required before a change-scoped record may be marked fulfilled                                                       | Settled: type-specific satisfaction contract                                                     | Completion and record gates  |
| A-24 | What must exist before an unfinished record may be carried forward                                                                    | Settled: linked active destination record                                                        | Completion and record gates  |
| A-25 | Whether historical-only is a substantive disposition or a resulting inactive retention state                                          | Settled: resulting inactive state only                                                           | Completion and record gates  |
| A-26 | What evidence may invalidate an active completion obligation                                                                          | Settled: factual defeat or authorized goal revision                                              | Completion and record gates  |
| A-27 | Complete persistence-scope value set                                                                                                  | Settled: invocation, local, change, collaboration history                                        | Record schema and storage    |
| A-28 | Whether records reporting observations remain distinct from records stating conclusions                                               | Settled: distinct observation and claim roles                                                    | Record role schema           |
| A-29 | Whether a completion obligation is distinct from its source claim and requires explicit promotion                                     | Settled: explicit policy-governed promotion                                                      | Record role and gate schema  |
| A-30 | Whether a decision is distinct from the claim or obligation whose treatment it governs                                                | Settled: distinct decision role                                                                  | Record role schema           |
| A-31 | Whether the governing change goal is a distinct role referenced by obligations and completion claims                                  | Settled: distinct versioned goal role                                                            | Record role schema           |
| A-32 | Whether the canonical goal is independent of plan documents and referenced by stable ID/version                                       | Settled: independent canonical goal record                                                       | Goal and plan schemas        |
| A-33 | When a model-written goal is active rather than proposed                                                                              | Settled: explicit-authority rule                                                                 | Goal lifecycle and skills    |
| A-34 | How conflicting authorized goal sources determine one governing goal                                                                  | Settled: scope-and-authority relationship                                                        | Goal lifecycle and skills    |
| A-35 | When evidence exposes a necessary consequence rather than a changed destination                                                       | Settled: consequence-versus-revision rule                                                        | Goal lifecycle and planning  |
| A-36 | Minimum explicit content required for an active goal                                                                                  | Settled: canonical Feature line plus optional scenarios                                          | Goal schema and skills       |
| A-37 | Authority of Gherkin scenarios attached to the canonical goal                                                                         | Settled: required but non-exhaustive                                                             | Goal schema and verification |

### 6.7 Claim meaning and evidence manifest

| ID   | Clarification required                                                                                                                                   | Status                                             | Needed before              |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------- |
| E-01 | Ratify independent dimensions for origin, coverage, validation status, action tier, and authority                                                        | Settled: five independent qualifications           | Program gate               |
| E-02 | Define the evidence-origin taxonomy and its language-specific extensions                                                                                 | Open                                               | TODO-2 schema              |
| E-03 | Decide which metadata belongs per invocation, per result family, and per row                                                                             | Open; row-level origin recommended for mixed paths | TODO-2 schema              |
| E-04 | Define how mixed-origin results aggregate without hiding the weakest or most decision-relevant path                                                      | Open                                               | TODO-2 rendering           |
| E-05 | Retain or revise complete, bounded, sampled, and unknown coverage semantics                                                                              | Existing contract strong; review required          | TODO-2 compatibility       |
| E-06 | Define certification states, their truth rules, and the corpus/version/language cell to which each attaches                                              | Open                                               | TODO-2 validation registry |
| E-07 | Decide who owns certification changes and what evidence permits promotion or demotion                                                                    | Open                                               | Decision ownership         |
| E-08 | Define action tiers for facts, signals, unresolved obligations, and direct repair evidence                                                               | Open                                               | Residue and gate design    |
| E-09 | Separate `claim`, `finding`, `recommendation`, `completion obligation`, and `gate outcome` in schemas and wording                                        | Open                                               | TODO-2 and gate design     |
| E-10 | Decide whether numeric confidence is useful anywhere or whether categorical qualification is the honest maximum                                          | Open                                               | TODO-2 schema              |
| E-11 | Bind capability state to the exact row/family whose meaning depends on it                                                                                | Open                                               | TODO-2 schema              |
| E-12 | Define fallback labeling so source and textual paths remain useful without inheriting compiler-backed wording                                            | Open                                               | TODO-2 implementation      |
| E-13 | Define compatibility semantics for legacy `graph-fact`, `heuristic`, and `mixed` consumers                                                               | Open                                               | TODO-2 migration           |
| E-14 | Choose the single generated registry or contract source that keeps runtime output, validation records, docs, and public API classifications synchronized | Open                                               | TODO-2 architecture        |
| E-15 | Decide how much evidence metadata appears in ordinary agent-readable output without recreating JSON noise                                                | Open                                               | TODO-2 interaction design  |

### 6.8 Completion obligations and gate behavior

| ID   | Clarification required                                                                                                                     | Status                                                   | Needed before               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | --------------------------- |
| G-01 | Define a completion obligation as a current, unresolved consequence that must receive a disposition before the relevant goal can close     | Provisional definition                                   | Program gate                |
| G-02 | Define which producers may create obligations: exact checks, qualified detectors, agent reasoning, repository policy, or humans            | Open                                                     | Gate design                 |
| G-03 | Define blocking thresholds by evidence origin, validation status, action tier, and coverage                                                | Open                                                     | Gate policy                 |
| G-04 | Define gate outcomes for pass, pass-with-adjudications, checkpoint, unresolved, not-analyzed, unsupported, and infrastructure failure      | Open                                                     | Output schema               |
| G-05 | Decide whether missing required capability blocks completion or narrows the claim with an explicit unsupported dimension                   | Open                                                     | Gate policy                 |
| G-06 | Define automated adjudication requirements and behavior when authority is absent                                                           | Program principle settled; checker contracts slice-local | Gate policy                 |
| G-07 | Separate suppression of a detector proposal from disposition of a real completion obligation                                               | Open                                                     | Storage and wording         |
| G-08 | Define out-of-band authorized revision, required reason/evidence, visibility, and invalidation                                             | Program principle settled; storage contract slice-local  | Governance and storage      |
| G-09 | Define when an agent may challenge the goal or residue premise rather than merely accepting the obligation                                 | Open                                                     | Interaction design          |
| G-10 | Decide where obligations live across commands, compaction, sessions, branches, worktrees, and agents                                       | Open                                                     | Storage design              |
| G-11 | Define concurrency behavior when evidence or code changes while an obligation is being adjudicated                                         | Open                                                     | Runtime design              |
| G-12 | Define how checkpoints preserve larger unfinished goals and temporary-role expiry                                                          | Open                                                     | Checkpoint implementation   |
| G-13 | Define recheck rules after the agent edits code in response to a finding                                                                   | Open                                                     | Gate lifecycle              |
| G-14 | Prevent infinite completion loops when a detector repeatedly emits an already adjudicated equivalent finding                               | Open                                                     | Gate lifecycle              |
| G-15 | Define what is durable repository knowledge versus local session state                                                                     | Open                                                     | Kernel and storage boundary |
| G-16 | Define what evidence the final completion report must preserve for a future agent to understand why the repository was considered coherent | Open                                                     | Completion report           |

### 6.9 Mission-level outcome validation

| ID   | Clarification required                                                                                                                                                          | Status                                       | Needed before        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------- |
| V-01 | State the exact causal claim: which agents improve, on which tasks, under which capabilities, relative to what control                                                          | Controlled-comparison hypothesis recommended | TODO-3 protocol      |
| V-02 | Choose task families representing impact, reuse, migration, residue, legitimate variants, documentation, and clean controls                                                     | Open                                         | TODO-3 corpus        |
| V-03 | Define the control condition: native search and project checks, current agent workflow without scip-query, or another explicit baseline                                         | Open                                         | TODO-3 protocol      |
| V-04 | Build task ground truth independently of scip-query's own detectors                                                                                                             | Open                                         | TODO-3 corpus        |
| V-05 | Define primary outcomes: missed consumers, reintroduced behavior, residue left behind, declared architecture violations, incorrect blocking, regression, and completion quality | Open                                         | TODO-3 protocol      |
| V-06 | Define secondary costs: elapsed time, tool calls, model tokens, human review load, and false-obligation handling                                                                | Open                                         | TODO-3 protocol      |
| V-07 | Choose models, agent configurations, repetitions, and task randomization needed to separate tool effect from run variance                                                       | Open                                         | TODO-3 protocol      |
| V-08 | Stratify results by language, repository shape, capability state, and task family                                                                                               | Open                                         | TODO-3 analysis      |
| V-09 | Define evaluator independence and blinded scoring where practical                                                                                                               | Open                                         | TODO-3 protocol      |
| V-10 | Choose success, harm, and inconclusive thresholds before observing results                                                                                                      | Open                                         | TODO-3 protocol      |
| V-11 | Preserve receipts, manifests, tool traces, edits, completion rationales, and checker outcomes without leaking sensitive repository data                                         | Open                                         | TODO-3 records       |
| V-12 | Define how failed or negative trials narrow the mission, alter blocking policy, or demote a detector                                                                            | Open                                         | TODO-3 decision rule |
| V-13 | Decide when evidence is sufficient for private use, default-on use, or a public outcome claim                                                                                   | Open                                         | Rollout and identity |
| V-14 | Decide how and when the trial corpus is renewed as models, repositories, and detectors change                                                                                   | Open                                         | Ongoing governance   |

### 6.10 Health and effectiveness surfaces

| ID   | Clarification required                                                                                         | Status                                       | Needed before          |
| ---- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------- |
| H-01 | Identify the concrete user decision the health surface is intended to support                                  | Open                                         | TODO-4 purpose         |
| H-02 | Decide whether the current scalar is renamed, demoted, or removed                                              | Open                                         | TODO-4 design          |
| H-03 | Define the relationship between active detector pressure and repository-change completeness                    | Open                                         | TODO-4 concept         |
| H-04 | Show repair, adjudication, capability change, and detector-version change as distinct causes of score movement | Open                                         | TODO-4 schema          |
| H-05 | Decide how suppressions and obligation dispositions appear without treating all as debt or all as absence      | Open                                         | TODO-4 schema          |
| H-06 | Define behavior when analysis is bounded, unavailable, unsupported, or incomparable with a prior run           | Open                                         | TODO-4 schema          |
| H-07 | Version metric families and decide which local trends remain comparable                                        | Open                                         | TODO-4 compatibility   |
| H-08 | Decide whether a completion-oriented summary replaces or accompanies repository-wide pressure reporting        | Open                                         | TODO-4 product surface |
| H-09 | Keep local-writable effectiveness telemetry distinct from independent evaluation                               | Settled in principle; output review required | TODO-4 wording         |
| H-10 | Decide what baseline records mean after detector, capability, or evidence-contract changes                     | Open                                         | TODO-4 migration       |

### 6.11 Product kernel and extension boundary

| ID   | Clarification required                                                                                                                                                                                                 | Status                                                   | Needed before         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------- |
| K-01 | Ratify kernel responsibilities: identity, freshness, capability, entity resolution, evidence products, claim metadata, architecture conformance, planning context, completion obligations, receipts, and compatibility | Settled conceptually; architecture addition under review | TODO-5 architecture   |
| K-02 | Define extension responsibilities and the contract every detector or language enrichment must satisfy                                                                                                                  | Open                                                     | TODO-5 architecture   |
| K-03 | Classify every command and public query export as kernel, extension, operational support, or compatibility surface                                                                                                     | Open                                                     | TODO-5 inventory      |
| K-04 | Decide which direct query exports are intentional public contracts and which are accidental internals                                                                                                                  | Open                                                     | TODO-5 API plan       |
| K-05 | Decide whether separation is conceptual/module-level, package-level, or both                                                                                                                                           | Open                                                     | TODO-5 design         |
| K-06 | Define architecture checks that prevent extensions from bypassing authority, provenance, coverage, and action contracts                                                                                                | Open                                                     | TODO-5 enforcement    |
| K-07 | Decide the primary agent workflow surface and how specialist commands remain discoverable without dominating the product model                                                                                         | Open                                                     | TODO-5 interaction    |
| K-08 | Place health, TLA+ tooling, setup/release machinery, framework analyzers, and repair automation explicitly                                                                                                             | Open                                                     | TODO-5 classification |
| K-09 | Assign ownership for the kernel contract and for extension certification                                                                                                                                               | Open                                                     | Decision ownership    |
| K-10 | Define backward-compatible deprecation and generation for any surface being compressed                                                                                                                                 | Open                                                     | TODO-5 migration      |

### 6.12 Public identity and interaction

| ID   | Clarification required                                                                                                                             | Status                                          | Needed before          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------- |
| I-01 | Final one-sentence public identity                                                                                                                 | Provisional mission statement exists            | TODO-6                 |
| I-02 | Decide which outcome promises are mechanism-based aspirations and which are trial-established claims                                               | Open                                            | TODO-6 after TODO-3    |
| I-03 | Explain completeness without implying perfection, universal detection, or replacement of tests/review                                              | Open                                            | TODO-6                 |
| I-04 | Explain evidence, reasoning, and completion as cumulative layers rather than competing products                                                    | Settled conceptually                            | TODO-6                 |
| I-05 | Express language support through indexing, semantic, fallback, detector, and checker capabilities rather than one language-agnostic strength claim | Settled in principle                            | TODO-6                 |
| I-06 | Decide what ordinary human, agent, script, CI, and library consumers each see                                                                      | Agent is primary; exact secondary surfaces open | TODO-1, TODO-2, TODO-6 |
| I-07 | Align README, package metadata, CLI help, setup, skills, generated command docs, schemas, and examples                                             | Open implementation inventory                   | TODO-6                 |
| I-08 | Decide how checkpoint, unresolved obligation, and full completion appear in hooks and agent instructions                                           | Open                                            | Completion interaction |
| I-09 | Define failure messages that distinguish incomplete repository state from unavailable or stale evidence                                            | Open                                            | Completion interaction |
| I-10 | Avoid calling scip-query an oracle while still making its stopping authority clear                                                                 | Settled principle; wording open                 | TODO-6                 |

### 6.13 Compatibility, rollout, and governance

| ID   | Clarification required                                                                                                              | Status                                                                                        | Needed before              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------- |
| L-01 | Decide schema-version strategy for receipts, manifests, obligations, and gate outcomes                                              | Open                                                                                          | First public schema change |
| L-02 | Define compatibility behavior for legacy envelopes, events, suppressions, baselines, and integrations                               | Open                                                                                          | First migration slice      |
| L-03 | Choose implementation slices and their dependency order after program-gate decisions settle                                         | Open                                                                                          | Implementation plan        |
| L-04 | Decide which new checks begin advisory and what evidence permits promotion to blocking                                              | Open                                                                                          | Rollout plan               |
| L-05 | Define rollback behavior when new blocking policy creates unacceptable false obligations                                            | Open                                                                                          | Rollout plan               |
| L-06 | Decide opt-in, opt-out, and repository-policy controls without letting configuration silently erase completion meaning              | Open                                                                                          | Rollout and config design  |
| L-07 | Define telemetry that shows receipt incompatibility, obligation creation, adjudication, recurrence, and gate outcomes               | Open                                                                                          | Rollout observability      |
| L-08 | Decide whether old suppressions are migrated, grandfathered as unknown-authority decisions, or require re-adjudication              | Open                                                                                          | Storage migration          |
| L-09 | Define documentation, generated-schema, public-API, mutation-test, and outcome-test requirements for every slice                    | Open                                                                                          | Implementation plan        |
| L-10 | Protect self-hosting development from a new gate that depends on its own unfinished implementation                                  | Open                                                                                          | Rollout sequencing         |
| O-01 | Name who ratifies the mission and completeness definitions                                                                          | Settled: scip-query product policy, adopted by repository policy                              | Program gate               |
| O-02 | Name who may change certification state and blocking thresholds                                                                     | Settled: released product policy; repositories choose permitted action within shared meanings | Program gate               |
| O-03 | Name who may issue or override durable residue dispositions                                                                         | Settled: repository/task authority or an agent acting through its pre-authorized policy       | Gate governance            |
| O-04 | Define where normative decisions live and how later revisions preserve their history                                                | Settled: versioned product and repository records with immutable prior evaluations            | Program gate               |
| O-05 | Define periodic review triggers: model changes, detector changes, capability changes, false-obligation incidents, and trial renewal | Open                                                                                          | Ongoing operation          |

### 6.14 Readiness summaries

#### Before any production implementation

The following must be settled:

1. PG-07: independent claim-metadata dimensions;
2. PG-08: completion-obligation lifecycle at the concept and policy level;
3. PG-09: kernel ownership boundary;
4. PG-10: compatibility and advisory-to-blocking rollout principle;
5. PG-11: the mission-level outcome claim to test;
6. PG-12: owners for normative and blocking decisions;
7. PG-13: the autonomous execution and protected-evaluation contract;
8. M-02 through M-06: beneficiary conflicts, goal authority, consequence
   discovery, debt boundary, and repository/external scope; and
9. C-05 through C-08: intentional retention, legitimate variants, deferral,
   and goal narrowing.

Current readiness:

- the program gate is closed;
- remaining open entries are slice gates or trial-protocol decisions; and
- the first automatic-evidence slice is complete, and the receipt-version-2
  slice may proceed under the compatibility, performance, and validation
  contract in
  `docs/plans/2026-07-30-autonomous-completion-program.md`.

#### Before receipt-version-2 implementation

Settle A-01 through A-15, plus the applicable parts of L-01 and L-02.

#### Before TODO-2 implementation

Settle E-01 through E-15 and the residue distinctions R-03 through R-08.

#### Before completion-control implementation

Settle G-01 through G-16, checkpoint representation, and the durable
repository-versus-session boundary.

#### Before TODO-3 outcome runs

Settle V-01 through V-13. Corpus construction may begin before every protocol
detail is final, but scoring thresholds and causal claims must be fixed before
observing comparative results.

#### Before TODO-4 implementation

Settle H-01 through H-10. The name follows the decision the surface supports;
it should not be chosen first.

#### Before TODO-5 implementation

Settle K-01 through K-10. Inventory can begin earlier because it is read-only
evidence for the boundary decision.

#### Before TODO-6 final wording

Settle I-01 through I-10 after the kernel and outcome claims are known. Obvious
stale identity text can be marked earlier, but final wording should not
prejudge the trial.

---

## 7. Decision dependency map

| Decision                  | Depends on                      | Unlocks                                              |
| ------------------------- | ------------------------------- | ---------------------------------------------------- |
| Three-layer identity      | —                               | Mission statement, kernel role, outcome standard     |
| Completeness definition   | Three-layer identity            | Completion policy, residue model, trial outcomes     |
| Residue adjudication      | Completeness definition         | Action tiers, suppression policy, gate behavior      |
| Checkpoint completeness   | Completeness definition         | Multi-stage migration and session-state design       |
| Observation receipt scope | Completion evidence distinction | Common envelope implementation                       |
| Claim metadata            | Receipt boundary                | Health vocabulary, trial records, residue thresholds |
| Outcome protocol          | Claim metadata and receipt      | Warranted public product claims                      |

---

## 8. Next implementation decision

Define the generated operation-role registry and receipt-version-2 schema,
comparison results, authority derivation, and version-1 migration at the slice
boundary. Architecture enforcement is already settled as a core,
repository-declared completion behavior and measured mission outcome.
