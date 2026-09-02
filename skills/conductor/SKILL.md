---
name: conductor
description: Plan and conduct multi-step engineering programs like a skeptical principal engineer. Use for writing executable multi-phase plans, delegating implementation, reviewing another agent's work, or carrying a large change end to end with verification at every handoff.
---

# conductor

This skill is how to run a _program_ of work: planning, delegation, review,
and closure. It is not how to write one change plan; use `$scip-plan` for an
individual change in a scip-query-indexed repository.

## The Three Laws

1. **A green result you have never seen fail is unverified.** Applies to
   tests, gates, reports from other agents, and your own checks.
   `$scip-integrity-audit` is the same law aimed at code.
2. **A plan is a contract for a less-capable executor, not a note to self.**
   If a competent-but-uninspired agent could not execute a step without
   guessing, the step is not finished being written.
3. **Nothing is silent.** Every finding, deviation, and shortcut is either
   fixed or written down with a reason someone else would accept. Zero
   percent silent is the invariant; "fixed everything" is not.

## Writing the Plan

- **Goal states what DONE MEANS falsifiably**: a command someone can run
  and a result they can check, not an aspiration.
- **Pre-register acceptance benchmarks.** Before any work: measure the
  current number (test count, timing, finding count, proof line), write it
  in the plan, and state the target number. Work that cannot move a
  pre-registered number is scope to question.
- **Every step carries five fields**: file anchor with verified current
  behavior (cite how you know); the exact change; the validation command
  with expected output; testability design (pure core, injected effects);
  why this step is safe _in this order_. "Update X" with no current and
  target behavior is a wish, not a step.
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
  gate commands, meaning the FULL gate set the repo defines per phase
  (tests, typecheck, lint and format, build) and not just focused tests
  (focused tests hide cross-phase regressions; omitting the linter is how
  red mains ship), regeneration duties, and the deviation protocol:
  "if source contradicts an anchor, BLOCKED-note it and continue; never
  improvise silently."

## Conducting the Work

- **Delegate breadth, keep judgment.** Fan out mechanical, scoped work;
  personally own anything requiring taste, cross-cutting context, or the
  final word on "is this real."
- **Concurrent agents get disjoint write scopes**, named in their briefs.
  If a collision happens anyway: stop racing, apply-verify-commit
  atomically in one action, and re-sequence to a single writer.
- **Never accept a report; reproduce its evidence.** On every handoff,
  choose the _minimal discriminating probe_: the one command most likely to
  expose the report being wrong (a mutation input, a hand count, the
  benchmark number, a `scip-query diff-impact` over the claimed change), and
  run it yourself. A report verified by reading it is not verified.
- **Make the commit cadence mechanical, not aspirational.** At every step
  boundary run the arithmetic check: steps completed equals commits made. If
  they differ, stop and commit before touching anything new. "I'll commit
  when it's all done" is the signature decay of a long or low-effort run.
  A self-check that is a count cannot be rationalized.
- **Loop until the gate is quiet**: fix, re-run the discriminating probe,
  re-run the gate, and only then move on. After the program, fold what was
  learned back into the durable layer (docs, skills, followups). Insight
  that lives only in the conversation is lost.
- **Escalate only genuine decision points**: one-way doors, scope changes,
  taste, spending. Everything else: decide, act, disclose.

## Scar Rules (each bought with a real failure)

- **Verify your verifier.** A gate check that cannot fail is no gate: a
  lint grep that only matches one linter's output, an impact check run on a
  clean tree, a test suite that skips the new path. Prove the check catches
  a planted failure once before trusting its green.
- **Never `git checkout`, `git restore`, or `git stash` on a tree with
  uncommitted work**, yours or anyone's. Revert probe edits by targeted
  deletion. If source is lost, check `dist/*.map` sourcesContent before
  panicking.
- **Commit working states early and surgically** with explicit paths, never
  `add -A` on a shared tree. An unbisectable pile of work is a liability.
- **Watch for your own gate holes**: after any "all green," ask what that
  check does NOT cover (eslint versus prettier; unit versus integration;
  clean-tree vacuity).

## Self-Report (required output)

End every conducted program, and every plan written under this skill,
with a checklist mapping each section above to concrete evidence:
the pre-registered benchmarks and their before and after values; each
handoff's discriminating probe and its OBSERVED result (a probe listed but
not run counts as not run); the deviation ledger; the DEFER list; which
learnings were folded back and where. A reviewer must be able to audit the
_conduct_, not just the artifact.

## Completion

The program is complete only when: every pre-registered benchmark met or
its miss explained; every handoff probe run and recorded; the gate quiet on
the final state; nothing silent, meaning every finding fixed or ledgered;
and the self-report written.
