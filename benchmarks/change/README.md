# Change benchmark

This benchmark gives an agent a fixed TypeScript repository and a requested edit, then evaluates the source it leaves behind. The four tasks exercise shared-rule ownership, separation of independently changing policies, complete retirement, and declared dependency direction. Every initial edit is followed by a second requirement implemented by a fresh agent in the resulting checkout.

The initial cohort is a synthetic development pilot. It does not establish general effectiveness on real repositories. Expand to held-out repositories and repeat matched trials before drawing that conclusion.

## Frozen requirements and checks

`tasks.json` contains user-visible requirements. `fixture/` is the only repository copied into agent checkouts. The shipping task begins with a task-specific dependency violation created by `materializeChangeFixture`; the other tasks use the common fixture unchanged.

`checks.mjs` runs behavioral cases against an independent compilation of submitted source. `scripts/change-benchmark-core.mjs` checks compiler-resolved direct calls and imports, preserved environment files, and specifically named retired identities. It also runs the original smoke test and submitted `test/*.test.mjs` files against that independent build, so a follow-up cannot pass while leaving its earlier tests stale. Only the original smoke test is frozen; agent-added tests may evolve with the requirements. Neither the agent's summary nor its edited test runner determines acceptance. The checker uses the original TypeScript settings and dependency policy. Failed compilation, unsupported module loading, a missing policy, or a weakened policy cannot pass.

Ownership means responsibility for enforcing a rule or controlling a resource. Here, compiler call paths identify the shared module, and observed write stacks check that cancellation and receipt writes occur while that module is executing. This is bounded evidence about the exercised paths. It does not prove arbitrary dynamic behavior or architectural quality.

`reference-patches.mjs` is private verifier-test data. Tests accept a different valid owner filename and arrow-function adapters, reject unchanged implementations, and reject deliberately faulty initial and follow-up patches. The expected result is defined by obligations, not patch equality. No reference patch or hidden check is copied into the agent checkout.

## Matched conditions

Both conditions use the same requested model, reasoning effort, time limit, fixture revision, requirements, and investigation discipline. The control uses native search and reads. The treatment uses the current scip-query build, with an index prepared before the agent starts. Indexing time is recorded separately from editing time. A PATH shim prevents ordinary control invocations of scip-query; raw command logs support adherence review. This is experimental isolation, not a security sandbox.

The Codex CLI runs with `--ignore-user-config`, `--ignore-rules`, and a fresh ephemeral session. These flags do not claim to remove all installed skill metadata. Both conditions use the same local installation; capture the runtime and tool fingerprints when comparing runs. The requested model is passed explicitly; there is no model fallback in this runner.

Initial and follow-up phases use fresh sessions. Grader feedback is not given to the follow-up agent. Both phases run even if the initial implementation fails an obligation. Failures remain in results. Every model process has a time limit; raw events and stderr are retained when it fails. Timed-out trials have unknown aggregate token costs rather than zero costs.

## Run

Build scip-query and validate the benchmark first:

```sh
npm run build
npm exec -- vitest run tests/scripts/change-benchmark-core.test.ts tests/scripts/codex-change-trial.test.ts --maxWorkers=1
```

Run four matched pairs, each with two phases (16 model invocations), using Sol at medium reasoning:

```sh
npm run bench:change -- pilot --output /tmp/change-pilot-sol-medium --model gpt-5.6-sol --reasoning medium
```

The launcher currently requires a POSIX shell. The output directory must not already exist. The pilot alternates which condition runs first between tasks. Defaults are one repetition and a five-minute limit per phase. A single trial can be run with `run --task shared-rule --mode control --output /tmp/change-control --model gpt-5.6-sol --reasoning medium`. Use `--repetition 2` with a fresh output directory to repeat the cohort; use `--timeout-ms` to change the shared phase limit. Comparisons reject mismatched model, reasoning, inputs, evaluator, tool build, timeout, or baseline revision.

For a later model comparison, hold the task cohort fixed and run a separate matched cohort with `--model gpt-5.6-terra --reasoning high`. Do not pool different models into one tool-effect comparison.

## Artifacts and interpretation

Each trial retains invocation settings, exact prompts, raw Codex events, stderr, patches, resulting source, obligation results, model token usage, phase durations, indexing duration, and source/evaluator/tool identities. Disposable worktrees and caches are removed after capture. The source repository is never edited by the trial agent.

`compare` accepts control and treatment `trial.json` paths and returns paired results. The pilot writes `comparison.json` automatically. Keep individual obligations, initial/follow-up outcomes, time, token counts, and changed-file measurements separate. The pass field means every specified obligation passed; it is not an architectural grade. Raw command classification is an audit aid, not a complete proof of protocol adherence.

Inspect anonymized patches for unnecessary abstractions, meaningful differences erased by consolidation, and accidental complexity. Record review reasons separately from automated acceptance. Change size and reviewer preference alone cannot establish good ownership. The automated pilot does not provide a blinded independent design review or a dollar-cost estimate.
