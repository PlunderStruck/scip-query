# TLA conformance improvements — 2026-07-02

Everything the Vega mapping modernization proved the TLA subsystem still needs (followups
#23–26 plus one usability gap). Source of truth for the defects: the nine real Vega models —
~470 residual noise findings across five of them trace to these four scanner limitations, and
none could be waived away with reasons. Goal: an honest mapping author can drive every one of
those findings to zero-or-waived without blinding the scanner or editing specs.

Working agreement: one commit per item; failing-test-first (fixtures must reproduce the exact
Vega shapes described); full gates per item (`npm test`, tsc, eslint error-count 0 on
`src tests tsup.config.ts`, `npm run build`, prettier on touched files); explicit-path staging;
deviation protocol = BLOCKED-note here and continue.

## I1 — waiver symmetry: make write-category findings waivable (followup #23)

- **Where**: `src/tla/conformance.ts` (~715–748): `isFactWaived` is consulted only for
  `undeclared-read`/`missing-*-evidence` categories; `model-code-write`, `undeclared-write`,
  and `model-mapping-write` findings ignore action/variable waivers entirely.
- **Change**: consult the same waiver machinery (action-level fact waivers, variable-level
  waivers) for write categories, symmetric with reads. A waived write finding moves to the
  waiver ledger with its reason like any other — same Proof-line accounting, no silent drops.
- **Fixture**: an action mapping with `waive` on a write fact whose finding today survives;
  test asserts it lands in waivers (with reason) post-fix and in findings pre-fix.
- **Why first**: pure asymmetry bug; unblocks honest triage of everything below.

## I2 — SANY operator expansion in action facts (followup #24)

- **Where**: `deriveActionFacts` in `src/tla/sany-facts.ts` — an action defined as
  `Act == Helper1 /\ Helper2` where the helpers contain the primed variables reports
  `writes: none`, because user-defined operator references are not expanded.
- **Change**: expand user-defined operator references transitively (bounded depth, cycle-safe,
  same-module only) when collecting primed variables and reads for an action. UNCHANGED/$Tuple
  handling must keep working (see existing tests). The Vega shape: GitHubWebhookIndexingPipeline's
  `FinishActiveJobFields` / `AttemptOwnFollowUpRestartOrTerminal` helper operators had to be
  mapped directly as a workaround — the fixture should mirror an action delegating all primes
  to one helper.
- **Fixture**: module where `Act == Helper` and `Helper == x' = 1 /\ UNCHANGED y`; facts for
  `Act` must include the write of `x` and the read/unchanged of `y`.

Deviations: applying this repo's own `specs/evidence-cache/EvidenceCacheCoherence.tla` +
mapping through the fixed expansion raises its finding count from 6 to 16 (all new findings are
`model-mapping-read` warnings on `CurrentServeProject`/`DisabledServeAttempt`/etc — actions whose
TLA+ definitions delegate reads through a shared helper operator that expansion now correctly
attributes). 0 errors before and after; exit code unchanged (1 without `--allow-unknown`, 0 with
it) — this is the intended effect of I2 (previously-hidden SANY facts becoming visible), not a
regression. Not fixed here: updating this repo's own mapping to declare the newly-visible reads
is out of scope for I2's unit-level fix; left as a follow-up if desired.

## I3 — opt-out of the forced self-alias (followup #25)

- **Where**: `src/tla/model-contract.ts:426` — `[...new Set([name, ...aliases])]` force-includes
  every variable's own name as an alias; object-literal keys echoing the variable name become
  unavoidable false write attributions.
- **Change**: `variables.<v>.selfAlias: false` opts out (default stays true — backward
  compatible). Validation: `selfAlias: false` with an empty alias list and no
  resource/statements binding and no waive is an error (the variable would be unattributable
  silently) — force the author to choose an honest tier.
- **Fixture**: variable `status` with `selfAlias: false` and a precise alias — an object literal
  `{ status: ... }` in scope no longer attributes; with default settings it still does.

## I4 — stop scoring const declarations as writes (followup #26)

- **Where**: the source-scan fallback write classifier (in `src/tla/conformance.ts` or the
  shared scan helper it uses).
- **Change**: a variable _declaration_ (`const x = ...`, `let x = ...` declaration line) whose
  declared identifier merely equals an alias is not a write to the modeled state — it
  introduces a new local binding. Assignments (`x = ...`, `x.push(...)`, `obj.x = ...`) keep
  attributing. Careful: lazy-init factories assigning into module-level `let` ARE writes —
  only the declaration statement itself is excluded, not later assignments to the same name.
- **Fixture**: alias `count`; `const count = rows.length;` inside an unrelated function no
  longer attributes; module-level `let count` plus `count += 1` in an action referent still
  does.

## I5 — mapping auto-discovery by module field (usability, from the Hardened-name mess)

- **Where**: the mapping auto-discovery in `src/runtime/query-commands/tla.ts` / wherever
  `tla verify <spec>` resolves a sibling `.scip-tla.json` by filename.
- **Change**: when no filename-matched mapping exists, scan sibling `*.scip-tla.json` files for
  one whose `module` field names the spec's module; if exactly one matches, use it (say so in
  output); if several match, error listing them. Vega motivation: 4 of 9 mappings are named
  `*Hardened*` but target plain specs, so bare `tla verify <spec>` fails for exactly the models
  whose configs users most want to run.
