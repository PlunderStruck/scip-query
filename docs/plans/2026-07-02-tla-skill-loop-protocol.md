# TLA skill improvement loop — protocol (queued)

Same protocol that converged scip-conductor in three iterations, applied to
scip-tla-model-system.

1. **Gold exemplar (Claude)**: model **evidence-cache coherence** end to end —
   the queued next model target: invariant "no query ever serves evidence
   computed from a superseded index"; actors: reindex atomic publish,
   concurrent CLI readers, content/version keying. Full loop: scaffold →
   hand-tighten → verify (resource aliases now make fs-backed state provable)
   → break-on-purpose → instrument → trace-check with per-action coverage.
   This is also the first consumer of Plan-5's resource aliases at design time.
2. **Introspect**: diff the exemplar's actual process against what
   skills/scip-tla-model-system/SKILL.md teaches; every move the skill did not
   force becomes a skill edit (the conductor lesson: gaps are usually
   specification bugs, not capability gaps).
3. **Codex iteration**: Codex models a comparable system fresh (candidate:
   the finding-outcome ledger lifecycle — multi-run state machine, FIFO caps)
   using only the skill. Referee against the exemplar bar: mapping honesty
   (waivers reasoned, not blanket), model can fail (break-test performed),
   trace coverage reported, benchmark = its verify Proof line.
4. Patch skill, delete Codex's model, rerun with the same prompt. Loop until
   the Proof lines and break-test discipline match the exemplar.

Conductor v4 candidate (from the Plan-6 medium-tier runs) rides along:
"after a step's gates pass, the next action is `git commit` — a commit
described in the final report is not a commit."
