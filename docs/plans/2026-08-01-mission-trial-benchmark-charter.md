# Mission-trial benchmark charter

Date: 2026-08-01
Status: live — causal boundaries settled; two calibration pairs exposed product and apparatus defects; counted thresholds remain open
Parent notes: [scip-query epistemic redesign](../reviews/2026-07-30-epistemic-clarification-notes.md)
Supersedes for future efficacy execution: [protected-trial remediation runner](./2026-07-31-autonomous-completion-trial-remediation.md)

## Proprietary fixture boundary

The Vega-specific trial apparatus remains outside this repository in a private,
access-controlled location. Do not commit the Vega runner, source snapshot,
fixture archive, hidden evaluator, task prompt, candidate transcript, candidate
patch, or protected result artifacts to `scip-query`.

This repository can contain the generic trial protocol, public record schemas,
and redacted aggregate conclusions. A public record must use content identities
and non-sensitive descriptions. It must not disclose proprietary source paths,
symbol names, assertions, repository structure, or implementation details.

## Decision served

Decide whether giving an otherwise matched coding agent scip-query evidence
improves its account of a repository change, the completeness of the resulting
implementation, or the effectiveness of final verification enough to justify
the added model-token and elapsed-time cost.

The benchmark does not decide whether scip-query is universally useful, whether
one detector is intrinsically correct, or whether a fifteen-minute task proves
multi-hour autonomous persistence.

## Benchmark standard

The benchmark serves a repository team that delegates coding work to an
autonomous agent. The team needs completed changes that preserve current
behavior, obey repository policy, and leave one coherent design behind. The
agent also needs a workflow that lets it finish without routine human approval
or avoidable tool work.

The alternatives are the same coding agent with normal repository tools and
the same agent with the released scip-query workflow. A hypothetical perfect
agent is not part of the comparison.

The standards are ranked in this order:

1. repository-change completeness and freedom from regression;
2. autonomous progress without false blocking or a weakened goal;
3. model-token and elapsed-time cost at the same completion level; and
4. adoption cost, measured separately from task execution.

The product target is adaptive advantage, not a win on every stochastic run.
The treatment must avoid a material completion regression in each supported
workflow class. It must add little cost when compiler-resolved evidence cannot
change the work. It must produce a repeatable quality or cost gain when
repository relationships, retirement, architecture, or persistent work state
matter.

This standard does not support the claim that scip-query improves every
possible coding task. A finite benchmark cannot establish that universal
claim. It can establish bounded results for named task families and show
whether the product routes low-value work away from expensive machinery.

Every counted program fixes its task families, completion predicates, false
finding policy, cost tolerance, model, runtime, and repetitions before it
observes candidate results. Calibration runs may set numerical tolerances, but
their results do not count toward the later claim.

## Adaptive workflow classes

A workflow class is a group of repository changes that require the same kind
of evidence and work-state coordination to reach completion. Diff size and
expected duration are observations, but neither one selects the class alone.
A small public API removal can require more repository reasoning than a large
internal mechanical edit.

### Direct change

A direct change has one known local target, a clear effect, and no discovered
retirement, public-surface, architecture, or cross-consumer consequence. It can
finish in one edit and review cycle without a durable plan. scip-query must stay
quiet unless new evidence raises the class.

Examples include a local message correction, a narrow test expectation update,
and an internal implementation edit with a proven bounded consumer set.

### Relational change

A relational change requires repository relationships to select or verify the
correct work. The relationships can include consumers, re-exports, injected
implementations, ownership, compatibility, retirement, or architecture. It
uses one concise change contract and normally finishes as one coherent slice.

Examples include a public symbol migration, a responsibility transfer, a
shared-policy reuse, and a change that crosses a configured boundary.

### Sustained change

A sustained change cannot safely complete in one bounded reasoning context.
It has multiple independently verifiable slices, or it must preserve decisions
and obligations across agent sessions. It uses one stable goal, an ordered
slice plan, and persistent work state. Each slice must leave the repository in
a valid stated checkpoint.

Examples include a multi-stage migration, a repository-wide subsystem
replacement, and a change that requires several dependent integration steps.

