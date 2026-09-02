---
name: scip-claim-audit
description: Audit output-facing status claims for evidence with scip-query. Use to classify whether an "available", "verified", "safe", "PASS", or "complete" status word is derived from a real check, hedged as a candidate, or merely asserted without being probed.
metadata:
  commands:
    - template: 'scip-query search <text>'
      when: 'Inventory: locate every status word and the renderer or JSON field that surfaces it.'
    - template: 'scip-query refs <symbol>'
      when: 'Classify: find every producer and consumer of a status-bearing function.'
    - template: 'scip-query code <selector>'
      when: 'Classify: read the producing function to see whether it computes or asserts.'
    - template: 'scip-query trace <symbol>'
      when: 'Classify: definition plus every reference for a status field or constant.'
    - template: 'scip-query capabilities --matrix'
      when: 'Spot-check: a known derived-status surface to calibrate what derived looks like here.'
---

# scip-claim-audit

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Command and question manual

| Command syntax | Question it answers |
| --- | --- |
| `scip-query search <text>` | Inventory: locate every status word and the renderer or JSON field that surfaces it. |
| `scip-query refs <symbol>` | Classify: find every producer and consumer of a status-bearing function. |
| `scip-query code <selector>` | Classify: read the producing function to see whether it computes or asserts. |
| `scip-query trace <symbol>` | Classify: definition plus every reference for a status field or constant. |
| `scip-query capabilities --matrix` | Spot-check: a known derived-status surface to calibrate what derived looks like here. |

These commands are controls, not a checklist. Use every capability needed by the task, but make each query answer a distinct question. There is no required sequence or query limit. Run a command's `--help` when you need a flag not shown in its template.
<!-- END GENERATED SKILL COMMANDS -->

Use this skill to find agent-facing claims that sound verified but are not. A status word is **derived** when its producer computes it from a real probe, scan, or computation (a compiler run, a runtime capability probe, a graph traversal). It is **hedged** when the code or its label already says it is a candidate, heuristic, or unverified. It is **asserted** when the value is a constant, a hardcoded table entry, or a string literal presented with the same confidence as a derived value but backed by nothing the code actually checked at that call site.

Asserted status words that are agent-facing and trust-bearing, meaning an agent would route a decision ("use this evidence", "skip this check", "delete this") based on the word, are the highest-severity class this skill exists to find.

`$scip-integrity-audit` asks whether checkers can fail. This skill asks whether the words the system prints about itself were ever computed. Run this one over a status surface; run that one over the checkers behind it.

## Rules

1. Ground every claim in the producing function's source, not its label or variable name alone. A variable named `verified` that is never checked against a real result is still asserted.
2. Classify status, do not just list it: every status word in scope gets exactly one of derived, hedged, or asserted.
3. Severity follows the rubric: asserted plus agent-facing plus trust-bearing is high; asserted plus internal-only or low-consequence is low; hedged is not a finding, because the label already discloses uncertainty.
4. A status that used to be asserted and now calls a real probe is fixed. Say so and move on; do not re-report it.
5. File findings as a table, not prose. Claim, producer, classification, fix is the deliverable.

## Workflow

### 1. Inventory the status vocabulary

Search the target scope (a file, module, or command family) for user-visible or JSON-facing status words: `available`, `unavailable`, `partial`, `verified`, `safe`, `PASS`, `FAIL`, `complete`, `derived`, `asserted`. For each hit, note the file:line and the renderer or JSON field that surfaces it to an agent or user.

```bash
scip-query search verified -s <scope>
scip-query search PASS -s <scope>
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
- **Hedged**: the label, evidence tier, or surrounding text already marks the value as heuristic, candidate, or unverified.
- **Asserted**: the value is a literal, a static table lookup, or a branch that returns a fixed status without invoking any check for that specific branch.

Use `scip-query capabilities --matrix` as a spot-check: it is a known derived-status surface, useful for calibrating what "derived" looks like in this codebase before judging ambiguous cases.

This step is complete only when every producer has one of these three labels with the one line of source evidence that justifies it.

### 3. File findings for every asserted status

For each **asserted** status, apply the severity rubric and write:

```markdown
Claim: <status word and where it appears>
Producer: <file:line function name>
Classification: asserted
Severity: high | low
Fix: probe it (name the real check to add), generate it (derive from a registry or config that is itself kept honest), or soften the language (hedge the label to match what is actually known)
```

This step is complete only when every asserted status in scope has a filed finding with a fix direction, and every derived or hedged status is confirmed correct rather than silently asserted behind a computed-looking name.

### 4. Report

Write the report under `docs/scip-query/` unless the user asked only for a conversational answer.

```markdown
Scope:
Status words inventoried: N
Classified: <d> derived / <h> hedged / <a> asserted (must sum to N; a gap is an unfinished audit)

Claim table:
| Claim | Producer | Classification | Fix |
| --- | --- | --- | --- |

Fixed since last audit:

- <claim>: now derived via <probe>, no longer a finding.
```

The audit is complete only when every status word in scope is classified and every asserted, trust-bearing claim has a filed finding.
