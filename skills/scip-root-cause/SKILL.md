---
name: scip-root-cause
description: Diagnose the design flaw behind a family of related bugs with scip-query evidence. Use when similar bugs keep recurring, the same subsystem keeps needing patches, or the user lists fixed or observed bugs and asks what is really wrong; produces a falsifiable flaw diagnosis, a latent-instance hunt, and the least invasive remedy that kills the class.
metadata:
  commands:
    - template: 'scip-query trace <symbol>'
      when: 'Trace one bug mechanism: definition plus every reference of the symbol that broke the invariant.'
    - template: 'scip-query code <selector>'
      when: 'Read the exact body at a fix site or a suspected latent instance.'
    - template: 'scip-query evidence --symbol <symbol> --edge dataflow --direction both --depth <n> --max-edges <n>'
      when: 'Follow where a violated value comes from and where it goes.'
    - template: 'scip-query co-change <file>'
      when: 'Find fix-site partners from git history that the user may have forgotten.'
    - template: 'scip-query system <scope>'
      when: 'Define the owning system: its files, exports, and dependencies.'
    - template: 'scip-query surface <scope>'
      when: 'See what consumers actually rely on from the owning system.'
    - template: 'scip-query similar <symbol> --full'
      when: 'Hunt latent instances: callables that do the same work as a fixed symbol.'
    - template: 'scip-query refs <symbol>'
      when: 'Hunt latent instances: every site that touches the invariant carrier.'
    - template: 'scip-query affected <symbol>'
      when: 'Bound the blast radius before proposing any remedy above rung 1.'
---

# scip-root-cause

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Command and question manual

| Command syntax | Question it answers |
| --- | --- |
| `scip-query trace <symbol>` | Trace one bug mechanism: definition plus every reference of the symbol that broke the invariant. |
| `scip-query code <selector>` | Read the exact body at a fix site or a suspected latent instance. |
| `scip-query evidence --symbol <symbol> --edge dataflow --direction both --depth <n> --max-edges <n>` | Follow where a violated value comes from and where it goes. |
| `scip-query co-change <file>` | Find fix-site partners from git history that the user may have forgotten. |
| `scip-query system <scope>` | Define the owning system: its files, exports, and dependencies. |
| `scip-query surface <scope>` | See what consumers actually rely on from the owning system. |
| `scip-query similar <symbol> --full` | Hunt latent instances: callables that do the same work as a fixed symbol. |
| `scip-query refs <symbol>` | Hunt latent instances: every site that touches the invariant carrier. |
| `scip-query affected <symbol>` | Bound the blast radius before proposing any remedy above rung 1. |

These commands are controls, not a checklist. Use every capability needed by the task, but make each query answer a distinct question. There is no required sequence or query limit. Run a command's `--help` when you need a flag not shown in its template.
<!-- END GENERATED SKILL COMMANDS -->

Use this skill to move from a family of related bugs to the design flaw that produces them, and to the least invasive remedy that eliminates the class. Ordinary debugging takes one failure to one minimal fix. `$principal-maintainability-review` finds structural smells without bug evidence. This skill starts from the evidence that patching has not worked, because the same kind of bug keeps coming back, and asks what the system's design gets wrong.

## Terms

A bug family is a set of failures whose mechanisms violate the same invariant. What makes it a family rather than a coincidence is that one stated flaw derives every member, so fixing members one at a time treats symptoms of a shared cause.

A design flaw is a mismatch between what a system's design assumes and what its real responsibilities require. What makes it the root cause is that it is the earliest fact from which every family member's mechanism follows, so removing it removes the class.

Retrodiction is deriving each already-known bug from the hypothesized flaw. What makes it a test is that a family member the flaw cannot derive either shrinks the family or kills the hypothesis.

A latent instance is a not-yet-reported bug the flaw predicts must exist in unfixed code. What makes it decisive is that it is checkable now. Finding one confirms the diagnosis and becomes a fix target. An honest hunt that finds none weakens the diagnosis and must be reported as weakening it.

The remedy ladder is the ordered set of interventions from least to most invasive. What makes the order binding is that each rung is only justified when a constructed family member survives the rung below it.

## Rules

1. Every bug in the family gets a mechanism traced to source, not a symptom description: which invariant broke, where, and what the fix did. Sources: fix commits (`git log`, `git show`) plus `trace`, `code`, and `evidence` dataflow.
2. The flaw hypothesis must be falsifiable and stated as a design claim: "the design assumes X, but the system's responsibilities include Y." Never a narrative about unlucky bugs.
3. State at least two rivals and kill them with evidence: unrelated coincidences, caller misuse rather than design, one missed edge case rather than a structural flaw.
4. The hypothesis must retrodict every family member and predict at least one latent instance, and the latent-instance hunt must be executed with `similar`, `refs` over the invariant's carriers, or a constructed probe. It is never argued.
5. Choose the lowest remedy rung that kills the whole class, retrodicted and latent members both. Climb a rung only when a constructed family member survives the rung below, and keep that counterexample in the record.
6. Root-cause stories are the most rationalization-prone artifact in software. Prefer delegating the attack on the diagnosis and the remedy to a fresh subagent given only the family table, system definition, and hypothesis, briefed to win by refuting. Solo fallback: write the rival hypotheses and the latent-instance predictions before reading any more code.
7. The verdict is derived with counts, and the diagnosis hands off to `$scip-plan` for implementation. This skill does not edit application code.

