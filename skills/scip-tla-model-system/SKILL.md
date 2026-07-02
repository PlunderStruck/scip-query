---
name: scip-tla-model-system
description: Model TypeScript systems with TLA+ and scip-query evidence. Use to scaffold, verify, instrument, or trace-check TLA+ specs, mapping files, configs, regression models, counterexample loops, or code/model conformance for an existing system.
commands:
  - template: 'scip-query tla scaffold <file>'
    when: 'Start here for a new model: derive a draft spec, config, and mapping from indexed code.'
  - template: 'scip-query tla verify <spec>'
    when: 'Mechanical conformance: referents, reads/writes, calls, and the model checker.'
  - template: 'scip-query tla instrument <spec>'
    when: 'Generate a trace recorder plus wiring sites for each mapped action.'
  - template: 'scip-query tla trace-check <spec> --trace <file>'
    when: "Semantic conformance: check a recorded execution against the model's Next relation."
  - template: 'scip-query tla fetch-tools'
    when: 'Download the pinned tla2tools.jar into the cache when the checker is unavailable.'
---

# scip-tla-model-system

Use this skill when a TypeScript system needs a TLA+ model tied to code evidence. A modeled slice is the bounded part of the real system represented by the model: state, transitions, inputs, outputs, and failure modes.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | When |
| --- | --- | --- |
| `scip-query tla scaffold <file>` | TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation | Start here for a new model: derive a draft spec, config, and mapping from indexed code. |
| `scip-query tla verify <spec>` | TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation | Mechanical conformance: referents, reads/writes, calls, and the model checker. |
| `scip-query tla instrument <spec>` | TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation | Generate a trace recorder plus wiring sites for each mapped action. |
| `scip-query tla trace-check <spec> --trace <file>` | TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation | Semantic conformance: check a recorded execution against the model's Next relation. |
| `scip-query tla fetch-tools` | TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation | Download the pinned tla2tools.jar into the cache when the checker is unavailable. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Choose the Slice

Model the part with the most dangerous interleavings — retries, concurrency, partial failure, money, state machines with guards. Never model a linear happy path: a model that cannot meaningfully fail verifies nothing. If the state space would exceed roughly a million states, the model is too concrete; collapse data you never branch on and replace unbounded values with small symbolic sets. `scaffold` requires the target file to own mutable module-level state (a `let`/const plus a writer function) or, failing that, a class whose instance fields a method of that same class writes; a file of pure functions or constants is rejected — pick the file that holds the state, not the file that only computes over it.

**Known boundary: class fields on files with any indexed method are usually invisible to `scaffold`.** The write scanner can find `this.field = ...` writes fine, but the class-field fallback only ever sees candidates that `getDefinitionsForFile` actually returns — and that catalog (`definition-catalog.ts`/`symbol-row-policy.ts`) deliberately drops class-member fallback rows whenever the file has any other primary-indexed (enclosing-range) definition, which any class with a constructor or a named method always has. So a concurrency class like a lock or connection pool — exactly the shape this skill most wants to model — will almost always report "no mutable state discovered", not because the state isn't there but because the shared definition catalog hides it one layer below scaffold. When you hit this: model by hand from `plan-context`/`trace` evidence instead of via `scaffold`, or narrow the target file so the class in question is the only indexed definition in it. Widening the catalog itself is out of scope for this skill's tooling — it's a shared primitive nearly every other command depends on.

## Loop

