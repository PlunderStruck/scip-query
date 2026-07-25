# High-Assurance Planning

Load this only when the change meets a trigger in `SKILL.md` — security boundary, authorization,
money, destructive operation, persistent-data migration, shared-state concurrency, broad public
API change, irreversible rollout, or an explicit request for it. For ordinary work the protocol
here costs more than it protects, and its weight is why planning stopped happening at all.

A high-assurance plan is a **certificate**: a dated Markdown document whose conclusion — ready to
implement — is derived from numbered, source-cited premises, defended against constructed
counterexamples, and shaped so the intended behavior is easy to test before it is easy to ship.

## Rules

1. Define every load-bearing concept contextually and state every invariant in `iff` or
   `must always` form. A definition without referents (a `Source:` line) is a guess.
2. Evidence lives in numbered premises (`P1`, `P2`, ...), each naming the source appropriate to
   its claim. Literal source facts may cite a native file read; compiler-resolved identity and
   complete writer, reader, caller, dependency, consumer, or impact sets cite scip-query. Every
   shared-state surface the plan touches gets a state-authority premise enumerating its complete
   writer and reader sets.
3. Steps and defenses cite the premises they depend on. A claim no premise supports is either new
   evidence to gather or an explicit `ASSUMPTION` — never silent.
4. Do not propose a new helper, wrapper, type, parameter, config flag, component, hook, or module
   until the reuse audit proves reuse or extension is not the better move.
5. Every behavior-changing step includes a testability design: test seam, injected dependencies,
   pure core, side-effect boundary, and validation.
6. Attack entries must be constructed scenarios — actor, starting state, sequence — each ending in
   a recorded outcome: `HELD` citing the defending step and premises, or `HOLE` with its repair
   step or accepted reason. An assertion of absence ("no new shared mutable state") is not a
   defense; it cannot fail, so it cannot catch anything.
7. Installing an enforcer — trigger, constraint, guard, gate — opens an enforcement window: every
   existing writer in the relevant state-authority premise must be brought into compliance in the
   same or an earlier step, or the window recorded as an accepted hole. Every step declares
   `Deployable`.
8. The verdict is derived, not asserted: `PLANNED-COMPLETE` only when the coverage matrix has no
   blank rows and every attack ends in `HELD` with citations or an accepted hole. An attack record
   where nothing ever broke is a red flag — attacks run against a draft should find holes; if none
   did, rerun the pass as falsification, preferably in a fresh subagent context.

## Planning Terms

A **reuse audit** is the part of a plan that proves a proposed new symbol, file, option, wrapper,
or contract is needed; what makes it useful is that it ties the new shape to existing definitions,
consumers, and rejected extension points.

A **test seam** is the entry point a test can call to prove a behavior without replaying the whole
product path; what makes it valuable in a plan is that it names the exact unit or boundary where
correctness will be observed.

A **side-effect boundary** is the edge where deterministic program decisions meet files,
processes, clocks, networks, databases, or other external capabilities; what makes it important is
that failures and fakes can be isolated there while core decisions stay easy to test.

A **contract** is the stable promise one code unit exposes to another, including accepted inputs,
returned outputs, errors, timing expectations, and side effects that callers may rely on.

An **invariant** is a property of the changed system that must hold at every observable moment;
what makes it load-bearing is that attacks are judged against it and the final verdict is derived
from whether it survives them all.

A **premise** is a numbered, source-cited statement of fact about the current code; what makes it
a premise rather than a note is that steps and defenses cite it by ID, so a false premise is
traceable to everything built on it.

A **state-authority premise** is a premise that enumerates the complete writer and reader sets of
one shared state surface; what makes it powerful is that "complete" is falsifiable with `refs` and
`dataflow`, turning a forgotten write path from an unknowable into a checkable omission.

A **counterexample attack** is a concrete actor, starting state, and action sequence constructed
to violate an invariant; what makes it evidence is that its defense cites premises and steps, so
"we considered failure" becomes "this specific failure is blocked here."

An **enforcement window** is the interval between the step that installs an invariant enforcer and
the step that brings the last existing writer into compliance; what makes it dangerous is that
during it, every unupdated writer fails the new check in production, so the plan that adds safety
is itself the outage.

## Workflow

### 1. Discover

```bash
scip-query status --capabilities
scip-query plan-context <target>
```

Fill four gates before designing:

```markdown
## Goal

What the user is trying to accomplish and what done looks like for them.

## Definitions & Invariants

For each load-bearing concept: its wider class, then the one trait that causally
explains its other traits in this codebase — with the referents. Then the
invariants the change must preserve, in iff / must-always form.

## Current State

A short narrative of the affected end-to-end flow. Every factual sentence
cites a premise by ID.

## Reuse Audit

For every new symbol or file being considered: reuse target, extension target,
or evidence-backed reason new code is justified.
```

Definition discipline: place the concept in its wider class, then name the essential trait — the
one that makes the concept's other traits in this codebase possible and explains them. Do not
label genus or differentia; write it as prose. Ban circular and synonym definitions ("the refresh
coordinator coordinates refreshes" defines nothing). Any new term the plan introduces gets defined
the same way. Good definitions condense: they imply the concept's other traits instead of listing
them, and derived requirements fall out of them — if restore is defined as the inverse of cancel,
then the privilege to restore must not be weaker than the privilege to cancel, and a plan that
gates them asymmetrically must defend that asymmetry.

Complete only when the concepts are defined with referents, the invariants are stated formally,
and every proposed new unit has a reuse decision with citations.

### 2. Establish Premises

```markdown
## Premises

- P1. <current behavior fact> — Source: `scip-query code <symbol>`
- P2. Writers of `<state surface>`: <complete list>. Readers: <complete list>.
  — Source: `scip-query refs <symbol>` + `scip-query dataflow <symbol>`
- P3. ASSUMPTION: <belief the evidence cannot yet confirm, and what would confirm it>
```

State-authority rule: for every state surface the plan touches — database column, store field,
event topic, endpoint, cache entry — write one premise enumerating its complete writer and reader
sets. Completeness comes from `refs` and `dataflow`, not memory.

Why this premise class exists: a sprint-restore plan hardened `restore()` and the cancellation
path but never enumerated the writers of sprint status. Review found `PATCH /sprints/:id` could
set `status: 'active'` around every restore invariant, and transition automations wrote `sprintId`
straight past the new membership guard — two of that review's five ship-blockers, both sitting in
the writer list one `refs` call would have produced. With a state-authority premise, each writer
in the list must be visited by an attack; without it, the side doors are invisible until review.

Complete only when every state surface named in any phase has a state-authority premise and every
remaining unknown is an explicit `ASSUMPTION`.

### 3. Shape for Tests

```markdown
## Testability Design

| Behavior   | Test seam          | Dependencies to inject      | Pure core                       | Side-effect shell | Contract                        |
| ---------- | ------------------ | --------------------------- | ------------------------------- | ----------------- | ------------------------------- |
| <behavior> | <test entry point> | <clock/db/http/logger/etc.> | <calculation/decision function> | <I/O wrapper>     | <small interface or call shape> |
```

Plan the code so tests can call the pure core directly and exercise the side-effect shell with
injected replacements. Prefer this shape:

1. Parse and validate at the boundary.
2. Pass domain data and injected dependencies into a small orchestrator.
3. Put calculations, filtering, selection, formatting decisions, and state transitions in pure
   functions.
4. Keep database, network, filesystem, clock, randomness, logging, email, and payment calls in
   thin side-effect shells.
5. Depend on small contracts at boundaries; avoid broad option objects, booleans that hide
   behavior, and wrappers that merely forward.

Complete only when every changed behavior has a named test seam and the plan makes clear which
logic can be tested without real external services.

### 4. Design the Checklist

Write phases in execution order. Keep each phase deployable or explicitly mark why it is not.

```markdown
### N.M - Imperative title

- [ ] **File**: `path/to/file.ts:LINE-LINE`
- **Premises**: P<n>, P<m>
- **Deployable**: yes | no — <reason> | part of single-deploy group <name>
- **What**: Current behavior verified from source.
- **Change**: Exact edit to make.
- **Testability**:
  - Test seam:
  - Injected dependencies:
  - Pure core:
  - Side-effect shell:
  - Contract:
- **Validation**: Targeted test, smoke command, or manual check that proves the behavior.
- **Why**: Why this step is needed and why this order is safe, citing the premises it rests on.
```

If a step installs an enforcer, check its enforcement window here: every existing writer in the
relevant state-authority premise is brought into compliance in the same or an earlier step, or the
window is carried into the attack record as a hole to accept or repair.

Complete only when no checklist item says "update this file" without exact current behavior,
target behavior, cited premises, a deployability declaration, and validation.

### 5. Attack the Plan

Construct counterexamples against every invariant. This pass is falsification, not defense: it
succeeds by finding holes, and against a draft it should find some. Prefer delegating it to a
fresh subagent when the environment can spawn one — give the adversary only the Definitions &
Invariants, Premises, state-authority maps, and the checklist, not your design rationale, and
brief it that it wins by producing holes; fold its findings back as HOLE entries and repair steps.
Solo fallback: enumerate the full attack list from the coverage-matrix rows below before writing
any Outcome line, so attacks cannot be shaped around defenses you already have.

Use the lenses as attack prompts — purpose, blast radius, valid intermediate state, reversibility,
failure, concurrency, boundaries, data integrity, observability, human experience, efficiency,
reuse, testability — and record each attack in this form:

```markdown
### A<n>. <invariant> via <lens>

- Attack: <actor> + <starting state> + <action sequence>
- Outcome: HELD — defended by step <N.M> (P<i>, P<j>)
  | HOLE — repaired by new step <N.M>
  | HOLE — accepted: <reason>
```

A `HELD` that cannot name its defending step and premises is not `HELD`; it is a hole wearing
confidence. A repaired hole keeps its `HOLE — repaired by step N.M` label permanently — do not
rewrite it to `HELD` after the repair, because the repair history is the evidence that the pass
falsified. The verdict's repaired count must equal the number of `HOLE — repaired` entries.

Close the record with a coverage matrix — one row per writer in every state-authority premise and
per applicable lens (valid intermediate state is always applicable when any step installs an
enforcer or migration):

```markdown
| Surface or lens           | Attacks |
| ------------------------- | ------- |
| <writer, reader, or lens> | A2, A7  |
```

A blank row is an unattacked writer. The record is incomplete until every row names an attack or
carries an accepted reason. Spread attacks across rows before deepening one: depth on the axis you
already anticipated does not protect the axes you did not — the leaks come from blank rows, not
from the tenth variation of the race you already modeled.

Invalid entry — this exact shape preceded three post-review remediation rounds on a real plan:

> **Concurrency**: Validation happens before database writes; no new shared mutable state or retry
> behavior is introduced.

It names no actor, no interleaving, and cites nothing. It is an assertion of absence: it cannot
fail, so it caught nothing — review later found exactly the race it waved away. A valid entry for
the same phase:

> ### A3. "Every stored value is a member of its field's option set" via concurrency
>
> - Attack: admin removes option O in transaction A while a user writes value O in transaction B;
>   interleaving B-validates → A-commits → B-commits persists an orphaned value.
> - Outcome: HOLE — repaired by new step 2.2: validation reads the option definition outside B's
>   lock (P4), so serialize definition changes with every value writer via FOR UPDATE on the
>   definition row; regression proves both interleavings against PostgreSQL.

Complete only when the coverage matrix has no blank rows and every attack entry ends in a cited
`HELD` or a recorded `HOLE`.

### 6. Verify and Derive the Verdict

Run or delegate phase-by-phase reference checks. Each verifier confirms:

- every path exists;
- every line range is still within about five lines;
- every premise reproduces when its `Source` command is rerun — a premise that no longer
  reproduces is false, and everything citing it is suspect until fixed;
- every behavior claim matches source;
- every new unit has reuse evidence;
- every behavior-changing step has cited premises, a validation command, and a testability design.

Then rerun the source-producing context for the cited targets:

```bash
scip-query plan-context <target>
```

Use the shared reference for subagent briefing text when delegating. Close the plan by applying
the definitions to the record — do not summarize feelings:

```markdown
## Verdict

A plan is PLANNED-COMPLETE iff the coverage matrix has no blank rows, every
attack ends in HELD with cited steps and premises or an accepted hole with a
written reason, and no premise failed reverification.

Result: PLANNED-COMPLETE | INCOMPLETE — <n> attacks, <x> holes repaired,
<y> holes accepted; <unresolved items>
```

The counts are part of the verdict. "16 attacks, 0 holes repaired" against a fresh draft is not a
strong plan; it is an attack pass that defended instead of falsified — rerun it before shipping.

Complete only when stale references are fixed, every premise reverified, and the verdict line is
derived from the attack record.

## Output Shape

1. Title and date.
2. Goal.
3. Definitions & Invariants.
4. Premises (including state-authority premises and explicit assumptions).
5. Current State (narrative citing premise IDs).
6. Reuse Audit.
7. Testability Design.
8. Design Phases (steps citing premises, each with a deployability declaration).
9. Attack Record (attacks with outcomes, holes repaired or accepted, coverage matrix).
10. Execution Order and deployable phase notes.
11. Ship Order with one-way doors flagged.
12. Verdict with attack and hole counts.
13. Summary of files to create, edit, delete, and verify.