Retirement, public compatibility, architecture, data migration, security, and
durability are workflow modifiers. A modifier activates its evidence and gate
rules even when the source diff is small. The workflow can move to a stronger
class when it discovers new consequences. It cannot move to a weaker class
without evidence that defeats the earlier consequence.

This classification keeps the workflow light by default. It also prevents a
large line count from becoming a false proxy for reasoning difficulty.

## Goal, plan, and completion contract

The concise Gherkin `Feature` line remains the authorized destination.
Attached scenarios give required behavior examples. Gherkin does not identify
the symbols, consumers, or residue that the repository contains.

For a relational or sustained change, the agent writes a readable plan in a
fixed scip-query plan directory. One machine-readable contract inside that
plan records:

- the stable goal identity and version;
- affected symbol or artifact seeds and their current roles;
- behavior and policy that must remain true;
- responsibilities, identities, and artifacts that must be retired;
- any artifact that may remain, with its authorizing source and current role;
- architecture and public-surface obligations; and
- direct evidence that can establish each completion condition.

An affected seed is a compiler-resolved symbol or named repository artifact
from which scip-query can find a wider relationship set. A retirement closure
is the set of consumers, exports, aliases, configuration, tests,
documentation, and architecture declarations reached from a retirement seed
by declared evidence rules.

The plan lists the artifacts that the agent currently expects to change. This
list is a supported prediction, not the authority that defines completeness.
An omitted artifact remains a defect when the goal and repository evidence
make it consequential. New evidence can add an obligation through an
append-only plan revision.

The tool resolves plan references against a fixed observation and writes the
derived goal, intended change, plan, and obligation records. New work carries
the concise goal and intended change inside the same plan contract. Existing
work references their stable identities. The agent must not type duplicate
request files. One plan action must create or update the required records, or
the action is too ceremonial for the default workflow.

Direct changes do not require this contract. The contract becomes required
when the agent or the tool discovers a relational or sustained-change trigger.

## Low-ceremony retirement verification

Repository residue cannot be identified from an artifact alone. The same
alias can be obsolete residue in one change and an authorized compatibility
path in another. A blocking retirement result therefore needs all three of
these inputs:

1. authorized intent that names the superseded responsibility or identity;
2. repository evidence that connects current artifacts to that target; and
3. an authorized current role for each connected artifact that remains.

The plan can identify retirement seeds and expected artifacts. It cannot give
itself permission to preserve an old identity when the goal requires full
retirement. Compatibility permission must come from the goal, repository
policy, or an earlier delegated decision rule.

At plan freeze, scip-query expands each retirement seed across compiler
references, callers, aliases, re-exports, and public surface. It also records
related configuration, tests, documentation terms, and architecture entries
that normal source search can identify. The record includes the observation
identity and the coverage limit for each producer.

At Stop, scip-query updates only evidence affected by the change. It blocks a
clean completion result when:

- a must-retire symbol or behavior remains reachable;
- an alias, wrapper, or re-export preserves a retired public identity;
- old-only configuration, tests, documentation, or architecture entries still
  communicate the superseded design;
- a claimed compatibility path has no authorized source or current consumer;
  or
- a required index, health baseline, or evidence producer is absent.

A definite contradiction with authorized retirement blocks completion. A
possible residue with incomplete semantic evidence requires an agent decision:
remove it, or record its supported current role. An unsupported assertion does
not satisfy that requirement. A supported intentional survivor is allowed and
remains visible as an obligation with its owner and removal condition, when a
removal condition applies.

This design does not require Stop to solve arbitrary intent from code. It gives
Stop a narrow contract and makes the tool discover the repository closure. The
agent supplies one useful planning decision rather than a detector checklist.

## Public mission form

```gherkin
Feature: A repository change reaches coherent completion

  Scenario: The requested behavior replaces an existing responsibility
    Given a repository with current behavior and declared structural rules
    When an agent implements the requested behavior and retires the superseded responsibility
    Then the requested behavior works
    And applicable existing behavior remains true
    And every consequentially affected artifact has one coherent current role
```

