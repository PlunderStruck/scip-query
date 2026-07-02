---
name: scip-integrity-audit
description: Audit whether implementations are real with scip-query. Use for suspected faked or half-implemented features, decorative checkers or verifiers that never fail, dead code paths hidden behind graceful fallbacks, metrics that may be lying, or a "does any of this actually work" interrogation of a system.
commands:
  - scip-query refs <symbol>
  - scip-query code <symbol>
  - scip-query trace <symbol>
  - scip-query call-graph <symbol>
  - scip-query twin-drift -s <scope> --json
  - scip-query outline <file> --signatures
---

# scip-integrity-audit

Use this skill to interrogate whether a system's claims are backed by real
implementations. Structural review asks "is this well organized?"
(`scip-maintainability`); this skill asks **"is this real?"** — it hunts
decorative checkers, adapters written against imagined data, features that
have silently never run, and numbers nobody ever recomputed.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

## The Stance

A green result you have never seen fail is unverified. Every status word,
banner, and metric is testimony from the code, not evidence about the code —
cross-examine the producer before believing it. The most dangerous code is
not broken code; it is code that reports success without doing the work.

## Drills

Run all five over the chosen scope. Each has a checkable exit.

### 1. Falsify every checker

Inventory everything in scope that accepts/rejects, passes/fails, or
validates (checkers, gates, verifiers, validators — find producers with
`refs`/`call-graph` on the status words in output). For each one, construct
an input that MUST fail — a wrong binding, a corrupt file, an impossible
value — and run it. A checker that passes its should-fail input is
decorative: file it as a defect, not a note.
Complete only when every checker in scope has been witnessed rejecting a
constructed should-fail input, or is listed with a reason it cannot be.

### 2. Diff every adapter against captured reality

For each parser/adapter of an external format (tool output, XML/JSON
schemas, protocol messages): obtain ONE real sample from the actual source
and diff it against the code's assumptions and the tests' fixtures. Ask of
every fixture: was this generated from reality, or imagined? A parser and a
hand-written fixture can validate each other's shared hallucination
indefinitely.
Complete only when every adapter has been checked against at least one
captured-real sample.

### 3. Autopsy every fallback

Graceful degradation is where dead features hide: a primary path that has
never worked looks identical to a healthy fallback. For every catch block,
`?? fallback`, and degraded mode in scope: produce an execution witness that
the PRIMARY path runs (a test, a probe, a log). Use `scip-probe-reachability`
for parser/AST branch reachability. A fallback that always fires means the
feature above it is dead — date of death: birth.
Complete only when every fallback's primary path has a witness or a filed
defect.

### 4. Hand-compute every metric twice

For each number the system reports (scores, counts, estimates): pick two
concrete instances, compute the expected value by hand from first
principles, and compare. Off-by-a-factor errors (double counting, inflated
estimates) survive for years because nobody ever recomputes one sample.
Complete only when every reported metric has two hand-verified samples.

### 5. Cross-examine same-concept twins

Where one concept is computed in more than one place, feed both the same
input and require the same answer. `twin-drift` finds the same-name cases
mechanically; for same-concept-different-name pairs, trace the concept's
consumers with `refs` and compare implementations with `code`. Disagreement
between twins means at least one is wrong — determine which before
consolidating.
Complete only when every discovered twin pair has been compared on a shared
input.

## Severity

Rank findings by what the failure does to a user who trusted the output:
a decorative checker or false "verified" banner outranks everything; a
dead-but-fallbacked feature outranks a wrong metric; a wrong metric outranks
structural mess. Route structural findings to `scip-maintainability` —
they are real but they are not lies.

## Reporting

File each finding with: the claim as displayed, the producer (file:line),
the drill that exposed it, the should-fail input or real sample used, and
the fix. The audit is complete only when every drill's exit criterion is
met for the scope, and every defect found has a regression artifact — a
test, fixture, or model that fails on the pre-fix behavior.
