# TLA+ Subsystem Redesign Proposal

Date: 2026-07-01. Companion to the [critical review](2026-07-01-critical-review.md), which contains the full findings for the current `tla verify` implementation.

## 1. What `tla verify` actually proves today

The command runs six checks (src/tla/conformance.ts, src/tla/tool-runner.ts):

1. The mapping JSON parses and its paths stay inside the project root.
2. Mapped variable/action names appear in the `.tla` file — found by **regex** (`VARIABLES?` lines and `name ==` definitions), not a TLA parser.
3. Every `code` referent resolves in the SCIP index — via `findFirstSymbolMatch`, i.e. first match wins on ambiguous names.
4. A **name-based** static write scan: inside each mapped action's body (and scoped files), any assignment/mutation whose target text matches a variable's alias counts as a "write"; observed writes are compared to the JSON's declared `writes`.
5. Declared `calls` must appear in the SCIP call graph of the action's referent.
6. Hand-authored trace JSON: for each step, changed keys must be a subset of the declared `writes`.

Plus SANY/TLC/Apalache on the model itself — which checks the model *in isolation*, never against the code.

Measured on the repo's own dogfood spec (`specs/tla-feature/TlaVerifier.tla`):

- **Swapping two actions' `code` referents (a semantically absurd mapping) still passes: exit 0, "PASS: model, mapping, and checked code evidence agree."** The action↔code binding carries no semantic weight.
- The shipped mapping sets `allowUnknown: true` on **all five actions** and maps every "variable" to a **TypeScript interface** (e.g. `contractState` → the *type* `TlaModelContract`), so the write scan finds `0 modeled write(s)`. Stripping `allowUnknown` makes the same spec fail (exit 1). The dogfood passes only by opting out of the one check with teeth.
- `reads` in the mapping are parsed and validated for name existence but **never checked against code**. The `invariants` array is never consulted. The plan doc's promised `change-graph` evidence tier and "trace not accepted by the next-state relation" check were never implemented.
- No tla2tools.jar is bundled or fetched; with the default `--checker auto` on a machine without it, the model checker is silently skipped (the run correctly exits 1 with an `unknown` finding, but nothing helps you fix it).

So the user's suspicion is correct: today this is a *mapping-freshness linter* — "the JSON still points at live symbols and nobody renamed things" — wrapped around an optional off-the-shelf model check. Neither direction of the real question ("does the model mean what the code does?") is tested.

## 2. Why the current design can't get there

The JSON contract is the only place model semantics and code semantics meet, and both sides of it are **asserted by the author, not derived from either artifact**:

- Model side: reads/writes/calls are typed in by hand; the tool never derives an action's actual read/write set from the TLA+ text (which SANY could give it).
- Code side: writes are detected by matching *identifier text* against alias names — blind to `this.x`, destructuring, setters, immutable rebuilds (`state = {...state, queue}`), writes through callees, and anything renamed locally.

When both ends of a conformance check are hand-declared in the same file, the check degenerates into "is the file internally consistent and are the names still real." That is what the experiments show.

## 3. Redesign: three pillars

The honest version of "revolutionary" is not full code→TLA translation (undecidable in general, and the plan doc rightly refused it). It is: **derive both ends of the contract from evidence instead of assertion, and make execution traces — not names — the semantic bridge.** All three pillars build on machinery scip-query already has.

### Pillar A — Evidence-derived scaffolding: `tla scaffold <target>`

Generate the first draft of the model *and* the mapping from the index instead of asking the agent to hand-assert both:

1. **State discovery.** From the target module: module-level `let`s, class fields, exported store objects — everything the existing dataflow/write machinery already classifies as mutable state. These become candidate TLA variables. Referents are recorded as *symbol IDs*, not names — killing the alias-regex layer at the root.
2. **Domain inference.** TypeScript union types are the gift here: `'idle' | 'loading' | 'done'` becomes a finite TLA set; enums likewise; booleans trivially. This is what makes generated models *checkable* — TLC needs finite domains, and the type checker already knows them. Fields without finite domains get flagged for the agent to abstract (the skill teaches how).
3. **Action discovery.** Exported functions that (per the existing write scan + call graph) transitively mutate the discovered state become candidate actions, with **derived** read/write sets. Guards are drafted from early returns/throws on those paths.
4. **Output.** A `.tla` skeleton (Init from initializers, one action per mutator, TypeOK from inferred domains, `UNCHANGED` for untouched variables), a `.cfg`, and a mapping whose reads/writes carry provenance (`derived: static` vs `declared: author`) — so `verify` can later distinguish "the code drifted from what we derived" from "the author's claim was never checked."

This is a *draft generator*, honestly labeled tier-3, that the agent refines. It converts the current workflow's worst step (hand-writing three artifacts that nothing cross-checks) into a review step.

### Pillar B — Execution-trace validation: the semantic core

This is the established technique the current `trace` feature gestures at but doesn't do (see MongoDB's "eXtreme Modelling in Practice" and Kuppe et al.'s TLA+ trace validation):