Attached scenarios are required but non-exhaustive. They state observable
outcomes and preservation boundaries; they do not name the expected files,
symbols, abstraction, or historical patch unless that shape is itself an
authorized requirement.

## Claims under test

### C1 — repository evidence to plan

For the named fixture, model, runtime, budget, and planning condition,
scip-query causes the frozen pre-edit plan to identify more necessary
repository relationships, or identify them at lower cost, than the declared
native baseline.

The observation is the immutable plan plus its pre-edit transcript. Tokens are
cost; correct supported relationships are evidence of understanding.

### C2 — plan to implementation

For the named conditions, a SCIP-informed plan or integrated SCIP exploration
causes a more complete pre-verification repository state than the matched
baseline.

Two tests remain distinct:

- same-agent continuation measures the integrated exploration-to-edit process;
- fresh-agent handoff measures whether the plan itself is sufficient.

Neither result may be relabeled as the other.

### C3 — verification lift

For the named candidate states and equal review budget, SCIP findings cause
more consequential completion defects to be correctly repaired than native
self-review, without unacceptable false findings or introduced regressions.

The observation is the difference between the frozen pre-review state and the
frozen post-review state. Raw finding volume is not an outcome.

### C4 — integrated workflow

Only after C1 through C3 are separately observable may a later comparison test
the shipped evidence-to-plan-to-verify workflow as one product bundle. A bundle
result establishes the bundle's effect under its scope; it does not identify
which component caused the effect.

## Required condition equality

Every matched pair uses identical:

- base repository source, fixed predecessor, and all non-SCIP content;
- user-visible mission and Gherkin scenarios;
- provider, model, reasoning effort, runtime, and output contract;
- non-SCIP repository instructions and ordinary tools;
- dependency snapshot and candidate readiness standard;
- measured candidate budget;
- silent measurement evaluator; and
- artifact and telemetry capture.

The condition record names the one intended difference. Any additional
difference either creates a different experiment or invalidates the pair.

The first comparison measures work in a repository that already adopted
scip-query. The control repository contains no scip-query executable, skill,
hook, instruction, configuration, baseline, or index. The treatment repository
contains the complete released setup. The runner prepares both repositories
before measured agent work. The recorded condition manifest names every setup
difference.

The runner creates the treatment with the same public setup path that a
repository adopter uses. It does not use task-specific hidden facts. Before it
starts the candidate clock, it must make sure that:

- dependencies and ordinary project checks are ready in both conditions;
- the treatment index is fresh for the prepared source state;
- all released skills, instructions, and lifecycle hooks are installed;
- the exact hooks are trusted and a lifecycle probe succeeds;
- the shared health baseline exists and the architecture ratchet reports its
  check as active rather than skipped;
- the prepared treatment worktree is clean;
- the control cannot access scip-query through its path, skills, instructions,
  hooks, configuration, caches, or inherited agent home; and
- all non-product repository bytes that define the task are identical.

For a generated clean fixture, the runner runs released setup, writes the
shared baseline with `scip-query health --write-baseline`, commits the prepared
repository state, and refreshes the final index. This baseline records the
pre-task repository. The candidate cannot rewrite it and count that rewrite as
successful verification.

Setup, indexing, baseline creation, dependency preparation, and hook trust are
adoption work. They remain outside the task clock. The runner records their
cost separately because adoption cost still matters to product use. A failed
precondition invalidates the pair; it does not become candidate inefficiency.

This comparison measures the delivered product bundle. It does not isolate the
effect of CLI access from the effects of skills, repository instructions,
hooks, or completion control.

Two legitimate planning comparisons answer different questions:

1. **Product planning condition:** native agent workflow versus the shipped
   SCIP planning skill and CLI. This measures the delivered planning bundle.
2. **CLI attribution condition:** one shared neutral planning protocol, with
   only compiler-resolved SCIP commands added to treatment. This narrows causal
   attribution to tool access.

Results from these conditions remain separate.

## Benchmark program

The benchmark uses a task-family matrix instead of one large task. Each row
tests a different product claim:

| Task family | Main observation | Expected product behavior |
| --- | --- | --- |
| Direct local change | completion and fixed overhead | stay quiet and remain non-inferior |
| Nonlocal relationship discovery | frozen plan and pre-review state | find consequential consumers and ownership |
| Supersession and retirement | plan, pre-review residue, and Stop findings | remove old responsibilities or justify current survivors |
| Architecture temptation | dependency edges and repair | prevent or repair a forbidden structural choice |
| Seeded review defect | pre-review to post-review change | produce true actionable findings without solution knowledge |
| Sustained sliced change | checkpoint continuity and final completion | preserve the goal, decisions, and obligations across sessions |

The first four families use integrated candidate tasks. The seeded review
family starts both review conditions from the same frozen repository state.
It varies retired aliases, stale configuration, forbidden edges, duplicated
policy, and benign look-alikes. This isolates verifier sensitivity and false
blocking from the chance that one implementation creates a particular defect.

The treatment verifier receives only the authorized goal, released repository
evidence, and released policy. It does not receive the hidden evaluator facts
or a list of injected defects. A seeded defect is fair only when a normal
adopted repository gives the product enough observable evidence to find it.

The sustained family uses short resumable slices instead of one day-long run.
The runner resets the agent context between selected slices while preserving
only the repository and released persistent work records. This tests whether
the records carry the work instead of testing one model context window.

An integrated bundle result remains necessary before a release claim, but it
comes after the component rows. A component failure states which product
capability needs work. A bundle failure alone cannot identify that cause.

## Phase boundaries and artifacts

### Planning

- No source, test, configuration, or documentation edit is permitted.
- The candidate writes one `plan.md` artifact before the phase ends.
- The runner freezes the plan and the transcript at the first edit boundary.
- Later plan revisions are append-only decisions naming the contrary evidence;
  they do not rewrite what the agent knew before editing.

The plan is scored for correct supported coverage of:

- entry-to-effect flow;
- affected consumers and producers;
- existing ownership and reuse candidates;
- behavior and policy that must remain true;
- superseded behavior and residue to retire;
- configured architecture constraints; and
- implementation and verification obligations.

### Implementation

- Discovery experiment: the diff gate and protected repair feedback remain
  disabled in both conditions.
- The runner freezes the complete tracked, deleted, renamed, and untracked
  candidate state before review.
- Outcome scoring at this point measures planning and implementation, not
  verification.

### Review and repair

- Both conditions receive the same additional time.
- Control performs native self-review with its ordinary repository tools.
- Treatment receives only findings produced by the released SCIP verifier and
  may repair them.
- A silent SCIP pass may inspect the control result after completion for
  analysis, but its findings are never shown to the control candidate.
- Both post-review states are frozen and evaluated symmetrically.

## Evaluation boundary

A measurement evaluator is a silent scoring system whose distinguishing
characteristic is that it observes both finished candidate states without
changing either candidate's next action. It may use hidden behavioral tests,
declared architecture, and an independently fixed repository-fact set. It must
accept every implementation that satisfies the goal and constraints; it may
not compare candidates with one answer patch.

An in-run verifier is released product evidence capable of changing the
working candidate's next action. It may use the authorized goal, compiler
graph, configured architecture, detectors, diff, and ordinary project checks.
It may not receive hidden evaluator implementation, hidden assertion details,
or solution-specific conclusions unavailable to a normal adopted repository.

Ground truth is fixed before candidate outcomes are observed. When historical
work informs a task, the evaluator is reconstructed from behavior and
repository relationships at the predecessor, then reviewed for alternative
valid implementations. The historical patch is neither a scoring template nor
candidate feedback.

## Outcomes and costs

Primary outcomes:

- required repository-relationship coverage in the frozen plan;
- unsupported or false plan claims;
- goal satisfaction;
- preserved behavior and invariants;
- missed affected artifacts;
- superseded behavior or misleading residue left behind;
- new violations of active architecture rules;
- regressions and false blocking; and
- consequential true findings correctly repaired.

Secondary costs:

- uncached model tokens by phase;
- elapsed time by phase;
- tool calls and SCIP commands by phase;
- rediscovery after plan handoff;
- failed or repeated attempts; and
- review and repair cost.

Cost never substitutes for quality. Compare cost only at named quality levels,
or report the quality/cost tradeoff without compressing it into one score.