1. Explore the target with `scip-query plan-context <target>`, `system`, `trace`, `call-graph`, and `dataflow` until state and transitions are concrete.
2. Run `scip-query tla scaffold <file>` to generate the draft spec, config, and mapping (`--out` must stay inside the project root). Resolve every `TODO` it emits: guards, domains, initial values. The scaffold derives _what_ changes; you supply _when_ it may. TRIAGE the output first: if the discovered variables are mostly constants and the system's real state lives in files or a database (locks, caches, published artifacts), keep the mapping referents but discard the scaffolded variable set — hand-model the protocol's conceptual state and bind it with `resource` aliases instead. `tla verify` does not detect unfilled `TODO`s and will report PASS on a placeholder model — grep the spec for `TODO` before trusting a green run.
3. Strengthen the model per the quality rules below.
4. Run `scip-query tla verify <spec> --map <map> --config <cfg>`. Read the Proof line: every waiver must carry a reason you would defend in review.
5. Wire the recorder from `scip-query tla instrument`, run the existing tests with `SCIP_TLA_TRACE=<path>`, then run `scip-query tla trace-check <spec> --trace <path>`. Acceptance means the code's observed behavior is a behavior of the model; divergence names the step to investigate. Modeling a fix-vs-regression pair as two named `Next` relations in one spec (e.g. `NextCurrent`/`NextVulnerable`)? Pass `--next <operator>` to pick which one the trace must satisfy — the harness defaults to a bare `Next`, which such specs deliberately don't define.
6. Classify every finding as code bug, model bug, mapping bug, insufficient trace/alias evidence, or accepted non-modeled behavior.
7. Patch code, model, or mapping and rerun until only explicitly waived uncertainty remains.

The loop is complete only when `tla verify` passes with reasoned waivers, at least one recorded trace passes `tla trace-check`, and unexercised actions are listed as accepted gaps.

## Model Quality Rules

- **TypeOK first.** Write the type invariant before any property; it catches most modeling mistakes at the lowest checking cost.
- **Every invariant needs a failure story.** Before running TLC, write down the concrete scenario that would violate it. If no scenario exists, the invariant is decorative — delete or replace it.
- **Falsify every invariant individually.** One break-test is not enough: for EACH invariant there must be a documented variant or mutation under which TLC refutes it (the CurrentSpec/VulnerableSpec pattern makes this permanent instead of a throwaway edit). An invariant no variant can violate is decorative — delete or redesign it.
- **Break the model on purpose.** After the first green run, remove one guard or widen one domain and confirm TLC catches it. A spec that cannot fail proves nothing. Restore it afterward.
- **Safety before liveness.** Add fairness only when a liveness property demands it; check deadlock unless termination is intended.
- **Bound the space deliberately.** Small symbolic constant sets, symmetry where sound, sequences kept short. Nondeterministic `\in` transitions from the scaffold are permissive placeholders — tighten them to concrete transitions as you learn the code.
- **Trace divergence taxonomy.** When `trace-check` diverges: a missing model transition means the model is too strict; an impossible recorded state means instrumentation projects the wrong slice; a genuinely illegal code transition is a bug — write the regression model before fixing it.

## Fast Regression Models

A regression model is a small TLA+ module or checker config derived from a counterexample, production bug, or suspected transition.

1. Preserve the full model as source of truth.
2. Create a companion regression spec/config named for the failure, seeded from the exact counterexample trace (a diverging `trace-check` output is already that trace).
3. Prefer bounded constants and narrowed action sets over weakening the main model.
4. Run the regression first after each patch; run the full model after it passes.
5. Keep the regression if it protects future behavior.

## Mapping Contract

```json
{
  "module": "specs/Queue.tla",
  "config": "specs/Queue.cfg",
  "scope": ["src/queue"],
  "variables": {
    "queue": { "code": ["src/queue/store.ts/queue"], "aliases": ["queue"] },
    "lockOwner": {
      "code": ["src/queue/lock.ts/LockMetadata#pid"],
      "aliases": ["pid"],
      "resource": { "path": "lockPath" }
    },
    "phase": {
      "code": ["src/queue/lock.ts/__phase_no_stored_field__"],
      "aliases": ["__phase_unmatchable__"],
      "waive": { "reason": "phase is a pure control-flow position; no code field stores it" }
    }
  },
  "actions": {
    "Enqueue": {
      "code": ["src/queue/commands.ts/enqueue"],
      "reads": ["queue"],
      "writes": ["queue"],
      "waive": { "reason": "required only when a declared fact cannot be statically proven" }
    }
  },
  "invariants": ["TypeOK"],
  "traces": ["specs/queue-run.trace.json"]
}
```

`code` entries must resolve through `scip-query trace`; variables must map to value-like symbols (a const, let, field, or property holding runtime state — never a type). Waivers are per-fact and require a reason; blanket `allowUnknown` is legacy.

