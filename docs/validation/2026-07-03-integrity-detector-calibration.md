# External calibration: not-implemented / decorative-checkers / test-quality (integrity-detectors D4)

Targets: `/Users/aydansalois/Documents/GitHub/Vega_2.0` and `/Users/aydansalois/Documents/GitHub/Stable_Management`
(both read-only; all queries invoked via `SCIP_QUERY_PROJECT_ROOT=<repo> node dist/cli.js <cmd>` against
the local dev build, no clone needed — no command used here mutates a target repo's tracked files).
Dogfooded against this repo (scip-query itself) throughout. This report covers the three detectors added in
`docs/plans/2026-07-03-integrity-detectors.md` (D1 `not-implemented`, D2 `decorative-checkers`,
D3 `test-quality`); it does not re-run the full existing battery (see the 2026-07-01 external-calibration
reports for that).

## 1. Environment

| | Vega_2.0 | Stable_Management |
|---|---|---|
| Languages | typescript, python | typescript |
| Symbols (post-reindex) | 112,973 | 109,411 |
| Files | 1,867 | 1,625 |
| Capabilities | SCIP indexing, TS semantic, heuristic detectors all AVAILABLE | same |
| git status --porcelain (before) | 248 lines | 3 lines |
| git status --porcelain (after) | 35 lines | 3 lines |

Vega_2.0's working tree line count dropped between before/after — not this session's doing (no git
command was ever run against Vega_2.0; only `scip-query` read/reindex commands and file `Read`s). Per the
task's own note, another process/user may be concurrently active in that tree; Stable_Management's count
was unchanged (3→3), consistent with no interference there. Neither repo's tracked files were staged,
reverted, or edited by this session.

## 2. Battery sweep (initial, before any detector fixes)

| Detector | Vega_2.0 | Stable_Management |
|---|---|---|
| `not-implemented --full` | 8 | 34 |
| `decorative-checkers --full` | 18 | 94 |
| `test-quality --full` (assertionFree / skipped / mockEcho) | 15 / 2 / 11 | 34 / 0 / 2 |

## 3. Sample and classify — the actual calibration

Every finding cited below was read at its file:line before classification (not judged from the finding
text). D1's 8 Vega findings were all 8 sampled (fewer than the floor); D1's 34 Stable findings were
spot-checked (5+, all one shape, confirmed by re-deriving the by-stubKind breakdown — all 34 were
`empty-body`). D2's 18 Vega findings were all 18 sampled; a spot sample of Stable's 94 (8+) was read
before and after each fix round. D3 was sampled across all three sub-checks on both repos.

### D1 `not-implemented` — 0% actionable pre-fix, fixed, 0 findings post-fix

**Archetype (100% of sampled findings, both repos):** a value declaration whose only braces are an
empty-object-literal **call argument** (`Schema.Struct({})`, `z.object({})`, `apiEndpoint('GET /x', {})`)
or an empty-object **default parameter** on a concise-body arrow (`(opts = {}) => apiClient.getData(...)`).
Neither is a function body; `extractImplementationBody`'s naive `indexOf('{')`/`lastIndexOf('}')` slice
found *a* brace pair (not necessarily the function's own) and, for the default-param case, sliced between
the *only* brace pair in the whole snippet — empty either way.

Examples read: `apps/web/src/api/github.ts:182`, `apps/api/.../proposal-backlog-schemas.ts:148`
(`Schema.Struct({})`), `apps/web/src/api/billing.ts:38` (concise arrow, `{}` default param) — Vega_2.0.
`frontend/.../servicePlans.ts:33` (`apiEndpoint('GET /service-plans/manage', {})`) and 10+ near-identical
siblings — Stable_Management.

**Fixed**: `isGenuineEmptyFunctionBody` now requires the snippet's own trailing shape to be `=> {}` or
`) {}` (optionally with a return-type annotation in between) — an object-literal call argument always has
a further `)` after its `}`, so it can never match. Locked in with regression fixtures + witnessed revert
probes (`src/queries/cleanup/not-implemented.ts`, `tests/queries/cleanup/not-implemented.test.ts`).

**Post-fix**: 0 findings on both repos (and on this repo). No live samples remain to classify further;
true-positive detection is verified via this repo's own fixture suite (throw-stub, todo-return-default,
empty-body, override-exemption — all covered with witnessed revert probes) rather than a live external hit.

**Verdict: standalone-command-only.** Zero live findings on either calibration repo (or this one) after
the fix means there is no positive-precision evidence to justify health or diff-gate wiring yet — the
honest read is "insufficient live-fire evidence," not "clean." Re-run this calibration if/when it ever
fires on a real repo.

### D2 `decorative-checkers` — pre-fix ~0% actionable (0/26 sampled), post-fix still ~0% on the residual

**Archetype 1 — not a function at all (fixed):** a checker-named `const` matching the null-kind
arrow-const fallback heuristic that is actually a boolean expression (`const isRender = process.env.RENDER
=== 'true' || ...`) or a schema-builder value (`const validateInvitationSchema = z.object({...})`). Found
duplicated verbatim in two Vega files (`apps/api/src/config/index.ts:6`,
`apps/api/src/middleware/rateLimit.middleware.ts:20`) plus three schema-object cases
(`packages/shared/src/schemas/auth.ts:51,62`, `packages/shared/src/schemas/billing.ts:48`).
Fixed with `CALLABLE_SHAPE_PATTERN` (requires `function`, `=>`, or a parameter-list-close directly
followed by `{`).

**Archetype 2 — concise-arrow implicit return (fixed):** a braceless arrow body has no `return` keyword
to find, so a genuinely dynamic predicate (`isTimeoutLikeAbortError = (error) => isAbortError(error) ||
(...)`, `web-research-contracts.ts:29`) or an API-client call that happens to be named like a checker
(`checkIssueDuplicates = (id, input) => apiClient.postData(...)`, `apps/web/src/api/issues.ts:42`) both
looked decorative. Fixed with `isConciseArrowBody` treating the whole extracted body as one implicit
return expression.

**Archetype 3 — diagnostic-sink failure signal (fixed):** the single dominant shape once 1–2 were fixed —
a validator reports failure via `ctx.addIssue({...})` (Zod's `RefinementCtx` idiom;
`backend/src/schemas/facilities.ts:57,73,127`, `maintenance.ts:104`, `servicePlans.ts:23,48,131`,
`serviceTasks.ts:34,144` on Stable — 9 of the original 11 spot-checked Stable findings were this exact
shape) or pushes onto a caller-supplied `errors`/`diagnostics` array (this repo's own
`src/runtime/config.ts`, `src/tla/conformance.ts`, `src/tla/model-contract.ts` — 10 of this repo's own 15
dogfood findings). Fixed with `DIAGNOSTIC_SINK_PATTERN` (`.addIssue(` / `.push(`).

**Remaining, NOT fixed (documented, out of "one hop" scope):**
- **Multi-hop delegation through a wrapping utility**: `assertRequestCompanionOrganizationScope`
  (`apps/api/src/middleware/access-policy-request-gateway.ts:62`) awaits a memoization wrapper whose
  callback argument calls the real assertion two levels down — `isThinForwarderBody`'s ≤2-statement,
  single-call shape doesn't match, so one-hop resolution never triggers.
- **Guard-clauses-then-delegate tail call**: `assertUserLimitAllowsUserId`,
  `assertCanAddUser`, `assertCanAddUserByEmail` (`instance-settings.service.ts:219,233,245`) and
  `validateModelProfileTuning` (`ai-provider.manager.ts:1010`) — 2–3 early-return guard statements
  followed by a delegating tail call; not a single-statement thin-forwarder, so the direct-body check
  (correctly) finds no local throw and the one-hop resolver (correctly, per its own narrow contract)
  never engages.
- **Indirect diagnostics helper, one more hop away**: `validateCompanionClient`/
  `validateCompanionRedirectUri` (`auth.routes.ts:67,76`) call a named helper
  (`addUnknownCompanionClientIssue(ctx)`) that itself calls `ctx.addIssue` — the diagnostic-sink pattern
  isn't literally in THIS function's own text.
- **Library-specific control flow**: `assertVetFacilityBelongsToStable` (`incidents.ts:262`) is an
  `Effect.gen(function* () { ... })` generator; Effect-TS failure is expressed through the generator's
  `yield*`/`Effect.fail` machinery, invisible to plain-JS throw/return-based pattern matching.

**Counts**: 18 → 8 (Vega), 94 → 2 (Stable) after the three fixes (91% finding-volume reduction); this
repo's own dogfood count: 15 → 10 (dropped by the same three archetypes; the residual 10 are all the
"indirect diagnostics helper" shape, already the known, ledgered noise class).