## Workflow

### 1. Assemble the bug family

For each reported or fixed bug, fill one row:

```markdown
| Bug | Symptom | Mechanism (file:symbol) | Invariant violated | Fix applied | Source |
| --- | ------- | ----------------------- | ------------------ | ----------- | ------ |
```

Evidence: the user's description, fix commits (`git log --follow`, `git show`), `scip-query trace` and `scip-query code` on the mechanism symbols, `scip-query co-change` on fix sites to find members the user forgot.

This step is complete only when every row has a source-traced mechanism and a named invariant. A bug whose mechanism cannot be traced is listed as `unconfirmed member`, not silently included.

### 2. Define the system

Define the system that owns the family: its wider class, then the essential responsibility that explains its other traits in this codebase, with referents from `scip-query system <scope>` and `scip-query surface <scope>`. Then list the design's load-bearing assumptions as the code actually embodies them, not as the README states them, each with a `Source:` citation.

This step is complete only when the system's real responsibilities and embodied assumptions are stated with citations.

### 3. Hypothesize the flaw and its rivals

State the flaw as a falsifiable design claim:

```markdown
Flaw hypothesis: the design assumes <X> (Source: <citation>), but the system's
responsibilities include <Y> (Source: <citation>); every family member is an
instance of the X and Y collision.

Rivals:

- R1. Coincidence: the members have unrelated causes. Killed by: <evidence> | ALIVE
- R2. Misuse: callers hold the bug, the design is sound. Killed by: <evidence> | ALIVE
- R3. <next-most-plausible>. Killed by: <evidence> | ALIVE
```

A rival still marked `ALIVE` at the end of the workflow caps the diagnosis at `CANDIDATE`, not `CONFIRMED`.

### 4. Retrodict and predict

Retrodiction: derive each family-table row from the flaw in one sentence each. A member that cannot be derived is removed from the family (say so) or refutes the hypothesis (start over).

Prediction: the flaw implies unfixed instances exist. Name where they must be, then hunt:

```bash
scip-query similar <fixed-symbol> --full
scip-query refs <invariant-carrier>
scip-query evidence --symbol <invariant-carrier> --edge dataflow --direction outgoing --depth 2 --max-edges 80
```

plus a constructed probe when the claim is cheaply executable. Record each prediction with an executed result:

```markdown
- L1. <predicted latent instance> -> FOUND at <file:line> (new fix target) | NOT FOUND after <hunt executed>
```

This step is complete only when every family member is retrodicted and every prediction has an executed hunt result. Zero latent instances found is a reportable weakness of the diagnosis, not a detail to omit.

### 5. Choose the lowest rung

The remedy ladder, in order:

1. **Enforce the invariant at a boundary** with a type, guard, constraint, lint, or trigger, without moving code.
2. **Consolidate the responsibility into one owner** so the scattered decision gets one named mechanism.
3. **Redesign the core behind its existing interface** with consumers untouched.
4. **Redesign the interfaces** as a last resort; consumers migrate.

For the chosen rung, run the attack: construct a family member, retrodicted or latent, that survives the rung. If one survives, keep the counterexample in the record and climb one rung. Check blast radius with `scip-query affected` before proposing any rung above 1. For protocol- or lifecycle-shaped flaws whose remedy must hold across interleavings, note the escalation path to a formal model with `scip-query tla`.

This step is complete only when the chosen rung has an attack record showing no family member survives it, and every rejected lower rung keeps its surviving counterexample.

### 6. Report and hand off

```markdown
## Root-cause diagnosis

System: <definition with referents>
Bug family: <n> members traced, <u> unconfirmed
Flaw: <the design claim>: CONFIRMED | CANDIDATE (rival <id> alive)
Rivals: <r> stated, <k> killed with evidence
Retrodiction: <n>/<n> members derived
Latent instances: <p> predicted, <f> found (each a fix target), hunts executed
Remedy: rung <1-4>: <the intervention>; lower rungs rejected by <counterexamples>
Blast radius: <affected summary>
Escalation: <none | formal model for <property>>
```

Hand the diagnosis to `$scip-plan`: the flaw and invariants become its definitions and invariants, the family table and hunt results become premises, and the surviving-counterexample record seeds its attack pass.

The diagnosis is complete only when the verdict line carries the counts and every count is backed by an entry in the record above it.