## Runtime contract

- No candidate receives more than fifteen measured minutes in one routine
  component trial.
- The candidate prompt and repository do not disclose the time limit, remaining
  time, benchmark condition, comparison, or protected evaluator.
- The first pilot uses OpenAI `gpt-5.6-luna` with `max` reasoning effort.
- Matched conditions may execute concurrently in independent workspaces,
  Codex homes, temporary directories, dependency write locations, SCIP caches,
  and lifecycle state.
- Setup, indexing, dependency preparation, and readiness occur before measured
  execution because an adopted repository already has them.
- Candidate execution, project tests requested by the candidate, review, and
  in-run verification count toward the applicable phase budget.
- Concurrent elapsed time is secondary evidence on a shared machine unless
  resource isolation or counterbalanced reruns show that contention is not
  driving the difference.
- Tokens, phase outcomes, and final repository state remain primary local
  observations.

## Compact generated fixture option

A compact generated fixture is a small real compiler-indexed repository whose
source graph and independent scoring facts are produced together from a fixed
generator input. Its distinguishing characteristic is that necessary
relationships are mechanically known without prescribing one implementation.

It is fair when:

- generator code and thresholds are frozen before candidate runs;
- each counted fixture uses a new recorded random seed;
- identifiers, file layout, re-export paths, and nonessential topology vary by
  seed;
- the task exposes behavior and constraints, not the seed manifest or answer;
- both candidates receive identical repository bytes;
- ground truth describes actual consumers, ownership, retirement facts, and
  allowed architecture rather than one patch;
- baseline and at least one independently constructed valid implementation
  pass the evaluator; and
- native tests, type checking, lint, architecture checks, and SCIP indexing
  complete quickly enough that agent work dominates the budget.

Useful task families include:

1. a semantic impact change crossing aliases, re-exports, or same-named
   symbols that text search can confuse;
2. a supersession change where the old path remains technically live and must
   be retired or explicitly retained; and
3. a behaviorally tempting edit that would create a forbidden dependency or
   duplicate an existing responsibility.

Procedural variation reduces designer and model familiarity with one exact
shape. It does not prove transfer to production repositories, so generated
results must later be checked against real-repository fixtures.

### Pilot apparatus status — 2026-08-01

The first private generated fixture and silent evaluator now pass apparatus
preflight. The unchanged repository passes its existing project checks but
fails the requested migration. Two structurally different valid
implementations pass every required predicate. Intentionally narrow,
duplicated-policy, forbidden-dependency, retained-residue, and unrelated-edit
states fail the relevant predicates. The released `scip-query architecture`
command agrees with the evaluator on both permitted and forbidden dependency
states.

This establishes that the pilot can distinguish the tested repository states.
It is not a candidate result and supplies no evidence that scip-query improves
agent work. The private generator, fact manifest, assertions, solution
variants, and evaluator remain outside this repository.

### First app-server pair — 2026-08-01

The first matched OpenAI `gpt-5.6-luna` Max pair completed through isolated
Codex app-server sessions. The app-server fired the actual Stop hooks. Each
condition's first Stop blocked completion, returned feedback to the same agent,
and allowed a second Stop only after that agent continued. Repository setup,
indexing, hook discovery, and exact hook-hash trust occurred before measured
candidate work.

The raw evaluator result was unfavorable to the shipped scip-query condition:

| Observation | Native control | Shipped scip-query condition |
| --- | ---: | ---: |
| Frozen pre-review predicates | 11/11 | 9/11 |
| Final predicates | 11/11 | 9/11 |
| Frozen plan facts recognized by the current scorer | 6 | 8 |
| Measured elapsed time | 319,372 ms | 612,900 ms |
| Total model-token processing | 462,492 | 1,209,009 |
| Uncached model tokens | 82,076 | 130,993 |
| Tool calls | 34 | 78 |
| scip-query commands | 0 | 26 |

Both candidates implemented the requested runtime behavior for every known
consumer. The control also fully retired the old responsibility. The
scip-query candidate deliberately retained the old public identity as a
compatibility alias. That alias remained reachable and misleading even though
its implementation now delegated to the new policy. Independent inspection
also found obsolete architecture-configuration entries for a deleted boundary.

