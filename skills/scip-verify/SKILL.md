---
name: scip-verify
description: Finished-diff specialist used only after source edits form one coherent change. Do not select or read it during initial planning. Reuse existing checks and give the final gate one owner.
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

Verification tries to prove a coherent finished change wrong. Repeating an
equivalent check against unchanged state is ceremony. Evidence commands obtain
a fresh usable index themselves; do not add status polling or reindex steps.

## Verify once

1. Map each material outcome, consumer, preservation rule, retirement, and
   architecture condition to evidence that ran against the final state.
2. Run only the cheapest native check that covers a remaining gap. Use the
   broad suite when repository policy or the changed surface requires it.
3. Run `scip-query diff-impact` only when unexpected compiler-resolved impact
   can change the verdict. Do not repeat `refs` already established by the
   planning packet unless complete coverage is material.
4. Add a specialist check only for a named risk the default gate does not own.
5. Give the final gate one owner:
   - If protected work activated a blocking Stop hook, finish direct evidence
     and let Stop run the gate and completion judgment.
   - Otherwise run `scip-query diff-gate` once.
   - If it reports a finding, inspect that finding, change or disposition the
     relevant state, then rerun. Do not rerun after an unchanged result.
6. Recheck the requirement map once. Zero extra probes is valid when every row
   is covered.

A clean `diff-gate` is evidence, not permission to declare the goal complete.
It proves only its repository predicates. It does not replace the requirement
map, turn bounded evidence into complete evidence, or prove that scip-query
improves autonomous work. Supported Stop hooks convert the same fixed evidence
into a completion action; follow that action instead of inferring completion
from prose.

## Report

State the verdict, direct evidence, gate result, and remaining risk. Do not
reproduce command transcripts or create a second checklist.

Use
[`references/calibrate-detectors.md`](references/calibrate-detectors.md) only
when a detector looks too noisy or suspiciously clean. A product-effectiveness
claim requires a protected matched mission trial for the exact provider,
model, runtime, and fixture; it is not an ordinary per-change step.
