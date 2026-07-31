---
name: scip-query
description: Use FIRST for codebase work that should rest on SCIP evidence. Routes understanding to scip-explore, prospective changes to scip-plan, failures to scip-diagnose, read-only problem finding to scip-audit, confirmed fixes to scip-improve, adoption or repair to scip-setup, and finished diffs to scip-verify.
---

# SCIP Query Router

## Purpose

Choose one owning workflow before acting. An owning workflow is the bundled
skill whose completion criterion matches the request: understanding, planning,
diagnosis, read-only auditing, implementation, setup, or verification. The
router does not perform that workflow itself.

Load `../_shared/SKILL.md` only after the owning workflow's shortlist proves
insufficient. The shared reference contains the complete command vocabulary,
coverage rules, and evidence contract; loading it before a route is selected
adds choices without adding direction.

Run commands normally for agent reading: the human renderer preserves
hierarchy, whitespace, and line numbers without transport metadata. Select
`--json` only when a program will parse the response; add `--result-only` when
that program needs only the command result rather than the stable public
envelope. Do not select `--compact` or `--output-page-size` for readability.
Follow an emitted continuation command only when the command itself says the
output is incomplete. The final transport-complete footer means every rendered
character was retrieved; inspect command coverage separately before claiming
the logical result is exhaustive.

## Routes

| The request starts from… | Owning skill | Completion criterion |
| --- | --- | --- |
| Existing code that must be understood, traced, or diagrammed | `scip-explore` | Entry points, flow, dependencies, consumers, and remaining uncertainty are evidenced. |
| A proposed feature, refactor, migration, API change, performance campaign, TLA+ model, or multi-phase program | `scip-plan` | Current flow, affected consumers, reuse decisions, ordered slices, validation, and risks are explicit. |
| A failure, regression, recurring bug family, raw issue, or parser/AST reachability question | `scip-diagnose` | The observed failure is connected to a cause, rivals are rejected, and the smallest fix packet is defined. |
| A question about whether problems exist, without permission to edit | `scip-audit` | The scoped items are classified and ranked with evidence; no code or docs are changed. |
| Confirmed cleanup, drift, maintainability, frontend, directory, twin, or documentation findings that should be fixed | `scip-improve` | One coherent finding slice is changed and passes its routed postchecks. |
| First adoption, broken setup, missing capabilities, skill installation, hooks, CI, or uninstall | `scip-setup` | The workspace is ready, or every unavailable capability has an explicit blocker. |
| A finished diff that must be challenged before commit or release | `scip-verify` | Workspace, impact, applicable postchecks, gate findings, and refutation attempts are all accounted for. |

## Disambiguation

- Existing behavior with no symptom routes to `scip-explore`; a contradiction
  or failure routes to `scip-diagnose`.
- Finding and classifying problems without edits routes to `scip-audit`;
  changing already-confirmed findings routes to `scip-improve`.
- Prospective work routes to `scip-plan`; a concrete finished diff routes to
  `scip-verify`.
- Setup wins whenever the index or a required capability is missing, stale,
  invalid, or not yet installed.
- A request may cross workflows in sequence. Keep one owner at a time:
  diagnose before planning a fix, audit before improving, plan before a
  non-trivial implementation, and verify after every implemented slice.

## Default non-trivial change loop

1. Recover the canonical goal and intended change from the injected
   restoration state. If none exists and the user's authorized intent is
   sufficiently clear, invoke `scip-plan` to derive and materialize one concise
   goal-relative Gherkin request without asking the user to restate metadata.
2. Invoke `scip-plan`, anchored by
   `scip-query plan-context <target>`.
3. Implement the smallest coherent planned slice. Ordinary scip-query
   operations update attempt and evidence history automatically; do not add
   manual ledger commands as workflow ceremony.
4. Invoke `scip-verify`; do not declare completion until it passes or every
   remaining finding has a specific evidence-backed disposition.
5. Follow the exact Stop-controller next action. Continue autonomously for
   work blockers; stop only when the action identifies genuinely missing
   authorization.

Routing is complete only when exactly one owner is selected for the current
phase, or the request is small enough that no compiler-resolved relationship
claim is needed.

<!-- BEGIN GENERATED ROUTER COMMAND PREVIEW -->
## Command Preview

Top commands per routed skill, generated from each skill's own `commands:` frontmatter.

| Skill | Top commands |
| --- | --- |
| `scip-audit` | `scip-query health`, `scip-query decorative-checkers --full`, `scip-query doc-drift --full` |
| `scip-diagnose` | `scip-query files <feature-or-error-term>`, `scip-query trace <candidate-symbol>`, `scip-query call-graph <entry-symbol>` |
| `scip-explore` | `scip-query system <module-or-scope>`, `scip-query trace <entry-symbol>`, `scip-query affected <symbol>` |
| `scip-improve` | `scip-query cleanup-plan --verify`, `scip-query cleanup-apply --verified --batch <n> --dry-run`, `scip-query diff-gate` |
| `scip-plan` | `scip-query plan-context <target>`, `scip-query refs <symbol>`, `scip-query affected <symbol>` |
| `scip-setup` | `scip-query setup --json`, `scip-query doctor`, `scip-query status --capabilities` |
| `scip-verify` | `scip-query doctor`, `scip-query diff-impact`, `scip-query diff-gate` |
<!-- END GENERATED ROUTER COMMAND PREVIEW -->
