# Claims: derived, hedged, or asserted?

Classify whether an "available", "verified", "safe", "PASS", or "complete"
status word is derived from a real check, hedged as a candidate, or merely
asserted without being probed.

Command shortlist: `files <pattern>` (inventory), `refs <symbol>` /
`code <symbol>` / `trace <symbol>` (classify), `capabilities --matrix --json`
(spot-check against a known-good derived surface).

## Taxonomy

- **Derived** — the producer computes the value from a real probe, scan, or
  computation (a compiler run, a runtime capability probe, a graph
  traversal).
- **Hedged** — the code or its label already says it is a candidate,
  heuristic, or unverified. Hedged is not a finding — the label already
  discloses the uncertainty.
- **Asserted** — the value is a constant, a hardcoded table entry, or a
  string literal presented with the same confidence as a derived value but
  backed by nothing the code actually checked at that call site.

Asserted status words that are agent-facing and trust-bearing — an agent
would route a decision ("use this evidence", "skip this check", "delete
this") based on the word — are the highest-severity class this audit exists
to find.

Ground every claim in the producing function's source, not its label or
variable name alone: a variable named `verified` that is never checked
against a real result is still asserted. Every status word in scope gets
exactly one of the three labels.

## Severity rubric

Asserted + agent-facing + trust-bearing = high. Asserted + internal-only or
low-consequence = low. Hedged is not a finding.

A status that used to be asserted and now calls a real probe is fixed — say
so and move on, do not re-report it.

## Step 1 — Inventory

Grep the target scope (a file, module, or command family) for user-visible
or JSON-facing status words (`available`, `unavailable`, `partial`,
`verified`, `safe`, `PASS`, `FAIL`, `complete`, `derived`, `asserted`),
noting the file:line and the renderer or JSON field surfacing each hit. Use
`scip-query files <target-file-or-pattern>` to locate the renderer or
status-producing module for a claim.

**Complete when:** every status-bearing string or field in scope is listed
with its surface (human output, `--json` field, or both).

## Step 2 — Classify

For each status word's producing function, run `refs`, `code`, and `trace`,
read the function body, and classify it as derived (computed from a probe,
scan, spawn result, file check, or graph query performed at or near that
call site), hedged, or asserted.

**Complete when:** every producer has one of the three labels with the one
line of source evidence that justifies it.

Use `scip-query capabilities --matrix --json` as a spot-check: an
already-known example of a fixed derived-status surface, useful for
calibrating what "derived" looks like in this codebase before judging
ambiguous cases.

## Step 3 — File and fix

File findings as a table, not prose. Finding format:

- **Claim** — the status word and where it appears.
- **Producer** — file:line, function name.
- **Classification** — asserted.
- **Severity** — high or low (per the rubric above).
- **Fix** — probe it (name the real check to add), generate it (derive from
  a registry/config that is itself kept honest), or soften the language
  (hedge the label to match what is actually known).

**Complete when:** every asserted status in scope has a filed finding with a
fix direction, and every derived/hedged status is confirmed correct (not
silently asserted behind a computed-looking name).

## Report

Write the audit report under `docs/scip-query/` unless the user asked only
for a conversational answer. Template:

- Scope
- Status words inventoried: N
- Classified: `<d>` derived / `<h>` hedged / `<a>` asserted — must sum to N;
  a gap is an unfinished audit
- Claim table: Claim, Producer, Classification, Fix
- "Fixed since last audit" — claims now derived that were previously
  reported asserted

The audit is complete only when every status word in scope is classified and
every asserted, trust-bearing claim has a filed finding.
