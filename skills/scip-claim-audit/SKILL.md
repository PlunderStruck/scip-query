---
name: scip-claim-audit
description: Audit output-facing status claims for evidence with scip-query. Use to classify whether an "available", "verified", "safe", "PASS", or "complete" status word is derived from a real check, hedged as a candidate, or merely asserted without being probed.
commands:
  - template: "scip-query files <pattern>"
    when: "Inventory: locate the renderer or status-producing module for a claim."
  - template: "scip-query refs <symbol>"
    when: "Classify: find every producer and consumer of a status-bearing function."
  - template: "scip-query code <symbol>"
    when: "Classify: read the producing function to see whether it computes or asserts."
  - template: "scip-query trace <symbol>"
    when: "Classify: definition plus every reference for a status field or constant."
  - template: "scip-query capabilities --matrix --json"
    when: "Spot-check: an already-known example of a fixed derived-status surface."
---

# scip-claim-audit

Use this skill to find agent-facing claims that sound verified but are not. A status word is **derived** when its producer computes it from a real probe, scan, or computation (a compiler run, a runtime capability probe, a graph traversal). It is **hedged** when the code or its label already says it is a candidate, heuristic, or unverified. It is **asserted** when the value is a constant, a hardcoded table entry, or a string literal presented with the same confidence as a derived value but backed by nothing the code actually checked at that call site. Asserted status words that are agent-facing and trust-bearing (an agent would route a decision — "use this evidence", "skip this check", "delete this" — based on the word) are the highest-severity class this skill exists to find.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | When |
| --- | --- | --- |
| `scip-query files <pattern>` | Find files matching a pattern | Inventory: locate the renderer or status-producing module for a claim. |
| `scip-query refs <symbol>` | Find all files referencing a symbol | Classify: find every producer and consumer of a status-bearing function. |
| `scip-query code <symbol>` | Read the source code for a symbol (bounded to its definition range) | Classify: read the producing function to see whether it computes or asserts. |
| `scip-query trace <symbol>` | Trace a symbol: definition + all references | Classify: definition plus every reference for a status field or constant. |
| `scip-query capabilities --matrix --json` | Report which evidence and verification capabilities are available in this project | Spot-check: an already-known example of a fixed derived-status surface. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Rules

1. Ground every claim in the producing function's source, not its label or variable name alone — a variable named `verified` that is never checked against a real result is still asserted.
2. Classify status, don't just list it: every status word in scope gets exactly one of derived / hedged / asserted.
3. Severity follows the rubric: asserted + agent-facing + trust-bearing = high; asserted + internal-only or low-consequence = low; hedged is not a finding (the label already discloses uncertainty).
4. A status that used to be asserted and now calls a real probe is fixed — say so and move on; do not re-report it.
5. File findings as a table, not prose; a claim → producer → classification → fix format is the deliverable.

## Workflow

### 1. Inventory the status vocabulary

Grep the target scope (a file, module, or command family) for user-visible or JSON-facing status words: `available`, `unavailable`, `partial`, `verified`, `safe`, `PASS`, `FAIL`, `complete`, `derived`, `asserted`. For each hit, note the file:line and the renderer or JSON field that surfaces it to an agent or user.

```bash
scip-query files <target-file-or-pattern>
```

This step is complete only when every status-bearing string or field in scope is listed with its surface (human output, `--json` field, or both).

### 2. Classify each producer

For each status word's producing function:

```bash
scip-query refs <producing-function>
scip-query code <producing-function>
scip-query trace <status-field-or-constant>
```

Read the function body. Classify:

- **Derived**: the status is computed from a probe, scan, spawn result, file check, or graph query performed at or near that call site.
- **Hedged**: the label, descriptor evidence tier, or surrounding text already marks the value as heuristic, candidate, or unverified.
- **Asserted**: the value is a literal, a static table lookup, or a branch that returns a fixed status without invoking any check for that specific branch.

This step is complete only when every producer has one of these three labels with the one line of source evidence that justifies it.

### 3. File findings for every asserted status

For each **asserted** status, apply the severity rubric (rule 3) and write:

```markdown
Claim: <status word and where it appears>
Producer: <file:line function name>
Classification: asserted
Severity: high/low
Fix: probe it (name the real check to add), generate it (derive from a registry/config that is itself kept honest), or soften the language (hedge the label to match what is actually known)
```

This step is complete only when every asserted status in scope has a filed finding with a fix direction, and every derived/hedged status is confirmed correct (not silently asserted behind a computed-looking name).

### 4. Report

Write the report under `docs/scip-query/` unless the user asked only for a conversational answer.

```markdown
Scope:
Status words inventoried: N
Classified: <d> derived / <h> hedged / <a> asserted — must sum to N; a gap is an unfinished audit

Claim table:
| Claim | Producer | Classification | Fix |
| --- | --- | --- | --- |

Fixed since last audit:
- <claim> — now derived via <probe>, no longer a finding.
```

The audit is complete only when every status word in scope is classified and every asserted, trust-bearing claim has a filed finding.
