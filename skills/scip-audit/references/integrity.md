# Integrity: is this real?

Structural review (`references/maintainability.md`) asks "is this well
organized?" This drill set asks **"is this real?"** — it hunts decorative
checkers, adapters written against imagined data, features that have
silently never run, and numbers nobody ever recomputed.

Command shortlist: `refs <symbol>`, `code <symbol>`, `trace <symbol>`,
`call-graph <symbol>`, `twin-drift -s <scope> --json`,
`twin-ab <symbolA> <symbolB>`, `outline <file> --signatures`,
`decorative-checkers -s <scope> --json`, `not-implemented -s <scope> --json`,
`test-quality -s <scope> --json`.

## The stance

A green result you have never seen fail is unverified: every status word,
banner, and metric is testimony from the code, not evidence about the code,
so cross-examine the producer before believing it. The most dangerous code
is not broken code; it is code that reports success without doing the work.

## Run all five drills over the chosen scope

### Drill 1 — Falsify every checker

Inventory everything in scope that accepts/rejects, passes/fails, or
validates (checkers, gates, verifiers, validators) by finding producers with
`refs`/`call-graph` on the status words in their output.

For each one found, construct an input that MUST fail — a wrong binding, a
corrupt file, an impossible value — and run it. A checker that passes its
should-fail input is decorative and must be filed as a defect, not a note.

Before filing, attempt the defense: an accusation triggers a rewrite, so
search for the failure exit the drill may have missed — a config-gated
branch, an async rejection, or one-hop delegation (the calibration's known
noise archetypes). File the defect with the executed should-fail input
attached and the defense attempt noted; a defense that succeeds clears the
checker and stays in the record as its witness.

**Complete when:** every checker in scope has been witnessed rejecting a
constructed should-fail input, or is listed with a reason it cannot be.

Mechanized by `scip-query decorative-checkers`, which finds
`validate*`/`verify*`/`check*`/`assert*`/`is*`/`has*` callables with no
reachable failure exit anywhere in their body. Run it first to shortlist
candidates before hand-constructing should-fail inputs. It was calibrated
2026-07-03 against two external repos, is standalone-only, and its noise
archetypes past one-hop delegation are documented in
`docs/validation/2026-07-03-integrity-detector-calibration.md`.

### Drill 2 — Diff every adapter against captured reality

For each parser/adapter of an external format (tool output, XML/JSON
schemas, protocol messages), obtain ONE real sample from the actual source
and diff it against the code's assumptions and the tests' fixtures. Ask of
every fixture whether it was generated from reality or imagined. A parser
and a hand-written fixture can validate each other's shared hallucination
indefinitely, so fixture-vs-code agreement alone is not proof of
correctness.

**Complete when:** every adapter has been checked against at least one
captured-real sample.

### Drill 3 — Autopsy every fallback

For every catch block, `??` fallback, and degraded mode in scope, produce an
execution witness (a test, a probe, a log) that the PRIMARY path runs —
because a primary path that has never worked looks identical to a healthy
fallback. Use the probe-reachability mode in `scip-diagnose` for parser/AST
branch reachability
when autopsying fallbacks. A fallback that always fires means the feature
above it is dead — "date of death: birth."

**Complete when:** every fallback's primary path has a witness or a filed
defect.

Mechanized by `scip-query not-implemented`, which finds reachable placeholder
stubs (`throw new Error('not implemented')`, TODO-comment + return-default,
empty bodies) that a real caller, entry surface, or package-surface export
can actually reach — distinguishing "primary path never built" from `dead`'s
"primary path built but unreferenced." Standalone-only (calibrated
2026-07-03; 0 live findings on two external repos post-fix). A clean run
means "nothing this shape found," not proof that every fallback's primary
path is live.

### Drill 4 — Hand-compute every metric twice

For each number the system reports (scores, counts, estimates), pick two
concrete instances, compute the expected value by hand from first
principles, and compare — off-by-a-factor errors (double counting, inflated
estimates) survive for years when nobody recomputes a single sample.

**Complete when:** every reported metric has two hand-verified samples.

### Drill 5 — Cross-examine same-concept twins

Where one concept is computed in more than one place, feed both
implementations the same input and require the same answer. `twin-drift`
finds same-name cases mechanically; same-concept-different-name pairs must be
traced via `refs` and compared via `code` (see `references/twin-drift.md`
for the full drift-classification workflow once a pair is found).

Once a twin pair is identified, `scip-query twin-ab <symbolA> <symbolB>`
scaffolds a table-driven vitest file that imports both implementations and
asserts equal output — fill in the input table and run it. Disagreement
between twins means at least one is wrong — determine which before
consolidating them.

**Complete when:** every discovered twin pair has been compared on a shared
input.

## Severity

Rank findings by what the failure does to a user who trusted the output: a
decorative checker or false "verified" banner outranks everything; a
dead-but-fallbacked feature outranks a wrong metric; a wrong metric outranks
structural mess. Route structural findings to `references/maintainability.md`
instead of reporting them here — they are real but they are not lies.

## Reporting

File each finding with: the claim as displayed, the producer (file:line),
the drill that exposed it, the should-fail input or real sample used, and the
fix. The audit is complete only when every drill's exit criterion is met for
the scope, and every defect found has a regression artifact (a test,
fixture, or model) that fails on the pre-fix behavior.

End with a derived verdict, not an impression:

```
Integrity: <scope> — <c> checkers witnessed failing, <a> adapters diffed
against reality, <f> fallback primaries witnessed live, <m> metrics
recomputed, <t> twins compared; <d> defects filed, <u> unverifiable (reasons)
```

A suspect scope that produces zero defects is itself a claim: state what
made the suspicion wrong, or rerun the drill that should have caught it.

## Your own regression artifacts are in scope too

A regression artifact that doesn't actually assert anything, or asserts the
same literal it stubbed into its own mock, is a fake witness — the same
"reports success without doing the work" failure mode this drill set hunts
in production code, just relocated to the test suite.

Run `scip-query test-quality -s <scope>` over the audit's own regression
artifacts (and periodically over the suite at large) to catch fake
witnesses. It catches assertion-free test bodies, a skipped-test ledger with
git-blame age (a skip with no fix date attached is a claim nobody is
checking), and mock-echo (a test that only proves its own stub).
Standalone-only with mixed precision by sub-check (calibrated 2026-07-03):
assertion-free and skipped are high-precision; mock-echo is intentionally
low-precision (syntactic same-literal matching, not dataflow) — treat its
output as a reviewed candidate list, not a verdict.