**Verdict: standalone-command-only.** Even after three real, well-scoped bug fixes cutting volume by 91%,
every sampled finding in the residual (8 Vega + 2 Stable + 10 dogfood = 20) is still noise — all four
remaining archetypes require either deeper call-graph resolution than "one hop" or awareness of a specific
control-flow library, both legitimately out of this drill's scope. Measured precision on live samples is
0% both before and after fixing; this does not clear the ≥~80% bar for health, and should not gate
diff-gate either. File the four remaining archetypes as followups (below) rather than keep patching.

### D3 `test-quality` — high precision on assertion-free/skipped post-fix; mock-echo intentionally low-precision by design

**Bug (not an archetype — a real parsing defect, fixed):** the block-detection regex matched `.test(` on
a RegExp/string **method** call (`/pattern/i.test(sql)`) as if it were a vitest `test(...)` **block**
declaration. Found in `apps/api/src/db/__tests__/supabase-config.test.ts:39-40` — two `expect(...).toBe
(true)` assertions immediately followed two `.test(sql)` regex checks; both got hijacked into fake
"(anonymous)" blocks, and the REAL enclosing `it(...)` block's genuine assertions were never even scanned
for the real block boundary. This alone accounted for roughly half of both repos' pre-fix assertionFree
counts (15→5 Vega, 34→5 Stable after fixing just this). Fixed with a negative lookbehind excluding a
preceding `.` — vitest/jest test-block globals are always called bare or as `it.skip(...)`-style chains
off the bare name, never as a method on some other value.