1. **`tla instrument`** generates a tiny trace logger for the mapped variables: a wrapper (or explicit `traceAction(name, () => ...)` helper) that serializes the mapped state slice after each action, using the mapping's `projection` field (already in the schema, currently unused!) to project code state into model values.
2. **Traces come from real execution** — run the project's existing tests (or a repro script) under instrumentation. No more hand-authored trace JSON, which is circular (the same author writes the model, the mapping, and the "observed" behavior).
3. **`tla verify --traces`** generates a `TraceSpec.tla` that constrains the model's behaviors to the recorded trace (the standard pattern: a trace-indexed `Next` that requires each step to match the logged transition) and runs TLC on it. **"TLC accepts the trace" = the code's observed behavior is a behavior of the model.** A rejection yields the exact step where code and model diverge — a real counterexample loop, per executed path.
4. Coverage honesty: report which model actions were exercised by traces and which were never observed (`RunChecker: 14 trace steps; DecideExit: 0 — unverified by execution`).

This is the piece that makes "semantic correctness" real: it checks the *next-state relation* against *actual state transitions*, not JSON keys against JSON keys.

### Pillar C — Static conformance upgraded from names to effects

Keep a static layer (traces can't cover everything), but rebuild it on the semantic provider instead of alias regexes:

- Derive per-action write sets with ts-morph (property writes, `this.x`, destructuring, mutation through local aliases) and compare against the model side.
- **Parse the model with SANY** (it's already a supported checker — use its XML/JSON export) and derive each TLA action's primed variables and read set. Then the check becomes *derived-model-effects vs derived-code-effects* — the JSON stops being the semantics and becomes just the binding.
- Verify `reads` (currently dead data), both directions.
- **Reject category errors**: a variable referent must be a stateful referent (variable/field/store), not an interface or type alias. The dogfood spec would fail this today — correctly.
- Replace blanket `allowUnknown: true` with per-fact waivers (`"waive": {"writes": ["toolState"], "reason": "written via spawn callback"}`) that are counted and printed, mirroring the suppression system the rest of the tool already has. `PASS` output must state what was proven and what was waived — never "model, mapping, and checked code evidence agree" when 0 writes were checked.

### Supporting fixes (cheap, do regardless)

- Bundle or auto-fetch `tla2tools.jar` the way `vendor/scip` already vendors the scip CLI; a formal-methods feature whose checker is absent by default will never be run.
- Resolve referents with the disambiguating lookup (error on ambiguity, list candidates), not `findFirstSymbolMatch`.
- `tla <operation> <spec>` grammar has exactly one operation; either flatten to `tla-verify` or actually grow operations (`scaffold`, `instrument`, `trace-check`).

## 4. The skill: teach model-writing, not just tool-driving

The current skill explains the loop and the JSON schema but says nothing about what a *good model* looks like — and the bundled example is a 5-state pipeline that cannot meaningfully fail. The rewritten skill should teach, concretely:

1. **Pick the slice by risk, not by convenience** — model the part with concurrency, retries, partial failure, or money; never model a linear happy path (the current dogfood spec is the anti-example).
2. **Abstraction discipline** — model the protocol, not the implementation: collapse data you don't branch on; replace unbounded ints/strings with small symbolic sets (`CONSTANTS Users = {u1, u2}`); if the state space exceeds ~10^6 states, the model is too concrete.
3. **TypeOK first, always** — write the type invariant before any property; it catches most modeling bugs and TLC checks it cheapest.
4. **Every invariant needs a failure story** — before running TLC, write down the scenario that *would* violate it; if you can't imagine one, the invariant is decorative (all four invariants in the dogfood spec are decorative orderings).
5. **Break it on purpose** — after the first green run, mutate the model (drop a guard, widen a domain) and confirm TLC catches it; a spec that can't fail verifies nothing. (This is the model-level analogue of mutation testing, and it's how this review found the conformance gaps.)
6. **Safety before liveness; fairness only when a liveness property demands it; check for deadlock unless termination is intended.**
7. **State-space engineering** — symmetry sets, VIEW, bounded constants, and simulation mode for big models; regression configs seeded from counterexamples (the current skill's one genuinely good section — keep it).
8. **Divergence classification** — when trace validation fails: code bug, model bug, mapping bug, or abstraction gap; each has a distinct next action.

## 5. Phasing

| Phase | Work | Effort | What it buys |
|---|---|---|---|
| P0 | Verify `reads`; reject type-referents; per-fact waivers + honest PASS text; SANY-derived action effects; disambiguated referent lookup; bundle tla2tools | days | The existing command stops being decorative |
| P1 | `tla scaffold` (state/domain/action inference); skill rewrite per §4 | ~1–2 weeks | Agents produce real models instead of demo pipelines |
| P2 | `tla instrument` + TraceSpec generation + `verify --traces` | ~2–4 weeks | Genuine semantic conformance on executed paths |
| Research | ts-morph → PlusCal translation for pure reducer-style modules | open-ended | True auto-translation for the subset where it's decidable |

P2 is the "revolutionary" piece, and it is buildable: every ingredient (SCIP symbols, ts-morph effects, projection hooks in the schema, TLC) already exists in or alongside this codebase. What should *not* be built is a general "TypeScript → verified TLA model" button — that promise would recreate, at higher stakes, exactly the decorative verification this proposal removes.

2026-07-01 remediation confirmation: the `src/tla/conformance.ts` and
`src/tla/tool-runner.ts` guide references remain current after the first SANY
bridge landed. The verifier now prefers SANY XML facts when the tools jar is
available, falls back with an explicit parse basis when it is not, and compares
model action reads/writes against both mapping declarations and indexed code
evidence.
