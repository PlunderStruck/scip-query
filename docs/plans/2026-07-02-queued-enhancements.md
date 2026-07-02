# Queued enhancements batch — 2026-07-02

The post-bug-backlog enhancement queue, gathered from `docs/plans/2026-07-02-release-readiness.md`
24.6 (deferrals), the TLA exemplar introspection (skill loop protocol), and followup #16's residual.
Release 0.11.0 publish is intentionally held until this batch lands.

Working agreement: one commit per step; full gate set per step (`npm test`, `npx tsc --noEmit`,
eslint error-count on `src tests tsup.config.ts` == 0, `npm run lint`, `npm run build`);
failing-test-first for every behavior change; explicit-path staging only; deviation protocol =
BLOCKED-note and continue, never improvise silently. Skill text edits (conductor commit-cadence
scar rule, TLA trace-coverage rule) were applied by the orchestrator before this plan and are not
steps here.

## Q1 — twin-drift → health integration

- **What**: `health` has no dimension for drifted same-name twins even though `twin-drift`
  (post-delegation-exclusion, post-`<constructor>` retune) is now high-precision. Health consumers
  never see concept drift.
- **Where**: `src/queries/health/health.ts` (dimension assembly, see the `scoreCount`/`scoreWeight`
  helpers around lines 582–802), `src/queries/internal/health-detector-profiles.ts`
  (HEALTH_DETECTOR_PROFILES), `src/queries/cleanup/twin-drift.ts` (`allTwinGroups`).
- **Change**: add a twin-drift dimension to health: count `divergent` and `identical` twin groups
  (post all exclusions) in scope, weighted like other structural dimensions. MUST go through the
  same evidence/sidecar caching contract as the other health hot paths — the warm-path budget is
  ~200ms on this repo and byte-identical output on unchanged input is an invariant
  (`docs/architecture/evidence-cache-invalidation.md`); if twin-drift is too slow to compute inline
  at health time on a large index, compute it through the existing cached-product mechanism with a
  written invalidation key, or cap with the shared analysisBudget disclosure.
- **Validation**: health on this repo still 100/100 or a justified delta with the finding visible;
  a fixture repo with a genuinely divergent twin pair scores below one without; warm-path timing
  within budget (compare `time scip-query health` before/after on this repo); byte-identical
  output on a repeated run.
- **Docs**: health scoring doc/`docs/COMMAND_REFERENCE.md` if dimension lists are enumerated
  anywhere (check coverage contracts — enumeration rot is a gate check).

## Q2 — TLA statement-alias tier for SQL-backed state

- **What**: SQL/prepared-statement-backed state is statically invisible today; the skill mandates
  unmatchable alias + waiver (Mapping Discipline, "three state backings"). The finding-outcome
  ledger model had to waive its central variable. Make SQL-backed state provable.
- **Where**: `src/tla/model-contract.ts` (`TlaVariableMapping`, parse + collision validation —
  mirror the existing `resource: {path}` tier at lines ~34, ~287, ~334), `src/tla/conformance.ts`
  (write/read collection — mirror the resource-binding classification added in P5.1).
- **Change**: `variables.<v>.statements: [{ "pattern": "<substring or regex>" }]` binds a variable
  to SQL statement text: a call whose string-literal argument (template literals included, on the
  static text parts) matches a pattern is classified as a write (INSERT/UPDATE/DELETE/REPLACE) or
  read (SELECT) of the variable. Same collision rule as resource paths: two variables matching the
  same pattern is a mapping error. Waivers remain for genuinely dynamic SQL.
- **Validation**: regression fixture with a prepared `INSERT INTO finding_outcomes` statement is
  attributed as a write; a SELECT as a read; dynamic string concat falls through to waiver;
  collision rejected by `loadTlaModelContract`. Then re-map the real
  `specs/evidence-cache/FindingOutcomeLedger.scip-tla.json` ledger variable from unmatchable-alias
  to a statement binding and show `tla verify` proves what was previously waived (fewer waivers,
  PASS retained).
