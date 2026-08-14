---
name: scip-integrity-audit
description: Audit whether implementations are real with scip-query. Use for suspected faked or half-implemented features, decorative checkers or verifiers that never fail, dead code paths hidden behind graceful fallbacks, metrics that may be lying, or a "does any of this actually work" interrogation of a system.
metadata:
  commands:
    - template: 'scip-query search <text>'
      when: 'Locate a status word, checker name, adapter, fallback, or metric producer.'
    - template: 'scip-query outline <file>'
      when: 'Inventory the callables in a known file before choosing a drill target.'
    - template: 'scip-query evidence --symbol <symbol> --edge <family> --direction <direction> --depth <n> --max-edges <n>'
      when: 'Project callers, callees, or dataflow around a checker, adapter, fallback, or metric.'
    - template: 'scip-query inspect --at <file:line> --view behavior'
      when: 'Read connected behavior for a named remaining gap after graph evidence.'
    - template: 'scip-query code <selector>'
      when: 'Read exact implementation syntax only when the body itself can change the verdict.'
    - template: 'scip-query decorative-checkers -s <scope> --json'
      when: 'Shortlist validate/verify/check/assert/is/has callables with no reachable failure exit.'
    - template: 'scip-query not-implemented -s <scope> --json'
      when: 'Shortlist reachable placeholder stubs that a real caller can actually reach.'
    - template: 'scip-query test-quality -s <scope> --json'
      when: 'Check regression artifacts and tests for assertion-free bodies, skip rot, and mock-echo.'
    - template: 'scip-query twin-drift -s <scope> --json'
      when: 'Find same-name or near-name twins whose bodies have silently diverged.'
    - template: 'scip-query twin-ab <symbolA> <symbolB>'
      when: 'Scaffold a table-driven comparison of two same-concept twins on a shared input.'
---

# scip-integrity-audit

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Command and question manual

| Command syntax | Question it answers |
| --- | --- |
| `scip-query search <text>` | Locate a status word, checker name, adapter, fallback, or metric producer. |
| `scip-query outline <file>` | Inventory the callables in a known file before choosing a drill target. |
| `scip-query evidence --symbol <symbol> --edge <family> --direction <direction> --depth <n> --max-edges <n>` | Project callers, callees, or dataflow around a checker, adapter, fallback, or metric. |
| `scip-query inspect --at <file:line> --view behavior` | Read connected behavior for a named remaining gap after graph evidence. |
| `scip-query code <selector>` | Read exact implementation syntax only when the body itself can change the verdict. |
| `scip-query decorative-checkers -s <scope> --json` | Shortlist validate/verify/check/assert/is/has callables with no reachable failure exit. |
| `scip-query not-implemented -s <scope> --json` | Shortlist reachable placeholder stubs that a real caller can actually reach. |
| `scip-query test-quality -s <scope> --json` | Check regression artifacts and tests for assertion-free bodies, skip rot, and mock-echo. |
| `scip-query twin-drift -s <scope> --json` | Find same-name or near-name twins whose bodies have silently diverged. |
| `scip-query twin-ab <symbolA> <symbolB>` | Scaffold a table-driven comparison of two same-concept twins on a shared input. |

These commands are controls, not a checklist. Use every capability needed by the task, but make each query answer a distinct question. There is no required sequence or query limit. Run a command's `--help` when you need a flag not shown in its template.
<!-- END GENERATED SKILL COMMANDS -->

Use this skill to interrogate whether a system's claims are backed by real
implementations. Structural review asks "is this well organized?"; this skill
asks **"is this real?"** — it hunts decorative checkers, adapters written
against imagined data, features that have silently never run, and numbers
nobody ever recomputed.

Use `$scip-query` locators and evidence projections to inventory producers.
`health --full` does not run the integrity detectors; call
`decorative-checkers`, `not-implemented`, `test-quality`, and `twin-drift`
directly.

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
`search` on the status words in output, then `evidence` execution incoming
and outgoing). For each one, construct an input that MUST fail — a wrong
binding, a corrupt file, an impossible value — and run it. A checker that
passes its should-fail input is decorative: file it as a defect, not a note.
Before filing, attempt the defense: an accusation triggers a rewrite, so
search for the failure exit the drill may have missed — a config-gated
branch, an async rejection, one-hop delegation (the calibration's known
noise archetypes). File the defect with the executed should-fail input
attached and the defense attempt noted; a defense that succeeds clears the
checker and stays in the record as its witness.
Complete only when every checker in scope has been witnessed rejecting a
constructed should-fail input, or is listed with a reason it cannot be.