- **Fixture**: spec `Foo.tla` + `FooHardened.scip-tla.json` with `"module": "Foo"` — bare verify
  finds it; two module-matching mappings — error names both.

Deviations: checked real data before implementing the match rule — every mapping in this repo's
own `specs/**/*.scip-tla.json` AND every one of the 9 real Vega mappings stores `module` as the
project-relative `.tla` path (e.g. `"docs/formal/ProposalsAgentPipeline.tla"`), not the bare
identifier `"Foo"` the plan's fixture literally shows. `discoverMapPathByModule` accepts both
(plus the bare filename with/without `.tla`) so it matches the plan's literal fixture, this
repo's own convention, and the real Vega mappings without narrowing to only one spelling.

## I6 — closeout

Update the skill (`skills/scip-tla-model-system/SKILL.md`) where behavior changed: waiver
symmetry (waivers now cover write facts — the "reasoned waiver" rule applies uniformly),
`selfAlias: false` as a Mapping Discipline tool, and note auto-discovery-by-module. Update
`docs/COMMAND_REFERENCE.md` mapping schema section. Mark followups #23–26 RESOLVED with
file:line. `scip-query reindex && scip-query diff-gate` — fix or justify. Then, as the final
validation, re-run `scip-query tla verify` READ-ONLY over the nine Vega models
(/Users/aydansalois/Documents/GitHub/Vega_2.0/docs/formal, --timeout-ms 300000, explicit --map
for the Hardened-named four unless I5 makes it unnecessary) and record the per-model residual
finding counts here — the ~470-finding noise floor should collapse; Vega files must not be
modified (mappings may newly benefit from waivers/selfAlias, but that is a report line for the
user, not an edit).

Deviations: `docs/COMMAND_REFERENCE.md` has no mapping-schema section to update — it is fully
generated (`<!-- BEGIN/END GENERATED COMMAND REFERENCE -->`) from CLI command descriptors, plus
one hand-authored `analysisBudget` section unrelated to TLA. The `.scip-tla.json` mapping schema
has only ever been documented in `skills/scip-tla-model-system/SKILL.md` (already updated above)
— confirmed via `npm run docs:commands` (no diff to COMMAND_REFERENCE.md; I1–I5 added no new CLI
flags, so the generated table needed no regeneration either). Running that command did reformat
the skill file's own `<!-- BEGIN/END GENERATED SKILL COMMANDS -->` table (pre-existing drift
between the checked-in padded-column format and the generator's current unpadded output,
unrelated to this plan — kept as a drive-by consistency fix since it changes no content).

### `scip-query reindex && scip-query diff-gate`