**Two further real gaps (fixed):**
- `expectTypeOf<T>().toEqualTypeOf<U>()` (vitest's compile-time type-assertion API) wasn't recognized —
  the per-name vocabulary regex required whitespace-then-`(` immediately after the name, not accounting
  for a TS generic type argument in between (`apps/api/.../coding-agent-contracts.test.ts:38`).
- A test that manually collects failures into an array and `throw`s a descriptive `Error` (a legitimate,
  common "collect-then-throw" assertion style; expect() failures throw internally too) wasn't recognized
  by the vocabulary-only check at all (`apps/web/.../preview-mocks.coverage.test.ts:130,155`).

**Post-fix counts and classification:**
- **assertionFree**: 15→2 (Vega), 34→1 (Stable). All 3 remaining are `severity: 'low'` await-only smoke
  tests, sampled and confirmed genuinely assertion-free — **true positives**, exactly the archetype the
  drill design calls out for lower-severity (not skipped) reporting.
- **skipped**: 2 findings (Vega only), both read and both correct: `it.skip(...)` at
  `IssueDetailPanel.realtime-updates.test.tsx:427` (86 days old, comment above says the tested feature was
  removed — correctly `rot`) and `describe.skip('IssueHoverWrapper', ...)` at
  `IssueHoverPreview.test.tsx:58` (44 days, comment above explains an active feature flag — correctly
  `workflow`, under the 60-day threshold). **2/2 true positives.**
- **mockEcho**: 11 (Vega) + 2 (Stable) = 13. Sampled 5+: every one read is the SAME archetype —
  `mockResolvedValueOnce('x')` (or a number) stubs a dependency, and the assertion checks that the value
  correctly *flowed through real application logic* to a derived value (`exposed.data.value`,
  `subscriptionService.getCurrentUsage(...)`'s return), not that the mock's own call site echoes itself.
  Example: `frontend/.../useResource.spec.ts:90` — `mockResolvedValueOnce('x')` then
  `expect(exposed.data.value).toBe('x')` verifies the composable actually plumbs the resolved value into
  reactive state; `apps/api/.../subscription.service.test.ts:371` — `mockResolvedValueOnce(123)` then
  `expect(result).toBe(123)` verifies `getCurrentUsage` routes the value unchanged. This is the EXACT
  trade-off the drill design named up front ("high precision, low recall... do not chase dataflow") —
  syntactically these are 100% correct same-literal matches; semantically most are legitimate
  flow-through tests, and telling the two apart requires dataflow tracing this sub-check explicitly
  declines to do. **Not a bug; the designed recall ceiling.**

**Verdict, per sub-check** (test-quality reports three independently, so the wiring decision is per
sub-check, not the whole command):
- **assertion-free: KEEP, standalone + health-eligible.** 3/3 sampled post-fix findings on external repos
  are true positives (100%, small n — treat as a strong signal, re-check as volume grows), and the
  severity tiering (low for await-only, high otherwise) is doing real work. Clears the ≥~80% bar for a
  health dimension.
- **skipped: KEEP, standalone + health-eligible.** 2/2 true positives, and the git-blame rot/workflow
  split correctly separated a genuinely-dead skip from an intentional, documented one.
- **mock-echo: standalone-only, advisory.** Precision on "is this a real bug" is low by design (most
  sampled hits are legitimate flow-through tests); still useful as a low-volume, human-reviewed candidate
  list, but do not gate anything on it.

## 4. Dogfood (this repo)

Ran all three detectors against scip-query's own index throughout D1–D3 development, not just at the end
— every bug fix above except the D2/D3 "diagnostic-sink"/"one more hop" residuals was found first by
running the detector against this repo or the external repos before shipping, never after. Final state:

- `not-implemented --full`: 0 findings.
- `decorative-checkers --full`: 10 findings, all `src/runtime/config.ts` / `src/tla/conformance.ts` /
  `src/tla/model-contract.ts` — the "indirect diagnostics helper" residual archetype (documented above,
  not fixed). Disposition: **ledgered** (see followups below), not fixed — the fix would require chasing
  call chains through arbitrary depth, the same scope boundary that applies to the external-repo
  residuals.
- `test-quality --full`: 0 findings (this repo's own test suite has no assertion-free/skipped/mock-echo
  hits once the `.test(` bug and the two vocabulary gaps were fixed).

## 5. Followup ledger entries (noise archetypes, filed rather than chased further)

1. **decorative-checkers / multi-hop delegation.** A checker whose real failure path is reached through
   more than one call hop (a wrapping/memoizing utility, or 2+ guard-clause statements before a
   delegating tail call) reads as decorative. Fixing this generally requires either widening
   `isThinForwarderBody`'s shape (risky — starts to blur into "any body that ends in a call") or a real
   multi-hop call-graph walk. Not attempted here; 20/20 residual samples across two repos plus this repo's
   own dogfood are this shape or a close cousin.
2. **decorative-checkers / Effect-TS (or similar effect-system) generators.** A checker body wrapped in
   `Effect.gen(function* () {...})` (or equivalent generator-based effect composition) has its real
   control flow inside generator `yield*` sequencing that plain throw/return pattern matching can't see.
   Framework-specific; would need a dedicated Effect-TS-aware pass.
3. **test-quality / mock-echo flow-through.** The designed recall ceiling (see §3) — not a bug, but worth
   recording as the expected steady-state noise rate for anyone tuning `--limit` or deciding whether to
   review mock-echo output routinely.

## 6. Wiring decisions summary

| Detector | Measured precision (post-fix) | Decision | Justifying number |
|---|---|---|---|
| `not-implemented` | 0 live findings on either repo post-fix (was 0/42 pre-fix) | standalone-only | No positive evidence to gate on; re-calibrate if it ever fires live. |
| `decorative-checkers` | 0/20 residual samples actionable (91% volume cut, but 0% of what's left) | standalone-only | Below the ≥~80% health bar and not diff-gate-safe; 4 named archetypes, all "resolve deeper than one hop" or library-specific. |
| `test-quality` assertion-free | 3/3 sampled | standalone + health-eligible | Clears ≥~80% bar (small-n, re-check as volume grows). |
| `test-quality` skipped | 2/2 sampled | standalone + health-eligible | Clears ≥~80% bar; git-blame rot/workflow split verified correct on both samples. |
| `test-quality` mock-echo | ~0/5+ sampled were genuine bugs (by design) | standalone-only, advisory | Explicitly low-recall-by-design sub-check; useful as a reviewed list, not a gate. |

No detector here is wired into diff-gate as a blocking check (per the plan: "advisory first — no new
blocking checks in this plan"). None reached the health bar except test-quality's assertion-free and
skipped sub-checks; health wiring for those two is deferred to a followup item rather than done inline in
this calibration pass, since health dimension wiring is its own contract (weighting, baseline behavior)
worth a dedicated look rather than a drive-by addition here.
