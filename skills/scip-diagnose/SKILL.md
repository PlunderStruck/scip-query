---
name: scip-diagnose
description: Use in a scip-query-indexed repo when something is broken, crashing, failing a test, returning wrong data, or regressed — one bug, a recurring family pointing at one design flaw, or a raw issue/ticket needing a fix packet. Also use proactively to prove whether a parser/AST branch is reachable or dead, even with no reported failure. Distinct from the `debugging` skill: that one supplies the general method (reproduce on demand, observe rather than infer, one variable at a time); this one supplies SCIP evidence (trace, refs, dataflow) in an indexed repo. Use both together. Distinct from `incident-review`, which is postmortem methodology after an outage rather than finding a live cause.
commands:
  - template: "scip-query files <feature-or-error-term>"
    when: "Locate the files that can explain an unnormalized report or error."
  - template: "scip-query trace <candidate-symbol>"
    when: "Connect a candidate cause to its definition and references."
  - template: "scip-query call-graph <entry-symbol>"
    when: "Trace callers and callees around the observed failure path."
---

# scip-diagnose

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query files <feature-or-error-term>` | Find files matching a pattern | matching file paths | `complete` | Locate the files that can explain an unnormalized report or error. |
| `scip-query trace <candidate-symbol>` | Trace a symbol: definition + all references | definition sites with source and signature; referencing files with line numbers | `bounded` | Connect a candidate cause to its definition and references. |
| `scip-query call-graph <entry-symbol>` | Show incoming callers and outgoing callees for a symbol | caller and callee symbol identities with files | `bounded` | Trace callers and callees around the observed failure path. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Purpose

Move from a reported failure to a minimal verified fix. This skill covers four related but distinct situations — one bug, a recurring family of bugs pointing at one design flaw, a raw issue report that needs to become a fix packet, and an unverified parser/AST branch that needs to be proven reachable or dead — and routes each to its own evidence-gathering mode.

This skill has no commands of its own; every mode below draws on the shared `scip-query` vocabulary. Load [`../_shared/SKILL.md`](../_shared/SKILL.md) for freshness, lookup, postcheck, and subagent rules whenever a mode's shortlist is insufficient.

## Pick the mode

| Situation | Mode | Reference |
| --- | --- | --- |
| One reported failure: broken, crashing, failing a test, wrong output, a regression — needs the smallest verified fix | **Debug** | [`references/debug.md`](references/debug.md) |
| The same kind of bug keeps recurring in one subsystem, patching hasn't worked, or the user lists several fixed/observed bugs and asks what is really wrong | **Root cause** | [`references/root-cause.md`](references/root-cause.md) |
| A raw bug report, GitHub issue, support ticket, TODO, or vague defect that has not yet been turned into evidence | **Triage** | [`references/triage.md`](references/triage.md) |
| A conditional branches on a parser/AST node's type, tag, or shape and nobody has checked it against the real parser — dead-branch or wrong-node-type suspicion, tree-sitter grammar mismatch, even with no reported failure | **Probe reachability** | [`references/probe-reachability.md`](references/probe-reachability.md) |

Pick exactly one mode before gathering evidence. Debug and triage both trace a single failing path, but debug assumes the failure is already pinned down enough to reproduce; triage exists because it isn't — normalize the report first. Root cause is not "debug but more bugs": it requires a falsifiable design-flaw hypothesis, killed rivals, retrodiction, and an executed latent-instance hunt, not just more patches. Probe reachability is the only mode that runs without a reported failure at all — it proves or disproves reachability of code nobody has verified against the real parser.

## How the modes relate to each other and to other skills

- **Debug → Root cause escalation:** if a debug fix is the second or third patch to the same mechanism, stop and switch to root-cause mode instead of shipping another narrow patch.
- **Triage → Debug/Root cause handoff:** triage produces a fix packet with a suspected root cause and a failing-test plan; if the user also asked for the fix, implement from the packet using debug-mode discipline (smallest change, verify, `scip-verify`).
- **Root cause → scip-plan handoff:** root-cause mode diagnoses and hands off; it does not edit application code. The flaw and invariants become `scip-plan`'s current-flow and risk evidence, and the family table and hunt results constrain its slices.
- **vs. `debugging` skill:** that skill supplies the general method — reproduce on demand, observe rather than infer, change one variable at a time. This skill supplies the SCIP-specific evidence (trace, refs, dataflow, blast radius) that method needs in an indexed repo. Use both together; this skill does not replace that discipline.
- **vs. `incident-review`:** that skill is postmortem methodology applied after an outage has already been resolved. This skill finds a live, unresolved cause.
- **vs. `scip-audit`:** structural smells with no bug evidence go to the maintainability scenario in `scip-audit`. A recurring bug family with bug evidence goes to root-cause mode here.
- **Verification:** every mode that ends in a code change verifies with the narrowest repo test or smoke command, then invokes the `scip-verify` skill. Triage-only requests stop at the packet.
