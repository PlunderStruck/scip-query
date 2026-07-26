# Root cause: recurring bug family → design flaw → least invasive remedy

Use this mode to move from a family of related bugs to the design flaw that
produces them, and to the least invasive remedy that eliminates the class.
Debug mode takes one failure to one minimal fix; the maintainability scenario
in `scip-audit` finds structural smells without bug evidence; this mode starts
from evidence that patching has not worked — the same kind of bug keeps
recurring — and asks what the system's design gets wrong.

Load shared mechanics from [`../../_shared/SKILL.md`](../../_shared/SKILL.md) only when this shortlist is insufficient.

## Commands used in this mode

| Command | When |
| --- | --- |
| `scip-query trace <mechanism-symbol>` | Assemble the family: mechanism and violated invariant for each bug (bounded coverage: definition sites with source/signature, referencing files with line numbers). |
| `scip-query code <mechanism-symbol>` / `scip-query dataflow <mechanism-symbol>` | Assemble the family: trace each bug's mechanism to source rather than a symptom description. |
| `scip-query co-change <fix-site-file>` | Assemble the family: files that historically changed together with each fix site without a dependency edge — hidden coupling candidates, and a way to find family members the user forgot (bounded coverage: file pairs, co-change counts, confidence, history context). |
| `scip-query system <system-scope>` | Define the system's real responsibilities, files, and dependencies in and out (complete coverage: module file paths, exported symbols with line ranges, internal and reverse dependencies). |
| `scip-query surface <system-scope>` | Define the system: referents for its public surface alongside `system`. |
| `scip-query similar <fixed-symbol> --json --full` | Predict: hunt latent instances among sibling implementations of the fixed code (bounded coverage). |
| `scip-query refs <invariant-carrier>` | Predict: every site that touches the violated invariant's state (bounded coverage: referencing file paths, reference line numbers grouped by file). |
| `scip-query affected <remedy-symbol> --json` | Choose the remedy rung: blast radius of the candidate remedy (bounded coverage: transitive closure of symbols that could break). |

## Terms

A **bug family** is a set of failures whose mechanisms violate the same invariant; what makes it a family rather than a coincidence is that one stated flaw derives every member, so fixing members one at a time treats symptoms of a shared cause.

A **design flaw** is a mismatch between what a system's design assumes and what its real responsibilities require; what makes it the root cause is that it is the earliest fact from which every family member's mechanism follows, so removing it removes the class.

**Retrodiction** is deriving each already-known bug from the hypothesized flaw; what makes it a test is that a family member the flaw cannot derive either shrinks the family or kills the hypothesis.

A **latent instance** is a not-yet-reported bug the flaw predicts must exist in unfixed code; what makes it decisive is that it is checkable now — finding one confirms the diagnosis and becomes a fix target, while an honest hunt that finds none weakens the diagnosis and must be reported as weakening it.

The **remedy ladder** is the ordered set of interventions from least to most invasive; what makes the order binding is that each rung is only justified when a constructed family member survives the rung below it.

## Rules

