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