A later authority audit found a fixture contradiction. The repository
instructions said `Preserve public exports`, while the task required full
retirement and the evaluator required deletion of one legacy public export.
The fixture did not state which instruction controlled that overlap. The
treatment followed the general repository rule. The control followed the task
retirement clause. Therefore, the retained alias is not evidence of an
unsupported treatment requirement. It is evidence that the fixture left the
compatibility decision ambiguous.

Neither review phase changed a repository file. The scip-query Stop path did
not identify the retained compatibility alias. It reported only that the
architecture check was skipped because the prepared treatment lacked a diff
architecture baseline. The runner had used the setup path that skipped the
optional full health pass. Future pairs must prepare that baseline outside
measured execution so the full released architecture gate is active.

The treatment plan named more repository facts and preserved the obsolete
public name. The current plan scorer rewarded fact mentions without recording
the conflict between task retirement and repository compatibility policy.
Future plan scoring must represent authority and conflicting obligations, not
only fact coverage.

This pair remains an exact local observation of the two candidate states and
their cost. The authority contradiction and missing baseline make it invalid
for a counted product-effectiveness claim. It establishes these diagnostic
targets:

- add a lightweight route that avoids full autonomous ceremony for compact
  changes;
- make the fixture state that explicit task retirement controls a public
  identity whose only role is the retired responsibility;
- make retirement intent override inferred compatibility unless the goal or
  repository contract authorizes that compatibility;
- detect reachable compatibility aliases and stale architecture declarations
  as possible supersession residue;
- make goal and change creation direct enough that an agent does not abandon
  them after help and schema discovery;
- make Stop report a material semantic gap instead of allowing a clean gate
  over a behaviorally correct but incomplete migration; and
- score contradictory plan obligations and tool-specific configuration
  cleanup explicitly.

### Prepared-treatment repair — 2026-08-01

The private runner now uses non-interactive released setup with the full health
audit. It writes and commits `.scipquery-baseline.json`, refreshes the final
index, checks the baseline against the prepared repository, and uses a benign
temporary diff to prove that both `architecture` and `baseline` run in the
released diff gate.

Preflight `run-2026-08-01T18-11-47-589Z-319863` passed. The treatment had a
fresh TypeScript index, zero forbidden edges, zero unmapped architecture files,
and no skipped gate check. The apparatus suite passed 14 tests. One new test
proves that a committed baseline makes the released architecture ratchet block
a forbidden edge.

The setup report remains `partial` only because the isolated apparatus skips
global skill symlinks and parser installation. It supplies exact released
skills inside the candidate repository and proves all required TypeScript
capabilities. The condition manifest records these substitutions and all setup
cost outside the candidate clock.

The generated repository instructions now state that explicit task retirement
controls the general public-export preservation rule. An apparatus test fixes
that authority ordering. The corrected fixture is ready for another diagnostic
pair, but not yet for a counted effectiveness claim.

### Retry-policy calibration pair — 2026-08-01

Run `run-2026-08-01T19-03-41-642Z-19ffb6` completed one matched generated
retry-policy pair under the old evaluator. The control reached 9 of 11 old
predicates in 244,519 ms with 344,340 total model tokens, 53,012 uncached model
tokens, and 60 tool calls. The treatment reached 11 of 11 old predicates in
720,087 ms with 4,820,279 total model tokens, 192,311 uncached model tokens,
100 tool calls, and 53 scip-query commands. The treatment timed out before its
first Stop completed, so it produced no observation of gate-directed repair.

Those scores are invalid for product comparison. The old architecture
predicate required `.scipquery.json` even in the control condition, although
the hidden architecture report found no violation there. This scored the
absence of the treatment tool rather than the repository property. The old
evaluator also missed that the treatment copied the same delivery-outcome
effects into three application files while leaving the existing
`applyDeliveryOutcome` helper unused. The control routed all three consumers
through that helper and left one coherent effect authority.