1. Every bug in the family gets a mechanism traced to source, not a symptom description: which invariant broke, where, and what the fix did. Sources: fix commits (`git log --follow`, `git show`) plus `trace`/`code`/`dataflow`.
2. The flaw hypothesis must be falsifiable and stated as a design claim — "the design assumes X, but the system's responsibilities include Y" — never as a narrative about unlucky bugs.
3. State at least two rivals and kill them with evidence: unrelated coincidences, caller misuse rather than design, one missed edge case rather than a structural flaw.
4. The hypothesis must retrodict every family member and predict at least one latent instance, and the latent-instance hunt must be executed (`similar`, `refs` over the invariant's carriers, or a constructed probe), not merely argued.
5. Choose the lowest remedy rung that kills the whole class — retrodicted and latent members both. Climb a rung only when a constructed family member survives the rung below, and keep that counterexample in the record.
6. Root-cause stories are the most rationalization-prone artifact in software: prefer delegating the attack on the diagnosis and the remedy to a fresh subagent given only the family table, system definition, and hypothesis — briefed to win by refuting it. Solo fallback: write the rival hypotheses and the latent-instance predictions before reading any more code.
7. The verdict is derived with counts, and the diagnosis hands off to
   `scip-plan` for implementation — this mode does not edit application code
   itself.

## Workflow

### 1. Assemble the bug family

For each reported or fixed bug, fill one row:

```markdown
| Bug | Symptom | Mechanism (file:symbol) | Invariant violated | Fix applied | Source |
| --- | ------- | ----------------------- | ------------------ | ----------- | ------ |
```

Evidence: the user's description, fix commits (`git log --follow`, `git show`), `scip-query trace`/`code` on the mechanism symbols, `scip-query co-change` on fix sites to find members the user forgot.

This step is complete only when every row has a source-traced mechanism and a named invariant — a bug whose mechanism cannot be traced is listed as `unconfirmed member`, not silently included.

### 2. Define the system

Define the system that owns the family, contextually: its wider class, then the essential responsibility that explains its other traits in this codebase — with referents from `scip-query system <scope>` and `surface <scope>`. Then list the design's load-bearing assumptions as the code actually embodies them (not as the README states them), each with a `Source:` citation.

This step is complete only when the system's real responsibilities and embodied assumptions are stated with citations.

### 3. Hypothesize the flaw — and its rivals

State the flaw as a falsifiable design claim:

```markdown
Flaw hypothesis: the design assumes <X> (Source: <citation>), but the system's
responsibilities include <Y> (Source: <citation>); every family member is an
instance of the X∧Y collision.

Rivals:

- R1. Coincidence — the members have unrelated causes. Killed by: <evidence> | ALIVE
- R2. Misuse — callers hold the bug, the design is sound. Killed by: <evidence> | ALIVE
- R3. <next-most-plausible> — Killed by: <evidence> | ALIVE
```

A rival still marked `ALIVE` at the end of the workflow caps the diagnosis at `CANDIDATE`, not `CONFIRMED`.

### 4. Retrodict and predict

Retrodiction: derive each family-table row from the flaw in one sentence each. A member that cannot be derived is removed from the family (say so) or refutes the hypothesis (start over).

Prediction: the flaw implies unfixed instances exist. Name where they must be, then hunt:

```bash
scip-query similar <fixed-symbol> --json --full
scip-query refs <invariant-carrier>
```

plus a constructed probe when the claim is cheaply executable. Record each prediction with an executed result:

```markdown
- L1. <predicted latent instance> → FOUND at <file:line> (new fix target) | NOT FOUND after <hunt executed>
```

This step is complete only when every family member is retrodicted and every prediction has an executed hunt result. Zero latent instances found is a reportable weakness of the diagnosis, not a detail to omit.

### 5. Choose the lowest rung

The remedy ladder, in order:

1. **Enforce the invariant at a boundary** — type, guard, constraint, lint, trigger — without moving code.
2. **Consolidate the responsibility into one owner** — the scattered decision gets one named mechanism.
3. **Redesign the core behind its existing interface** — consumers untouched.
4. **Redesign the interfaces** — last resort; consumers migrate.

For the chosen rung, run the attack: construct a family member — retrodicted
or latent — that survives the rung. If one survives, keep the counterexample
in the record and climb one rung. Check blast radius with
`scip-query affected` before proposing any rung above 1. For protocol- or
lifecycle-shaped flaws whose remedy must hold across interleavings, note the
escalation path to the TLA+ mode in `scip-plan`.

This step is complete only when the chosen rung has an attack record showing no family member survives it, and every rejected lower rung keeps its surviving counterexample.

### 6. Report and hand off

```markdown
## Root-cause diagnosis

System: <definition with referents>
Bug family: <n> members traced, <u> unconfirmed
Flaw: <the design claim> — CONFIRMED | CANDIDATE (rival <id> alive)
Rivals: <r> stated, <k> killed with evidence
Retrodiction: <n>/<n> members derived
Latent instances: <p> predicted, <f> found (each a fix target), hunts executed
Remedy: rung <1-4> — <the intervention>; lower rungs rejected by <counterexamples>
Blast radius: <affected summary>
Escalation: <none | scip-plan TLA+ mode for <property>>
```

Hand the diagnosis to `scip-plan`: the flaw and invariants constrain current
flow and risks, the family table and hunt results constrain the slices, and
the surviving-counterexample record seeds the verification attacks.

The diagnosis is complete only when the verdict line carries the counts and every count is backed by an entry in the record above it.