`resource` binds a variable to filesystem state — a lock file, a published artifact — anything the model treats as owned state but that code only touches through path-taking calls, never a plain assignment. The conformance scanner classifies `writeFileSync`/`rmSync`/`renameSync`/`mkdirSync`/`unlinkSync` calls whose first argument's text contains the declared `path` as writes of the variable, and `readFileSync`/`existsSync`/`statSync` calls the same way as reads. The match is textual containment, not a resolved value — evidence tier stays `static-action`, and a resource-bound variable still needs a value-like `code` referent for the kind check.

`variables.<v>.waive: {reason}` exempts that one variable's `missing-referent`/`invalid-referent-kind` findings — for state that genuinely has no code twin (a pure control-flow position, a derived decision, a value observable only through `process.exitCode`). It does not exempt read/write facts; those stay on the action's own `waive`. Prefer this over the old workaround of citing an unrelated real symbol just to satisfy the value-like-kind check — name a referent that plainly does not resolve (or does resolve but to the wrong kind) and waive it honestly; a reader should never have to guess that a `code[]` entry is a decoy.

Top-level `"unmappedWriteScope": "actions" | "scope-files"` (default `"scope-files"`) controls how strictly `scope` is enforced: the default requires every function anywhere in `scope` that touches a modeled variable to be mapped as an action, or its write is a hard `unmapped-write` error. Set `"actions"` to opt out of that whole-file sweep when `scope` legitimately contains code the mapping was never meant to cover in full — only the per-action write/read checks still run.

## Mapping Discipline

- **Alias selection is the sharpest knife.** Never alias a variable to a ubiquitous local identifier (`connection`, `result`, `data`) — every function touching that local gets misattributed across actions. For state with no code twin, use a deliberately unmatchable alias (e.g. `evidenceRowsModelOnly`) so the static layer neither proves nor pollutes, and let the reasoned waiver carry the fact.
- **Know the three state backings.** Program variables: normal aliases. Filesystem-backed state (locks, published artifacts): `resource: { "path": ... }` bindings make fs calls provable. Database/SQL-backed state: statically invisible — unmatchable alias plus a waiver naming the residual class; never fake attribution.
- **Lazy initialization is Init, not an action.** A factory that lazily builds state corresponds to the model's `Init`; mappings cannot bind Init to referents, so do not map the factory as an action — waive with that reason, and use `unmappedWriteScope: "actions"` when whole-file sweeps only re-find Init writes.
- **Design for traces early.** The trace encoder pins scalar (and scalar-array) variables only; a model whose state is all functions and tuple-sets cannot be trace-validated. If trace-check matters for the slice, add scalar projection variables (counts, last outcomes, a phase) alongside the structured state.
- **Trace until covered.** One accepted trace proves one path, not the mapping. Record traces until every Current action with a code twin is exercised by at least one accepted trace, or is explicitly classified with why it cannot be (unreachable without fault injection, environment-gated, model-only). An action no trace ever exercises is a conformance claim resting on static mapping alone.

## Accuracy Rules

- `tla verify` is the mechanical checker; `tla trace-check` is the semantic one. Only the pair justifies the word "conforms".
- A PASS with waivers is a conditional claim — the Proof line says exactly what was and was not proven. Never summarize it as unconditional.
- A PASS on a scaffold with unresolved `TODO`s is meaningless, not conditional: the checker has no TODO detector and will pass a placeholder model. Never report a PASS without confirming step 2 of the Loop is actually done.
- If code changed but the model did not, inspect whether the mapped transition changed meaning; `diff-gate` flags the changed referents.
- If the model checker fails, fix the TLA+ model before relying on conformance output.
- Use `--checker none` only when intentionally checking the mapping without SANY, TLC, or Apalache.
- The write/read scanner follows one call hop from a mapped action's referent (no recursion) — a callee's effect on a _declared_ fact counts as evidence, marked `(via <callee>, one call hop...)` in findings. It never asserts a new, undeclared fact: a callee shared by several actions cannot make one action silently inherit another's write. If a variable's waiver becomes provable this way, update the waiver reason to name the real call chain instead of deleting the explanation — the evidence is still approximate (which specific runtime call path executes is not proven, only that the code family does).
