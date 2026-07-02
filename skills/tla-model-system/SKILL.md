---
name: tla-model-system
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

# tla-model-system

Use this skill when a TypeScript system needs a TLA+ model tied to code evidence. A modeled slice is the bounded part of the real system represented by the model: state, transitions, inputs, outputs, and failure modes.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->

## Commands for this skill

| Command                                            | Purpose                                                                                                                                                                                  | When                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `scip-query tla scaffold <file>`                   | TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation | Start here for a new model: derive a draft spec, config, and mapping from indexed code. |
| `scip-query tla verify <spec>`                     | TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation | Mechanical conformance: referents, reads/writes, calls, and the model checker.          |
| `scip-query tla instrument <spec>`                 | TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation | Generate a trace recorder plus wiring sites for each mapped action.                     |
| `scip-query tla trace-check <spec> --trace <file>` | TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation | Semantic conformance: check a recorded execution against the model's Next relation.     |
| `scip-query tla fetch-tools`                       | TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation | Download the pinned tla2tools.jar into the cache when the checker is unavailable.       |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.

<!-- END GENERATED SKILL COMMANDS -->

## Choose the Slice

Model the part with the most dangerous interleavings — retries, concurrency, partial failure, money, state machines with guards. Never model a linear happy path: a model that cannot meaningfully fail verifies nothing. If the state space would exceed roughly a million states, the model is too concrete; collapse data you never branch on and replace unbounded values with small symbolic sets. `scaffold` requires the target file to own mutable module-level state (a `let`/field plus a writer function); a file of pure functions or constants is rejected — pick the file that holds the state, not the file that only computes over it.

## Loop

1. Explore the target with `scip-query plan-context <target>`, `system`, `trace`, `call-graph`, and `dataflow` until state and transitions are concrete.
2. Run `scip-query tla scaffold <file>` to generate the draft spec, config, and mapping (`--out` must stay inside the project root). Resolve every `TODO` it emits: guards, domains, initial values. The scaffold derives _what_ changes; you supply _when_ it may. `tla verify` does not detect unfilled `TODO`s and will report PASS on a placeholder model — grep the spec for `TODO` before trusting a green run.
3. Strengthen the model per the quality rules below.
4. Run `scip-query tla verify <spec> --map <map> --config <cfg>`. Read the Proof line: every waiver must carry a reason you would defend in review.
5. Wire the recorder from `scip-query tla instrument`, run the existing tests with `SCIP_TLA_TRACE=<path>`, then run `scip-query tla trace-check <spec> --trace <path>`. Acceptance means the code's observed behavior is a behavior of the model; divergence names the step to investigate.
6. Classify every finding as code bug, model bug, mapping bug, insufficient trace/alias evidence, or accepted non-modeled behavior.
7. Patch code, model, or mapping and rerun until only explicitly waived uncertainty remains.

The loop is complete only when `tla verify` passes with reasoned waivers, at least one recorded trace passes `tla trace-check`, and unexercised actions are listed as accepted gaps.

## Model Quality Rules

- **TypeOK first.** Write the type invariant before any property; it catches most modeling mistakes at the lowest checking cost.
- **Every invariant needs a failure story.** Before running TLC, write down the concrete scenario that would violate it. If no scenario exists, the invariant is decorative — delete or replace it.
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

## Accuracy Rules

- `tla verify` is the mechanical checker; `tla trace-check` is the semantic one. Only the pair justifies the word "conforms".
- A PASS with waivers is a conditional claim — the Proof line says exactly what was and was not proven. Never summarize it as unconditional.
- A PASS on a scaffold with unresolved `TODO`s is meaningless, not conditional: the checker has no TODO detector and will pass a placeholder model. Never report a PASS without confirming step 2 of the Loop is actually done.
- If code changed but the model did not, inspect whether the mapped transition changed meaning; `diff-gate` flags the changed referents.
- If the model checker fails, fix the TLA+ model before relying on conformance output.
- Use `--checker none` only when intentionally checking the mapping without SANY, TLC, or Apalache.