Both run clean against `--base 5978acf0` (the commit this plan's diff starts from): `4 file(s),
22 symbol(s) changed`, all 8 gate checks run, `PASS: this change introduces no gate findings.`

### Vega validation sweep (READ-ONLY, 2026-07-02)

Method: built this repo at HEAD, `npm install -g .`, then ran
`scip-query tla verify docs/formal/<Spec>.tla --checker none --timeout-ms 300000 --json` from
`/Users/aydansalois/Documents/GitHub/Vega_2.0` for all nine models, bare (no `--map`) to exercise
I5's auto-discovery for the four Hardened-named mappings. `--checker none` is intentional: this
sweep measures static-conformance findings (the thing I1–I5 change), which come from the SANY
XML export + static source scan regardless of checker mode — `modelParse: "sany"` confirms SANY
ran for every model; TLC/Apalache property-checking is a separate concern this sweep doesn't
touch. For a true before/after diff, "before" was measured the same way against this repo's own
commit `5978acf0` (via a throwaway `git worktree`, built and installed globally, reverted
afterward) with explicit `--map` for every spec (pre-I5 had no fallback).

The "before" numbers quoted in this plan's opening paragraph and in the orchestrating task
(Checkout 58, SeatChange 58, StripeLedger 16, Proposals 171, WorkSession 174, Billing 14, Auth 0,
Subscription 0, GitHubWebhook 0) turn out to be **error-severity finding counts specifically**,
confirmed by reproducing them exactly at `5978acf0`:

| Model | Mapping used | Auto-discovered? | Errors before → after | Total findings before → after |
|---|---|---|---|---|
| Checkout | CheckoutActivationLifecycle.scip-tla.json | no (filename match) | 58 → 32 | 327 → 273 |
| SeatChange | SeatChangeLifecycle.scip-tla.json | no (filename match) | 58 → 40 | 234 → 198 |
| StripeLedger | StripeWebhookLedger.scip-tla.json | no (filename match) | 16 → 8 | 111 → 93 |
| Proposals | ProposalsAgentPipelineHardened.scip-tla.json | **yes**, `module-field` | 171 → 110 | 554 → 623 |
| WorkSession | WorkSessionLifecycleHardened.scip-tla.json | **yes**, `module-field` | 174 → 88 | 271 → 224 |
| Billing | BillingAccessLifecycle.scip-tla.json | no (filename match) | 14 → 8 | 162 → 115 |
| Auth | AuthRefreshCompanionAuthorizationHardened.scip-tla.json | **yes**, `module-field` | 0 → 4 | 0 → 48 |
| Subscription | SubscriptionLifecycleHardened.scip-tla.json | **yes**, `module-field` | 0 → 0 | 95 → 10 |
| GitHubWebhook | GitHubWebhookIndexingPipeline.scip-tla.json | no (filename match) | 0 → 45 | 74 → 148 |

Across the five models this plan's opening paragraph cites as the ~470-error noise floor
(Checkout, SeatChange, StripeLedger, Proposals, WorkSession): **477 → 278 error-severity findings
(42% reduction)**. Across all nine: 491 → 327 errors (33% reduction), 1828 → 1732 total findings.

**Not a uniform collapse — three models gained new errors, and this is expected, not a
regression.** Auth (0→4) and GitHubWebhook (0→45) both gained `model-mapping-write` errors
exclusively (confirmed via the JSON `conformance.findings` category breakdown) — I2's operator
expansion now derives more-complete SANY writes for these two models' actions, and each
mapping's own declared `writes` list was tuned against the *old, incomplete* SANY output (this is
literally the GitHubWebhookIndexingPipeline workaround the plan's I2 section names by name: its
mapping targets `FinishActiveJobFields`/`AttemptOwnFollowUpRestartOrTerminal` helpers directly
specifically to route around this exact bug). Fixing SANY completeness necessarily surfaces this
mismatch — it was always there, just invisible. Proposals' total findings also rose (554 → 623)
for the same reason on the read side even as its errors fell, and Subscription's total collapsed
95 → 10. These are real, newly-honest findings for a mapping author to address with an updated
declaration or a reasoned waiver (I1 now makes waiving a write finding possible) — not something
this read-only sweep can or should fix; Vega's mapping files were not modified.

`git -C Vega_2.0 status --porcelain | wc -l`: **0 before, 0 after** (`git status` itself needed
`--git-dir`/`--work-tree`/`-c core.bare=false` overrides — Vega_2.0's `.git/config` has
`core.bare = true` despite being a normal working checkout, a pre-existing quirk unrelated to
this session; `git rev-parse HEAD` alone works fine and confirmed the repo untouched:
`3dc4f92c834bdd028e66425169e2dccad5c7daad` before and after). `scip-query reindex` wrote only to
Vega's gitignored `.cache/`; no tracked file changed.
