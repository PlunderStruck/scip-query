---
name: scip-verify
description: Use once after a coherent finished change: reuse current freshness evidence, prove each requirement with the cheapest discriminating check, inspect final impact when relevant, and give the diff gate exactly one owner. Add standalone detectors only for uncovered risks or reported findings. Also use to calibrate detector precision when findings look too noisy or too clean.
commands:
  - template: "scip-query status --capabilities"
    when: "Confirm final source freshness only when current-generation status was not already established."
  - template: "scip-query diff-impact"
    when: "Compare changed files, symbols, and affected consumers with the intended diff."
  - template: "scip-query diff-gate"
    when: "Own the final gate when no protected blocking Stop hook will do so, or inspect a reported gate failure."
  - template: "scip-query mission-trial report <program> --protected-root <path>"
    when: "Classify protected matched trials when calibrating a release or material workflow change."
---

# scip-verify

## Purpose

Verification is the evidence pass that proves a finished change embodies its
goal without leaving affected artifacts unresolved. It is not a prescribed
number of commands. A useful verification action either tests an uncovered
requirement, investigates an unexpected result, or supplies the one final
enforcement decision. Repeating equivalent checks against unchanged evidence
is ceremony and is not part of this workflow.

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query status --capabilities` | Show index status for this project | freshness, generation, language shards, watcher, and optional capabilities | `complete` | Confirm final source freshness only when current-generation status was not already established. |
| `scip-query diff-impact` | Compute changed symbols and downstream consumers from current git diff | changed symbols, downstream consumer identities, and impact paths | `bounded` | Compare changed files, symbols, and affected consumers with the intended diff. |
| `scip-query diff-gate` | Runtime-bounded, single-flight gate for the current diff: architecture regressions plus echo, migration, coordination, doc-drift, unused-param, and new-dead candidates; exit 1 on blocking findings | blocking findings with check id, message, and remediation; advisory findings; root-cause groups; changed file and symbol counts; process exit status (1 when blocking findings exist) | `bounded` | Own the final gate when no protected blocking Stop hook will do so, or inspect a reported gate failure. |
| `scip-query mission-trial report <program> --protected-root <path>` | Register, validate, record, list, or report protected autonomous-completion mission trials outside the candidate worktree | program identity, protected artifact observations, exact conditions, run eligibility, exclusions, and immutable run records | `complete` | Classify protected matched trials when calibrating a release or material workflow change. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md)
only when it is insufficient. For detector calibration rather than a finished
diff, use
[`references/calibrate-detectors.md`](references/calibrate-detectors.md).

## Verify a finished change

### 1. Reuse current evidence

Do not restart setup or diagnose a workspace that already supplied fresh
current-generation evidence. After the final source edit, use the installed
hook's refresh result when it names the current generation; otherwise run:

```bash
scip-query status --capabilities
```

If the watcher is refreshing, wait and check once more. Run
`scip-query doctor` only when status reports an invalid configuration, missing
dependency, stale index, or unavailable capability whose cause must be
diagnosed. Run manual `scip-query reindex` only when freshness is stale,
missing, or unknown and no watcher can complete the refresh. A fresh status is
reusable until source or index inputs change.

### 2. Map requirements to direct evidence

List the goal, invariants, explicit cleanup requirements, and affected
consumers. For each one, name an already-executed test, checker, source
inspection, or command result that could have failed if the requirement were
false. Reuse that result; do not rerun it merely to populate a verification
template.

Run the repository's focused tests and native checkers for requirements that
still lack evidence. Expand to a broader suite only when the affected surface
or repository policy warrants it. A narrow unit test cannot prove a
repository-wide migration, while a full suite need not be repeated after an
unrelated documentation edit.

This requirement map is the completeness check. If the goal says obsolete
seams, duplicate behavior, compatibility paths, generated outputs, or docs
must be reconciled, each named consequence needs evidence; a general test pass
cannot silently stand in for it.

### 3. Inspect final impact when it can change the verdict

For a non-trivial source change, public-contract change, migration, or new
abstraction, run:

```bash
scip-query diff-impact
```

Compare its changed symbols and consumers with the planned surface. Follow a
bounded result with `refs --full` or `affected --full` only when a complete set
is necessary to judge the change. Skip this command for docs-only or literal
edits whose compiler-resolved impact cannot change the decision.

### 4. Add only discriminating specialist checks

The default diff gate already owns echo, incomplete-migration,
co-change-partner, twin-partner, coverage-contract, architecture,
doc-reference, unused-params, and new-dead checks. Do not run their standalone
forms as a fixed pre-gate battery. Use a standalone command only when all three
conditions hold:

1. the change introduces a specific risk not already proved by direct tests;
2. the command can distinguish success from failure for that risk; and
3. an equivalent result has not already run against the same state.

Typical examples:

- `similar <new-symbol>` when a new helper, hook, component, or adapter still
  has an unresolved reuse question;
- `recent-duplicates` when several new units create a repository-wide
  duplication risk that one targeted comparison cannot answer;
- `config-validate` when `.scipquery.json` or a suppression changed;
- a project-native generator or doc check when generated output or documented
  behavior changed;
- `self-audit` when detector, parser, semantic-oracle, or evidence-labeling
  behavior changed; and
- `cleanup-plan --verify` only when deleting detector-selected code through
  the cleanup workflow, not whenever an ordinary refactor removes lines.

Health scans and mission trials are product or repository calibration, not
ordinary closeout steps. Run them only when the user, release policy, or the
change itself makes that broader claim relevant.

### 5. Give the diff gate one owner

When the prompt hook says it activated protected work, the blocking Stop hook
owns the final diff gate and completion judgment. Do not run a manual final
gate first; finish the direct evidence, attempt to stop, and follow the exact
controller action if it blocks. This lets the same fixed observation drive
both findings and completion.

When no blocking Stop hook is available, run `scip-query diff-gate` once. If it
reports a finding, use the narrow command or source read needed to understand
that finding, repair or explicitly disposition it, and rerun after the state
changes. Do not run the whole standalone detector family before and after the
gate.

A clean
`diff-gate` is evidence, not permission to declare the goal complete. It does
not replace the requirement map, and skipped checks or failed evidence tiers
remain unresolved. Supported hooks convert the same evidence into a fixed
completion evaluation and durable next action. Follow that action; do not
infer completion from a passing command or final prose.

### 6. Close only real evidence gaps

Before concluding, inspect the requirement map once. For every missing row,
run the cheapest probe that would expose the implementation as incomplete: a
consumer test, an edge input, an exact residue search, a generated-file check,
or a targeted architecture query. Zero extra probes is valid when every row
already has discriminating evidence. An arbitrary quota of adversarial checks
is not.

Complete only when every authorized requirement has evidence, unexpected
impact is reconciled, the one gate owner passed or produced a followed next
action, and every remaining risk is named honestly.

## Report

Report the verdict, the direct evidence covering each material requirement,
the final impact/gate result, and any remaining risk. Do not reproduce command
transcripts or fill a fixed checklist whose fields add no decision-relevant
information.

A completed change establishes repository predicates for that change. It does
not establish that scip-query improves autonomous work. That claim requires a
protected matched mission trial for the exact provider, model, runtime, and
fixture:

```bash
scip-query mission-trial report <program> --protected-root <path>
```

## Detector reliability for this flow

`dead` and `new-dead` resolve `import type` consumers, tsconfig `paths`
aliases, workspace-package imports, and Vue `<script setup>` composables. The
known residual gap is a same-named symbol reached only through a re-exporting
barrel in a workspace package; that shape labels itself `unconfirmed
(cross-package ambiguous-name resolution gap)` and remains unconfirmed until
`refs` agrees.
