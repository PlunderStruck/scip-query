---
name: scip-conductor
description: Plan and conduct multi-step engineering programs like a skeptical principal engineer. Use for writing executable multi-phase plans, delegating implementation, reviewing another agent's work, or carrying a large change end to end with verification at every handoff.
commands:
  - template: "scip-query plan-context <target>"
    when: "Anchor each phase's step before delegating it."
  - template: "scip-query diff-gate --json"
    when: "Verify a handoff before accepting it and before closing the program."
  - template: "scip-query health --json"
    when: "Pre-register or check a program-level health benchmark."
---

# scip-conductor

This skill is how to run a *program* of work — planning, delegation, review,
and closure — not how to write one change plan (use a dedicated planning
skill such as `concrete-plan` for individual changes when one is available).

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | When |
| --- | --- | --- |
| `scip-query plan-context <target>` | Pre-edit planning context for a symbol, file, or module | Anchor each phase's step before delegating it. |
| `scip-query diff-gate --json` | Gate the current diff: echo candidates, incomplete migrations, missing co-change partners, unedited twin partners (advisory), uncited doc updates, unused params, new dead symbols; exit 1 on blocking findings | Verify a handoff before accepting it and before closing the program. |
| `scip-query health --json` | Composite codebase health report with prioritized action list | Pre-register or check a program-level health benchmark. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## The Three Laws

1. **A green result you have never seen fail is unverified.** Applies to
   tests, gates, reports from other agents, and your own checks. (Where
   available, `scip-integrity-audit` is the same law aimed at code.)
2. **A plan is a contract for a less-capable executor, not a note to self.**
   If a competent-but-uninspired agent could not execute a step without
   guessing, the step is not finished being written.
3. **Nothing is silent.** Every finding, deviation, and shortcut is either
   fixed or written down with a reason someone else would accept. 0%
   silent is the invariant; "fixed everything" is not.

## Writing the Plan

- **Goal states what DONE MEANS falsifiably** — a command someone can run
  and a result they can check, not an aspiration.
- **Pre-register acceptance benchmarks.** Before any work: measure the
  current number (test count, timing, finding count, proof line), write it
  in the plan, and state the target number. Work that cannot move a
  pre-registered number is scope to question.
- **Every step carries five fields**: file anchor with verified current
  behavior (cite how you know); the exact change; the validation command
  with expected output; testability design (pure core, injected effects);
  why this step is safe *in this order*. "Update X" with no current/target
  behavior is a wish, not a step.
- **Order phases by information gain and risk**: blockers and
  evidence-integrity first; cheap discriminating probes before expensive
  builds; measurement before optimization; anything not yet decided by the
  human is a GATED phase the executor must not start. Infrastructure the
  later steps inherit (a labeling choke point, a shared helper layer)
  lands before the features that need it.
- **Flag one-way doors** with their migration path, and keep an explicit
  DEFER list so cut scope is visible instead of forgotten.
- **Include the working agreement**: ONE COMMIT PER STEP (bisectability is
  non-negotiable; phase-level commits hide which step broke), the exact
  gate commands — the FULL suite per phase, not just focused tests (focused
  tests hide cross-phase regressions until the end), regeneration duties,
  and the deviation protocol —
  "if source contradicts an anchor, BLOCKED-note it and continue; never
  improvise silently."

## Conducting the Work

- **Delegate breadth, keep judgment.** Fan out mechanical/scoped work;
  personally own anything requiring taste, cross-cutting context, or the
  final word on "is this real."
- **Concurrent agents get disjoint write scopes**, named in their briefs.
  If a collision happens anyway: stop racing, apply-verify-commit
  atomically in one action, and re-sequence to a single writer.
- **Never accept a report — reproduce its evidence.** On every handoff,
  choose the *minimal discriminating probe*: the one command most likely to
  expose the report being wrong (a mutation input, a hand count, the
  benchmark number), and run it yourself. A report verified by reading it
  is not verified.
- **Loop until the gate is quiet**: fix → re-run the discriminating probe →
  re-run the gate → only then move on. After the program: fold what was
  learned back into the durable layer (docs, skills, followups) — insight
  that lives only in the conversation is lost.
- **Escalate only genuine decision points** — one-way doors, scope changes,
  taste, spending. Everything else: decide, act, disclose.

## Scar Rules (each bought with a real failure)

- **Verify your verifier.** A gate check that cannot fail is no gate: a
  lint grep that only matches one linter's output, a diff-gate run on a
  clean tree, a test suite that skips the new path. Prove the check catches
  a planted failure once before trusting its green.
- **Never `git checkout`/`restore`/`stash` on a tree with uncommitted
  work** — yours or anyone's. Revert probe edits by targeted deletion.
  If source is lost, check `dist/*.map` sourcesContent before panicking.
- **Commit working states early and surgically** (explicit paths, never
  `add -A` on a shared tree); an unbisectable pile of work is a liability.
- **Watch for your own gate holes**: after any "all green," ask what that
  check does NOT cover (eslint vs prettier; unit vs integration; clean-tree
  vacuity).

## Self-Report (required output)

End every conducted program — and every plan written under this skill —
with a checklist mapping each section above to concrete evidence:
the pre-registered benchmarks and their before/after values; each handoff's
discriminating probe and its OBSERVED result (a probe listed but not run
counts as not run); the deviation ledger; the DEFER list;
which learnings were folded back and where. A reviewer must be able to
audit the *conduct*, not just the artifact.

## Completion

The program is complete only when: every pre-registered benchmark met or
its miss explained; every handoff probe run and recorded; the gate quiet on
the final state; nothing silent — every finding fixed or ledgered; and the
self-report written.
