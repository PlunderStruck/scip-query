---
name: scip-verify
description: Verify finished code, docs, config, refactor, cleanup, setup, React, Vue, or API changes with scip-query. Use before committing or when the user asks whether a change is wired, safe, regression-free, or ready.
commands:
  - template: 'scip-query doctor'
    when: 'Prove the workspace: index freshness and dependency readiness.'
  - template: 'scip-query status --capabilities'
    when: 'Prove the workspace: which evidence and verification capabilities are available.'
  - template: 'scip-query diff-impact --json'
    when: 'Assess the diff: changed symbols and downstream consumers.'
  - template: 'scip-query diff-gate --json'
    when: 'Run the gate: the primary blocker for diff-specific risk.'
  - template: 'scip-query health --baseline'
    when: 'Check health: compare findings against the committed baseline.'
  - template: 'scip-query doc-drift --json --full'
    when: 'Check docs: run when docs, AGENTS.md, or command surfaces changed.'
---

# scip-verify

Use this skill to verify the actual diff. Verification is the evidence pass that proves the workspace can answer, the index is current, the changed symbols and files match intent, routed postchecks ran, and diff-gate findings are resolved.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->

## Commands for this skill

| Command                              | Purpose                                                                                                                                                                                                         | When                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `scip-query doctor`                  | Diagnose config, index freshness, dependency readiness, and project capabilities                                                                                                                                | Prove the workspace: index freshness and dependency readiness.                   |
| `scip-query status --capabilities`   | Show index status for this project                                                                                                                                                                              | Prove the workspace: which evidence and verification capabilities are available. |
| `scip-query diff-impact --json`      | Compute changed symbols and downstream consumers from current git diff                                                                                                                                          | Assess the diff: changed symbols and downstream consumers.                       |
| `scip-query diff-gate --json`        | Gate the current diff: echo candidates, incomplete migrations, missing co-change partners, unedited twin partners (advisory), uncited doc updates, unused params, new dead symbols; exit 1 on blocking findings | Run the gate: the primary blocker for diff-specific risk.                        |
| `scip-query health --baseline`       | Composite codebase health report with prioritized action list                                                                                                                                                   | Check health: compare findings against the committed baseline.                   |
| `scip-query doc-drift --json --full` | Stale-doc candidates: code the doc references or co-changed with kept changing after the doc stopped                                                                                                            | Check docs: run when docs, AGENTS.md, or command surfaces changed.               |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.

<!-- END GENERATED SKILL COMMANDS -->

## Rules

1. Verify environment and index freshness before trusting graph facts.
2. Treat `scip-query diff-gate --json` as the primary blocker for diff-specific risk.
3. Run every postcheck that matches the actual edit, not only the check you expected to need.
4. If `.scipquery.json` or suppressions changed, run `scip-query config-validate`.
5. Prefer fixing findings. Suppress only intentional design, compatibility shims, framework entry points, or accepted false positives with a specific reason.

## Flow

### 1. Prove the workspace

```bash
scip-query doctor
scip-query status --capabilities
```

This step is complete only when missing indexers, invalid config, stale indexes, or unavailable relevant capabilities are fixed or reported as blockers.

### 2. Assess the diff

```bash
scip-query diff-impact --json
```

Compare changed files, changed symbols, and downstream consumers with the intended work. Unexpected blast radius is a finding even if later gates pass.

This step is complete only when the diff shape is understood.

### 3. Run routed postchecks

Use the postcheck table in the shared reference. Run all rows that apply to the change type.

This step is complete only when each applicable postcheck has a result and every actionable finding is fixed, accepted with evidence, or blocked by a named constraint.

### 4. Run the gate

```bash
scip-query diff-gate --json
```

If it reports findings, fix them or record the acceptance reason. If a suppression is needed:

```bash
scip-query suppress <id> --reason "<specific reason>"
```

`suppress` writes one file per suppression under `.scipquery/suppressions/` —
commit that file with your change. Suppressing is a real decision, not a
bypass: every suppression counts against that detector's precision in
`scip-query effectiveness`, while a same-HEAD clean rerun after fixing the
finding earns verified credit. Prefer the fix whenever the finding is real.

This step is complete only when `diff-gate` passes or every finding has a durable explanation.

### 5. Check health, docs, and config when relevant

Run:

```bash
scip-query health --baseline
```

when a committed baseline exists. If docs, AGENTS.md, CLAUDE.md, command docs, generated docs, or skill instructions changed, run:

```bash
scip-query doc-drift --json --full
```

If the repository provides a self-audit command and the change touches generated command surfaces, analyzers, or evidence-labeling behavior, also run:

```bash
scip-query self-audit
```

This step is complete only when changed documentation and config surfaces are checked or explicitly out of scope.

## Report

End with:

```markdown
Verification: PASS/FAIL

Environment:

- doctor:
- status:

Diff:

- changed files/symbols:
- unexpected blast radius:

Postchecks:

- <command>: <result>

Gate:

- `scip-query diff-gate --json`: <result>

Health/docs/config:

- <commands and results>

Remaining risk:

- <accepted findings, unavailable capabilities, or checks not run>
```

Do not claim ready-to-ship unless freshness is `fresh` after the final edit and diff-gate is passed or fully explained.

- `dead`/`new-dead` correctly resolve `import type` consumers, tsconfig `paths` aliases, pnpm/npm/yarn workspace cross-package imports, and Vue `<script setup>` composables. The one residual gap is a same-named symbol reached only through a re-exporting barrel file in a workspace package; that shape self-labels `unconfirmed (cross-package ambiguous-name resolution gap)` in the finding — treat only that label as unconfirmed until `refs` agrees. See the Detector Reliability section in `../_shared/SKILL.md`.
