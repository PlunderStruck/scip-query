# Conducting a multi-phase program

This governs running a program of work — planning, delegation, review, closure — across multiple steps, not how to write a single change plan (use the main SKILL.md's ordinary-mode scenario, or `references/high-assurance.md`, for that). Act like a skeptical principal engineer.

Key commands: `scip-query plan-context <target>` anchors each phase's step before delegating it; `scip-query diff-gate --json` verifies a handoff before accepting it and before closing the program; `scip-query health --json` pre-registers or checks a program-level health benchmark.

## The three laws

1. **A green result you have never seen fail is unverified.** This applies to tests, gates, reports from other agents, and your own checks (`scip-integrity-audit` applies the same law to code, where available).
2. **A plan is a contract for a less-capable executor, not a note to self.** If a competent-but-uninspired agent could not execute a step without guessing, the step is not finished being written.
3. **Nothing is silent.** Every finding, deviation, and shortcut must be either fixed or written down with a reason someone else would accept. 0% silent is the invariant — "fixed everything" is not.

## Scenario: write the program plan

State DONE MEANS falsifiably in the Goal — a command someone can run and a result they can check, not an aspiration. Pre-register acceptance benchmarks before any work: measure the current number (test count, timing, finding count, proof line), write it in the plan, and state the target number; work that cannot move a pre-registered number is scope to question.

Every plan step carries five fields: a file anchor with verified current behavior (cite how you know), the exact change, the validation command with expected output, a testability design (pure core, injected effects), and why this step is safe in this order. "Update X" with no current/target behavior is a wish, not a step.

Order phases by information gain and risk: blockers and evidence-integrity first, cheap discriminating probes before expensive builds, measurement before optimization, and anything not yet decided by the human becomes a GATED phase the executor must not start. Infrastructure that later steps inherit (a labeling choke point, a shared helper layer) must land before the features that need it. Flag one-way doors with their migration path, and keep an explicit DEFER list so cut scope is visible instead of forgotten.

Working agreement to include in the plan: ONE COMMIT PER STEP — bisectability is non-negotiable, and phase-level commits hide which step broke. Gate commands must be the FULL gate set the repo defines per phase — tests, typecheck, lint/format, and build — not just focused tests, because focused tests hide cross-phase regressions and omitting the linter is how red mains ship. Include regeneration duties and a deviation protocol: if source contradicts an anchor, BLOCKED-note it and continue; never improvise silently.

## Scenario: delegate and review a handoff

Delegate breadth, keep judgment: fan out mechanical/scoped work to subagents, but personally own anything requiring taste, cross-cutting context, or the final word on "is this real." Concurrent agents must get disjoint write scopes, named in their briefs; if a collision happens anyway, stop racing, apply-verify-commit atomically in one action, and re-sequence to a single writer.

Never accept a report at face value — reproduce its evidence. On every handoff, choose the minimal discriminating probe (the one command most likely to expose the report being wrong: a mutation input, a hand count, the benchmark number) and run it yourself; a report verified only by reading it is not verified. Loop until `scip-query diff-gate --json` is quiet: fix, re-run the discriminating probe, re-run the gate, and only then move on.

Verify your verifier: a gate check that cannot fail is no gate (e.g. a lint grep that only matches one linter's output, a diff-gate run on a clean tree, a test suite that skips the new path) — prove the check catches a planted failure once before trusting its green. After any "all green," ask what that check does NOT cover (eslint vs prettier; unit vs integration; clean-tree vacuity).

## Git and commit discipline

Never run `git checkout`/`restore`/`stash` on a tree with uncommitted work, yours or anyone's; revert probe edits by targeted deletion instead, and if source is lost, check `dist/*.map` sourcesContent before panicking. Commit working states early and surgically using explicit paths, never `add -A` on a shared tree; an unbisectable pile of work is a liability. Make commit cadence mechanical: at every step boundary run the arithmetic check "steps completed == commits made"; if they differ, stop and commit before touching anything new. "I'll commit when it's all done" is the signature decay pattern of a long or low-effort run — in two real executions this rationalized delay led to finishing an entire plan with zero or one commit, with the deviation rationalized mid-run rather than decided; a self-check that is a count (not a feeling) prevents this rationalization.

## Closing the program

After the program, fold what was learned back into the durable layer (docs, skills, followups) — insight that lives only in the conversation is lost. Escalate only genuine decision points — one-way doors, scope changes, taste, spending; for everything else, decide, act, and disclose.

Every conducted program and every plan written under this skill must end with a self-report checklist mapping each section above to concrete evidence: pre-registered benchmarks and their before/after values, each handoff's discriminating probe and its OBSERVED result (a probe listed but not run counts as not run), the deviation ledger, the DEFER list, and which learnings were folded back and where — so a reviewer can audit the conduct, not just the artifact.

The program is complete only when: every pre-registered benchmark is met or its miss explained; every handoff probe is run and recorded; the gate is quiet on the final state; nothing is silent (every finding fixed or ledgered); and the self-report is written.
