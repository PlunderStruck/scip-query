# TLA capability trio — 2026-07-02

Three next-tier TLA capabilities earned by the Vega modernization: an ORM-call attribution tier
(Vega's Drizzle writes couldn't use the SQL `statements` tier — no literal SQL exists), a
per-action trace-coverage report (mechanizes the skill's "Trace until covered" rule), and
line-range codeRefs (kills the guard/branch-actions-share-one-function granularity noise that
is most of Vega's residual ~278 errors).

Working agreement: one commit per item; failing-test-first with witnessed revert probes; full
gates per item (npm test, tsc, eslint error-count 0 on `src tests tsup.config.ts`, build,
prettier); explicit-path staging; deviations BLOCKED-noted here.
Reference corpus (READ-ONLY): /Users/aydansalois/Documents/GitHub/Vega_2.0/docs/formal —
real mappings/specs to sanity-check designs against; never edit them.

## C1 — ORM-call attribution tier

- **What**: `variables.<v>.statements` classifies literal SQL text; Drizzle-style ORM calls
  (`db.update(orgSubscriptions).set({...})`, `db.insert(t).values(...)`, `db.select().from(t)`,
  `db.delete(t)`) carry no SQL string, so Vega's DB-backed variables fell back to fragile
  aliases or waivers.
- **Where**: mirror the `statements` tier end to end: `src/tla/model-contract.ts` (parse +
  collision validation), `src/tla/conformance.ts` (write/read classification in both AST and
  source-scan paths, `kind: 'orm-call'` on the fact target).
- **Change**: `variables.<v>.ormCalls: [{ "table": "<identifier>", "methods"?: [...] }]` — a
  call chain whose method set intersects {update, insert, delete} (write) / {select, query,
  findFirst, findMany} (read) AND whose table argument/chain segment matches the `table`
  identifier attributes to the variable. Method lists overridable per entry for nonstandard
  ORMs. Same collision rule as statements: two variables claiming one table identifier with
  overlapping method classes is a load error.
- **Fixture**: a Drizzle-shaped source file — `db.update(orgSubscriptions).set({status})`
  attributes as write, `db.select().from(orgSubscriptions)` as read, `db.update(otherTable)`
  does not attribute; collision fixture rejected at load.
- **Validation extra**: run `tla verify` READ-ONLY against Vega's BillingAccessLifecycle with a
  scratch copy of its mapping (in the scratchpad, NOT in Vega) extended with one ormCalls
  binding, and record the verified-writes delta in this file.

## C2 — trace coverage report

- **What**: the skill mandates "record traces until every Current action with a code twin is
  exercised or classified" but nothing measures it — trace-check verdicts don't say which
  mapped actions were never exercised by any accepted trace.
- **Where**: `src/tla/trace-spec.ts` / `runTraceCheck` (it already matches steps to actions);
  `src/runtime/query-commands/tla.ts` for output.
- **Change**: `tla trace-check ... --coverage` (and always in `--json`): per mapped action with
  codeRefs — steps exercised count across the supplied trace(s); a final `unexercised` list.
  Accept multiple `--trace` inputs (dedupeTracePaths already exists from P5.5). Human output: a
  short coverage table after the verdict; exit code unchanged (coverage informs, doesn't gate).
- **Fixture**: two-action model + trace exercising only one → coverage reports 1 exercised /
  1 unexercised, names the right action; two traces covering both → empty unexercised.

## C3 — line-range codeRefs

- **What**: multiple guard/branch model actions often share one code function; whole-function
  codeRefs force every branch action to claim every write in the function, generating
  model-code-write noise for each sibling (the dominant residual class in Vega: Proposals 110,
  WorkSession 88 errors).
- **Where**: codeRef resolution in `src/tla/model-contract.ts` (parse/validate) and the
  fact-collection range selection in `src/tla/conformance.ts` (`collectWritesForRange`/
  `collectReadsForRange` already operate on ranges — scope them to the sub-range).
- **Change**: codeRef syntax gains an optional line window: `"file#function@L120-L145"` (window
  must fall inside the resolved function's span — load error otherwise, so stale windows fail
  loudly instead of silently scanning the wrong lines). Facts for that action come only from
  the window. Document that windows are line-number-brittle by design: the load-time
  containment check plus `tla verify`'s referent resolution catch drift.
- **Fixture**: one function with two write branches; two actions with disjoint windows each
  attribute only their branch's write; window outside the function span → load error naming
  the file, function, and actual span.

## Closeout

Skill (`skills/scip-tla-model-system/SKILL.md`): Mapping Discipline gains the ormCalls tier in
the state-backings bullet, the trace-coverage command in the "Trace until covered" rule, and
line-windows in a new granularity sentence. `docs/COMMAND_REFERENCE.md` regenerate if descriptors
changed. `scip-query reindex && scip-query diff-gate` — fix or justify. Record here: the C1 Vega
scratch-mapping delta, and confirmation the two dogfood specs still verify unchanged.
