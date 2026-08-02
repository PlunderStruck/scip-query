---
name: scip-verify
description: Use once after a coherent finished change. Reuse checks that already ran, map each material requirement to direct evidence, inspect impact only when it can change the verdict, and give the final diff gate exactly one owner.
commands:
  - template: 'scip-query diff-impact'
    when: 'Compare a non-trivial changed surface with the plan when unexpected impact could change the verdict.'
  - template: 'scip-query diff-gate'
    when: 'Own the final gate only when no protected blocking Stop hook owns it, or inspect a reported gate finding.'
  - template: 'scip-query mission-trial report <program> --protected-root <path>'
    when: 'Classify protected matched trials for release or workflow calibration, not ordinary closeout.'
---

# scip-verify

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query diff-impact` | Compute changed symbols and downstream consumers from current git diff | changed symbols, downstream consumer identities, and impact paths | `bounded` | Compare a non-trivial changed surface with the plan when unexpected impact could change the verdict. |
| `scip-query diff-gate` | Runtime-bounded, single-flight gate for the current diff: architecture regressions plus echo, migration, coordination, doc-drift, unused-param, and new-dead candidates; exit 1 on blocking findings | blocking findings with check id, message, and remediation; advisory findings; root-cause groups; changed file and symbol counts; process exit status (1 when blocking findings exist) | `bounded` | Own the final gate only when no protected blocking Stop hook owns it, or inspect a reported gate finding. |
| `scip-query mission-trial report <program> --protected-root <path>` | Register, validate, record, list, or report protected autonomous-completion mission trials outside the candidate worktree | program identity, protected artifact observations, exact conditions, run eligibility, exclusions, and immutable run records | `complete` | Classify protected matched trials for release or workflow calibration, not ordinary closeout. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Purpose

Verification is the evidence pass that tries to prove a finished change wrong
before declaring it complete. A useful action can fail when a material
requirement is false. Repeating equivalent checks against unchanged state is
ceremony.

Evidence commands obtain a fresh usable index internally. Run the useful
command directly; do not manage `status`, watcher waits, or `reindex` as
verification steps. If a command cannot establish freshness, its exact error
is the blocker.

## Verify once

1. Build one requirement map from the active goal and plan. Include observable
   outcomes, invariants, affected consumers, architecture conditions,
   retirements, justified survivors, and generated or documented artifacts.
2. Put existing evidence beside each requirement. Reuse focused tests,
   checkers, source inspection, and command results that ran against the final
   relevant state. Evidence is useful only if it could have failed when that
   requirement was false.
3. Run the repository's focused native checks only for uncovered rows. Expand
   to a broad suite when repository policy or the affected surface requires
   it. Do not run baseline tests after implementation merely to recreate a
   before-state observation.
4. Run `scip-query diff-impact` only when compiler-resolved impact can change
   the verdict: a non-trivial source change, public contract, migration, or new
   abstraction. Compare the result with the planned surface. Follow bounded
   evidence with `refs --full` or `affected --full` only when completeness of
   that set is material.
5. Add a specialist check only when it covers a named risk that direct tests
   and the default gate do not cover. The final gate already owns its configured
   architecture, duplication, migration, coordination, documentation,
   unused-parameter, and new-dead checks. Do not run their standalone forms as
   a fixed pre-gate battery.
6. Give the final gate one owner:
   - If protected work activated a blocking Stop hook, finish direct evidence
     and let Stop run the gate and completion judgment.
   - Otherwise run `scip-query diff-gate` once.
   - If it reports a finding, inspect that finding, change or disposition the
     relevant state, then rerun. Do not rerun after an unchanged result.
7. Recheck the requirement map once. Run the cheapest discriminating probe for
   each remaining gap. Zero extra probes is valid when every row is covered.

A clean `diff-gate` is evidence, not permission to declare the goal complete.
It proves only its repository predicates. It does not replace the requirement
map, turn bounded evidence into complete evidence, or prove that scip-query
improves autonomous work. Supported Stop hooks convert the same fixed evidence
into a completion action; follow that action instead of inferring completion
from prose.

For an applied contract, use its restored consequences or `plan status`
rather than rebuilding a second checklist. The plan is not a completeness
ceiling: new repository evidence may expose an omitted consumer or residue.

## Report

State the verdict, the direct evidence for each material requirement, the
impact or final-gate result, and any remaining risk. Do not reproduce command
transcripts or fill a fixed checklist that changes no decision.

Use
[`references/calibrate-detectors.md`](references/calibrate-detectors.md) only
when a detector looks too noisy or suspiciously clean. A product-effectiveness
claim requires a protected matched mission trial for the exact provider,
model, runtime, and fixture; it is not an ordinary per-change step.