- **Docs**: skill Mapping Discipline "three state backings" bullet must be updated (SQL-backed
  state is now provable via `statements`); `docs/COMMAND_REFERENCE.md` tla mapping schema section.

## Q3 — TLA Init-binding support

- **What**: mappings cannot bind the model's `Init` to code referents, so lazy-init factories are
  waived and whole-file sweeps need `unmappedWriteScope: "actions"` as a workaround (skill Mapping
  Discipline, "Lazy initialization is Init"; exemplar's `DisabledServeAttempt` misattribution came
  from exactly this gap).
- **Where**: `src/tla/model-contract.ts` (top-level `init?: { codeRefs: [...], waive? }` mapping
  entry, parsed like an action mapping), `src/tla/conformance.ts` (writes found inside Init
  codeRefs attribute to Init, not to unmapped-action findings).
- **Change**: allow `"init": { "codeRefs": ["file#function", ...] }` in `.scip-tla.json`. Writes
  statically found in an Init referent are Init-attributed: they satisfy "variable X is written by
  Init's referent" facts and are excluded from unmapped-write findings without needing
  `unmappedWriteScope`. Init referents must not overlap action codeRefs (validation error).
- **Validation**: fixture with a lazy factory bound to init: previously-unmapped writes disappear
  from findings without `unmappedWriteScope`; overlap with an action codeRef rejected. Re-map
  `specs/evidence-cache/EvidenceCacheCoherence.scip-tla.json`'s lazy-init case (connectionFor) to
  an init binding and keep `tla verify` PASS with strictly fewer waivers/scopes.
- **Docs**: update the skill's "Lazy initialization is Init, not an action" bullet — mappings CAN
  now bind Init; the rule becomes "map the factory to init, never to an action."

## Q4 — behavioral A/B scaffold (`twin-ab`)

- **What**: scip-integrity-audit drill 5 ("cross-examine same-concept twins: feed both the same
  input and require the same answer") has no mechanical support — deferred as "behavioral A/B" in
  24.6. v1 is a scaffold generator, NOT an auto-executor: generating inputs for arbitrary types is
  a rabbit hole; the agent fills input slots and runs the test.
- **Where**: new `src/queries/cleanup/twin-ab.ts` + command registration (follow the 7-touchpoint
  command-registration ripple: command spec, handler, public-query-entries if applicable,
  docs:commands regeneration with manual stdout splice, COMMAND_REFERENCE, skill command
  shortlists that should carry it — scip-integrity-audit's frontmatter commands list, BUILTIN
  docs).
- **Change**: `scip-query twin-ab <symbolA> <symbolB> [--out <path>]` — resolves both symbols,
  verifies both are callable and reports signature compatibility (param counts; types when
  ts-morph is warm), then emits a ready-to-fill vitest file importing both symbols with a
  table-driven `it.each` comparing outputs on shared inputs, TODO markers for the input table, and
  a header comment naming the drill and the twin pair. Default `--out` under the scratchpad-style
  path the repo uses for generated artifacts (check existing conventions — `tla scaffold` has one).
  Refuse (with a clear message) symbols that aren't callable or can't be imported (not exported).
- **Validation**: generated file for a real exported twin pair TS-compiles (mirror the
  `tla instrument` TS-compile regression test — that bug shipped uncompilable generated code once
  already); non-exported symbol refused with actionable message; docs/commands regenerated.
- **Docs**: scip-integrity-audit drill 5 gains one sentence pointing at `twin-ab`.

## Explicitly out of batch

- Followup #16 residual (catalog `isPreciseMixedFallbackRow` filter starving class fields) —
  repo-wide blast radius (members/refs/trace/health), documented boundary stands.
- Plan 6 gated phases (per-file TS program reuse, cross-checkout cache) — still gated on seed-doc
  open questions.
- Vega TLA mapping refresh — external repo, on request.