Mechanized by: `scip-query decorative-checkers` finds `validate*`/`verify*`/
`check*`/`assert*`/`is*`/`has*` callables with no reachable failure exit
anywhere in their body (calibrated 2026-07-03 against two external repos —
standalone-only; noise archetypes past one-hop delegation in
`docs/validation/2026-07-03-integrity-detector-calibration.md`). Run it first
to shortlist candidates before hand-constructing should-fail inputs.

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
the PRIMARY path runs (a test, a probe, a log). Use `evidence` execution and
`inspect --view behavior` for branch reachability. A fallback that always
fires means the feature above it is dead — date of death: birth.
Complete only when every fallback's primary path has a witness or a filed
defect.

Mechanized by: `scip-query not-implemented` finds reachable placeholder
stubs (`throw new Error('not implemented')`, TODO-comment + return-default,
empty bodies) that a real caller, entry surface, or package-surface export
can actually reach — the graph fact that separates "primary path never
built" from `dead`'s "primary path built but unreferenced." Standalone-only
(calibrated 2026-07-03; 0 live findings on two external repos post-fix, see
the calibration report) — treat a clean run as "nothing this shape found,"
not as "every fallback's primary path is proven live."

### 4. Hand-compute every metric twice

For each number the system reports (scores, counts, estimates): pick two
concrete instances, compute the expected value by hand from first
principles, and compare. Off-by-a-factor errors (double counting, inflated
estimates) survive for years because nobody ever recomputes one sample.
Complete only when every reported metric has two hand-verified samples.

### 5. Cross-examine same-concept twins

Where one concept is computed in more than one place, feed both the same
input and require the same answer. `twin-drift` finds the same-name cases
mechanically; for same-concept-different-name pairs, project consumers with
`evidence` execution incoming and compare implementations with `code`. Once
a pair is identified, `scip-query twin-ab <symbolA> <symbolB>` scaffolds a
table-driven vitest file that imports both and asserts equal output —
fill in the input table and run it. Disagreement between twins means at
least one is wrong — determine which before consolidating.
Complete only when every discovered twin pair has been compared on a shared
input.

## Severity

Rank findings by what the failure does to a user who trusted the output:
a decorative checker or false "verified" banner outranks everything; a
dead-but-fallbacked feature outranks a wrong metric; a wrong metric outranks
structural mess. Structural findings are real, but they are not lies — do
not fold them into the integrity verdict.

## Reporting

File each finding with: the claim as displayed, the producer (file:line),
the drill that exposed it, the should-fail input or real sample used, and
the fix. The audit is complete only when every drill's exit criterion is
met for the scope, and every defect found has a regression artifact — a
test, fixture, or model that fails on the pre-fix behavior.

End with a derived verdict, not an impression:

```markdown
Integrity: <scope> — <c> checkers witnessed failing, <a> adapters diffed
against reality, <f> fallback primaries witnessed live, <m> metrics
recomputed, <t> twins compared; <d> defects filed, <u> unverifiable (reasons)
```

A suspect scope that produces zero defects is itself a claim: state what
made the suspicion wrong, or rerun the drill that should have caught it.

A regression artifact that doesn't actually assert anything, or asserts the
same literal it stubbed into its own mock, is a fake witness — the same
"reports success without doing the work" failure mode this skill hunts in
production code, just relocated to the test suite. Run `scip-query
test-quality -s <scope>` over the audit's own regression artifacts (and,
periodically, over the suite at large) to catch this: assertion-free test
bodies, a skipped-test ledger with git-blame age (a skip with no fix date
attached is a claim nobody is checking), and mock-echo (a test that only
proves its own stub). Standalone-only, mixed precision by sub-check
(calibrated 2026-07-03): assertion-free and skipped are high-precision;
mock-echo is intentionally low-precision (syntactic same-literal matching,
not dataflow) — treat its output as a reviewed candidate list, not a verdict.
