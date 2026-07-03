# Tier-1 integrity detectors — 2026-07-03

Three new detectors extending the "detect fakery" battery, from the 2026-07-03 gap analysis.
The through-line: code that claims something the graph can disprove. Each detector ships with a
CLI command, JSON envelope, health/diff-gate wiring decisions (recorded, not assumed), and —
mandatory before any default-on wiring — a scip-calibrate pass against the Vega_2.0 and
Stable_Management clones (skills/scip-calibrate/SKILL.md is the protocol; targets are
READ-ONLY; work from temp copies for anything mutating).

Working agreement: one commit per detector + one for calibration/closeout; failing-test-first
with witnessed revert probes; full gates per commit (npm test, tsc, eslint error-count 0 on
`src tests tsup.config.ts`, build, prettier); explicit-path staging; command-registration
ripple complete for each new command (mirror twin-ab's registration: descriptor, handler,
queryCommandOrder, queries/index export, docs:commands regeneration, skill shortlist);
deviations BLOCKED-noted here.

## D1 — `not-implemented` (reachable placeholders)

- **What**: stubs that production paths can reach: `throw new Error('not implemented'|'TODO'...)`,
  bodies that are only `// TODO` + return-default, empty function bodies on exported callables.
  The graph fact that makes it precise: reachability from production entry points — reuse the
  entry-point/production classification `production-callables` already has (find it:
  `scip-query refs productionCallables` / grep src/queries/cleanup). A stub behind dead code is
  `dead`'s job; a stub reachable from a route/CLI/exported API is the finding.
- **Output ranks by**: reachability evidence tier, then fan-in of the nearest reachable caller.
- **Fixtures**: reachable throw-stub fires; unreachable stub does not (and is left for `dead`);
  a legitimate abstract-method throw in a base class overridden by all concrete subclasses does
  NOT fire (check overrides via the graph) — that is the known FP archetype to design against.

## D2 — `decorative-checkers` (checkers that cannot fail)

- **What**: mechanize scip-integrity-audit drill 1: a callable matching checker naming
  (`validate*`, `verify*`, `check*`, `assert*`, `is*`/`has*` returning boolean) whose body has
  NO reachable failure exit — no throw, no `return false`/falsy branch, no error-result
  construction (match the repo's result/either shape if one exists), no rejection path.
- **Precision design (the hard part)**: `is*`/`has*` predicates that compute a boolean
  expression (`return a && b`) CAN fail — only flag when every return is literal-true /
  constant-truthy. Delegating checkers (`validateX = () => validateY(x)`) inherit their
  delegate's failure exits — resolve one hop before judging (reuse twin-drift's thin-forwarder
  machinery if it fits; reuse audit first per house rules). Config-disabled checkers
  (`if (!enabled) return true`) are a FP archetype: an early constant-true return plus a real
  failure path below must NOT fire.
- **Fixtures**: constant-true validator fires; throwing validator doesn't; boolean-expression
  predicate doesn't; delegating validator resolving to a throwing implementation doesn't;
  early-exit-plus-real-path doesn't.

## D3 — `test-quality` (the biggest uncovered surface)

Three sub-checks under one command, each independently reportable:

- **assertion-free tests**: `it`/`test` blocks whose body transitively contains no assertion
  call (expect/assert/vitest matchers; detect the repo's assertion vocabulary from imports).
  Await-only smoke tests are a reasonable archetype to report at lower severity, not skip.
- **skipped-test ledger**: `it.skip`/`describe.skip`/`xit`/`todo` inventory with git-blame age
  (skips older than N days are rot, fresh skips are workflow).
- **mock-echo**: a test that asserts a value it itself stubbed into a mock (mock returns X →
  expect(X): the test validates the mock). Start with the syntactic same-literal case
  (mockReturnValue(V) ... expect(...).toBe/toEqual(V) in one test body) — high precision,
  low recall is the right first cut; do not chase dataflow.
- **Note**: test files are not SCIP-indexed (house memory) — this detector works from the
  source-facts layer, scoped by test-file classification (`classifyFile` already knows test
  files).
- **Fixtures**: one per sub-check, both directions.

## D4 — calibration + wiring (the gate for everything above)

- Run the scip-calibrate protocol with the three new detectors against Vega_2.0 and
  Stable_Management (read-only; temp copies for retro-gate replay). Sample ≥10 findings per
  detector per repo, classify FROM THE CODE, record precision + noise archetypes in
  `docs/validation/2026-07-03-integrity-detector-calibration.md`.
- Wiring decision per detector, FROM the measured precision: health dimension (only if ≥~80%
  actionable), diff-gate check (advisory first — no new blocking checks in this plan), or
  standalone-command-only. Record the decision and the number that justified it.
- Dogfood: run all three on this repo; fix or ledger what they find here (that is the first
  live test — this repo has known TODO/stub density near zero, so expect mostly D3 signal).

## Closeout

scip-integrity-audit skill: drills 1 and 3 gain "mechanized by" pointers to D2/D1; a new drill
note for D3. README bundled-skills table unchanged (no new skill). Followup ledger entry for
each noise archetype calibration finds. `scip-query reindex && scip-query diff-gate` — fix or
justify. Full suite.