The corrected evaluator now applies hidden repository architecture facts to
both conditions and requires tool configuration only when the condition began
with that configuration. It also requires one core outcome-effect authority
and rejects copied implementations. Two new mutation tests fix these rules;
the private apparatus now passes 18 tests. This is a scorer correction against
the pre-existing completeness standard, not a new success condition chosen
after seeing which candidate won.

The treatment did discover the reusable helper before editing. Its plan named
`src/kernel/delivery/apply-outcome.ts`, while system and planning evidence
surfaced `applyDeliveryOutcome`. It then called that refactor unrelated and
implemented parallel effects. The observed failure is therefore a planning
and reuse-decision failure after successful discovery, not proof that the SCIP
graph missed the relationship.

The transcript contained no context compaction. In one agent turn it invoked
the exact commands `status --capabilities` six times, `plan apply plan.md` four
times, `diff-gate` three times, `reindex` twice, and `diff-impact` twice. Several
retries followed changed inputs, but at least one status retry repeated the
same stale observation after only five seconds. The shipped workflow must make
new-work plan application one action and tell agents to reuse exact read-only
results until repository content, diff, index generation, command input, or
coverage need changes.

This pair is calibration evidence only. Its old result must not be rescored as
counted evidence. A new matched pair must run against the corrected product and
evaluator.

## Vega fixture option

Vega remains useful as a real-repository stress fixture after the component
protocol works. A replacement Vega mission must:

- fit the fifteen-minute candidate budget;
- require non-obvious relationship discovery rather than naming every consumer
  and abstraction;
- use targeted project checks whose runtime does not dominate candidate work;
- score behavior and repository consequences without requiring the historical
  patch; and
- preserve an already configured and indexed frozen fixture for both
  conditions.

The stopped panel-resize V21 program remains diagnostic apparatus evidence. It
does not resume as a counted run under this charter.

## Current Vega runner disposition

Preserve:

- content-identified fixture archives and program parameters;
- separate opaque candidate workspaces and Codex homes;
- dependency, hook, tool, and index readiness preflight;
- control isolation and candidate read/write confinement;
- transcript, patch, untracked-file, hook, and telemetry capture;
- immutable run records and explicit apparatus exclusions; and
- external symmetric outcome evaluation.

Replace:

- sequential condition execution with isolated concurrent pair execution;
- the forty-five-minute whole-run allowance with phase-specific ceilings no
  greater than fifteen measured minutes per candidate;
- the single full-workflow condition with explicit planning, implementation,
  review, and integrated-workflow condition types;
- mutable plan prose with an immutable pre-edit plan artifact;
- treatment-only protected evaluator feedback with released-product findings;
- final-state-only capture with pre-review and post-review snapshots;
- unbounded ordinary control closeout with equal-time native self-review;
- one solution-revealing historical task with several independently scored
  task families; and
- aggregate-run telemetry with tokens, elapsed time, and tool calls segmented
  at phase boundaries.

## Claims this protocol cannot support

- One successful fixture cannot establish general autonomous effectiveness.
- Repeated seeds of one generator estimate variation for that task family;
  they are not independent evidence across repository phenomena.
- A detector firing does not establish a useful finding until the finding is
  true, consequential, and correctly repairable.
- A fast incomplete candidate is not efficient completion.
- Fifteen-minute tasks do not establish multi-hour persistence.
- A shipped-bundle comparison does not isolate the CLI mechanism.
- A CLI-only comparison does not establish the full autonomous workflow.

## Open decisions before counted claims

- Whether the pilot's twelve-minute implementation and three-minute review
  split remains the routine component budget.
- Empirical precision of the released retirement rule across true residue and
  benign look-alikes. The rule is implemented, but one generated task cannot
  establish its transfer reliability.
- The next independently varied task families and their protected facts. They
  must separate discovery, retirement, architecture, verification lift, and
  sustained recovery rather than reuse one bundled task.
- Resource policy for interpreting parallel elapsed time.

Every candidate pair must pass the adopted-repository preflight that is now
implemented. The plan contract, workflow classes, condition-neutral scorer,
six-run family threshold, and harm rules are now fixed for the next run. No
product-effectiveness claim begins until a fresh corrected pair runs and the
named task family reaches its required repetitions.
