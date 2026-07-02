# TLA+ Model Conformance Plan

## Goal

Build an on-demand workflow where an agent can explore a TypeScript system,
write a TLA+ model, verify the model with standard TLA+ tooling, check the
model-to-code mapping with `scip-query`, and iterate until code, model, and
mapping agree.

A TLA+ model is a mathematical specification of a system's states and allowed
steps, used here to represent the part of a TypeScript system whose behavior we
want to reason about. Model conformance is the verified agreement between that
specification and the TypeScript referents named by an explicit mapping file.
A referent is the concrete code object, file, state field, function, call, or
trace event that gives a model term its meaning.

Done means a user can run a command like:

```bash
scip-query tla verify specs/Queue.tla \
  --config specs/Queue.cfg \
  --map specs/Queue.scip-tla.json \
  --checker auto \
  --json
```

and get structured findings that distinguish:

- the TLA+ model is syntactically or semantically invalid;
- the model checker found a bad reachable state;
- the mapping names TypeScript referents that no longer exist;
- mapped TypeScript behavior changed without corresponding model coverage;
- a runtime trace produced by the code is not accepted by the TLA+ next-state relation;
- the checker cannot prove enough and needs a more explicit mapping or trace.

## Implementation Result

The first on-demand slice is implemented. It adds `scip-query tla verify`, a
mapping-contract loader, an external checker runner for SANY/TLC/Apalache, a
static TypeScript conformance pass, generated command documentation, unit
tests, and the `tla-model-system` skill.

Runtime trace input is supported as JSON evidence for mapped action writes:
each trace step's changed model variables must be declared by the mapped action.
The fuller generated TLA+ trace-check harness described below remains a later
slice because it needs concrete trace-producing systems and checker-specific
state encoding.

Dogfood validation now models the verifier itself under `specs/tla-feature/`.
The fast regression model checks the exit-decision slice before the fuller
workflow model. That run caught and fixed two integration issues: config paths
from mapping files now resolve both project-relative and map-relative forms,
and TLC runs now use isolated metadata directories so fast and full checks do
not collide on TLC's default `states/<timestamp>` path.

## Gate A - User Job

The user does not want a permanent gate that slows every change. The user wants
an on-demand skill-backed formal modeling loop:

1. inspect an existing system end to end;
2. build a TLA+ model for the selected behavior;
3. verify the model with TLC/Apalache;
4. verify the mapping against compiler-resolved code facts;
5. fix code, model, or mapping;
6. rerun until the modeled slice is either good or a concrete discrepancy remains.

The modeled slice is the bounded part of the system represented by the model,
such as queue lifecycle, locking, retry behavior, or cache invalidation. This
must be explicit because arbitrary TypeScript behavior is too broad for a
single automatic equivalence claim.

## Gate B - Current Flow

- `commandDescriptors` is the top-level CLI command list, consumed by
  `src/runtime/cli.ts` and built from `CommandDescriptor` entries.
  Source: `scip-query plan-context commandDescriptors`; `scip-query code commandDescriptors -C 80`.

- A command descriptor carries `id`, `command`, `description`, `options`,
  `renderShape`, optional docs metadata, and a handler.
  Source: `scip-query code CommandDescriptor -C 8`.

- The command registry turns descriptors into Commander commands, adds
  arguments/options, and invokes each descriptor handler.
  Source: `scip-query code registerCommandDescriptors -C 4`.

- Query command families already live under `src/runtime/query-commands/*` and
  are depended on by `src/runtime/commands/query-command-specs.ts`.
  Source: `scip-query system src/runtime/query-commands`.

- Existing commands use `printJsonEnvelope()` for stable JSON output, so the
  TLA command should reuse that output shape instead of inventing a separate
  JSON contract.
  Source: `scip-query code printJsonEnvelope -C 6`.

- External command execution already exists in benchmark and cleanup
  verification code, using `spawnSync`, timeouts, exit-code capture, byte
  counts, and binary detection.
  Source: `scip-query code runBenchCommand -C 8`;
  `scip-query code detectCheckers -C 8`;
  `scip-query code binaryAvailable -C 6`.

- `diffGate()` already produces structured findings with severity, evidence
  source, related files, reasons, and remediation. The TLA verifier should
  reuse that style even if it remains an on-demand command.
  Source: `scip-query code DiffGateFinding -C 8`;
  `scip-query code diffGate -C 20`;
  `scip-query code handleDiffGate -C 45`.

- The TypeScript semantic provider can resolve compiler references, callees,
  and signatures through ts-morph. This is the right substrate for code-side
  conformance facts.
  Source: `scip-query system src/semantic/typescript`;
  `scip-query code TsMorphSemanticProvider -C 6`.

- Existing `callGraph()` reports incoming and outgoing callable relationships
  from indexed/semantic evidence.
  Source: `scip-query code callGraph -C 20`.

- Existing `dataflow()` is reference-level, not value-level. It reports
  definitions, usages, co-occurring producers, and consumers, but explicitly
  does not trace assignment chains like `x = foo(); bar(x)`.
  Source: `scip-query code dataflow -C 20`.

- Exporting a new public query through `src/queries/index.ts` is high risk
  because that module has 13 external consumers. Keep the first slice CLI-only
  unless programmatic API export is required.
  Source: `scip-query change-surface src/queries/index.ts`.

## Gate C - Reuse Audit

- Reuse command descriptors and handlers rather than adding an alternate CLI
  registration path.
  Source: `scip-query code commandDescriptors -C 80`;
  `scip-query code CommandDescriptor -C 8`.

- Reuse `printJsonEnvelope()` and the existing command output conventions.
  Source: `scip-query code printJsonEnvelope -C 6`.

- Reuse `spawnSync`-based external tool execution patterns from benchmarks and
  cleanup verification, but place TLA-specific result parsing in a new module.
  Source: `scip-query code runBenchCommand -C 8`;
  `scip-query code detectCheckers -C 8`.

- Reuse `DiffGateFinding` style for diagnostics, but define a TLA-specific
  finding type instead of widening `DiffGateCheck` in the first slice. The user
  asked for on-demand use, not default diff-gate enforcement.
  Source: `scip-query code DIFF_GATE_CHECKS -C 8`;
  `scip-query code DiffGateFinding -C 8`.

- Reuse semantic call graph and dataflow for code evidence, while adding a
  narrow TypeScript AST pass only for facts the current graph does not provide:
  assignments, mutation calls, thrown errors, returned values, and awaited calls
  inside mapped action referents.
  Source: `scip-query code callGraph -C 20`;
  `scip-query code dataflow -C 20`;
  `scip-query code TsMorphSemanticProvider -C 6`.

## Accuracy Contract

Do not implement a command that says "TLA+ equals TypeScript." Implement a
command that says:

> Given this mapping, these code facts, these checker results, and these
> optional traces, the TLA+ model conforms to the declared TypeScript slice, or
> these precise discrepancies remain.

The checker must sort output by evidence strength:

- `model-checker`: SANY, TLC, or Apalache result.
- `compiler-symbol`: TypeScript compiler/SCIP symbol resolution.
- `static-action`: AST evidence inside a mapped function.
- `change-graph`: git diff evidence connecting changed code/model/map files.
- `trace`: observed execution projected into model states/actions.
- `unknown`: a required relation could not be proven.

Failures with `unknown` evidence should not be called conformance failures.
They should block the "all good" result and tell the skill exactly what mapping
or trace is missing.

## Implementation Checklist

### Phase 1 - Contract and Tool Runner

- [ ] Add a TLA contract type module, probably
  `src/tla/model-contract.ts`, with validated JSON for `module`, `config`,
  `variables`, `actions`, `invariants`, `scopes`, `traces`, and checker
  options. Each variable/action entry must name its TypeScript referents and
  whether the checker is expected to prove reads, writes, calls, returns, or
  trace acceptance.
  Source: `scip-query code dataflow -C 20`; current dataflow is not
  value-level, so the contract must carry enough intent for precise checks.

- [ ] Add a TLA external tool runner, probably `src/tla/tool-runner.ts`, that
  detects `tla2tools.jar`, `java`, and `apalache-mc`, runs with timeouts, and
  records stdout/stderr/exit status without shell interpolation.
  Source: `scip-query code runBenchCommand -C 8`;
  `scip-query code detectCheckers -C 8`;
  `scip-query code binaryAvailable -C 6`.

- [ ] Support three checker modes in the runner:
  `sany` for parse/semantic validation, `tlc` for explicit-state model
  checking, and `apalache` for parse/typecheck/bounded symbolic checking.
  Source: official TLA+ tools README documents `java tla2sany.SANY` and
  `java tlc2.TLC`; Apalache docs document `parse`, `typecheck`, `simulate`,
  and `check`.

- [ ] Return a normalized `TlaToolResult` with command, checker, duration,
  exit code, timed-out flag, diagnostics, trace artifacts, and raw-output
  paths. This mirrors benchmark command result fields while adding
  TLA-specific diagnostics.
  Source: `scip-query code runBenchCommand -C 8`.

### Phase 2 - Code-Side Conformance Query

- [ ] Add `src/tla/conformance.ts` with `verifyTlaConformance(db, contract,
  opts)`. Keep it internal in the first slice, and avoid exporting through
  `src/queries/index.ts`.
  Source: `scip-query change-surface src/queries/index.ts`.

- [ ] Resolve every mapped TypeScript referent to an indexed definition before
  doing deeper checks. Missing or ambiguous referents are hard errors because
  fuzzy matching would make the tool look more accurate than it is.
  Source: `scip-query system src/semantic/typescript`;
  `scip-query code TsMorphSemanticProvider -C 6`.

- [ ] For each mapped action, compute static evidence:
  signature, callers, callees, references to mapped state, assignments to
  mapped state, calls to declared write sinks, returns, throws, and awaits.
  Use current call-graph and semantic provider facts where they exist; add a
  small TypeScript AST visitor for assignment/mutation evidence only.
  Source: `scip-query code callGraph -C 20`;
  `scip-query code dataflow -C 20`;
  `scip-query code TsMorphSemanticProvider -C 6`.

- [ ] Implement coverage findings:
  mapped TLA action has no code referent; mapped code referent does not exist;
  mapped action mutates a variable not listed in the contract; mapped variable
  is written by an unmapped action inside the declared scope; mapped action's
  signature or outgoing call set changed since a stored baseline.
  Source: `scip-query code DiffGateFinding -C 8`;
  `scip-query code diffGate -C 20`.

- [ ] Treat static uncertainty as its own result, not as success. If aliasing,
  dynamic property access, external I/O, dependency injection, or an unmodeled
  callback prevents a precise claim, emit an `unknown` finding with the exact
  code referent and required contract addition.
  Source: `scip-query code dataflow -C 20`; it states the existing analysis is
  reference-level, not value-level.

### Phase 3 - CLI Command

- [ ] Add an on-demand command descriptor for `tla verify <spec>` with
  `--map <file>`, `--config <file>`, `--checker <auto|sany|tlc|apalache>`,
  `--length <n>`, `--trace <file>`, `--json`, and `--full`.
  Source: `scip-query code CommandDescriptor -C 8`;
  `scip-query code commandDescriptors -C 80`.

- [ ] Prefer a dedicated runtime module such as
  `src/runtime/query-commands/tla.ts` or `src/runtime/tla-command.ts` instead
  of adding a large block to `src/runtime/commands/command-handlers.ts`.
  `command-handlers.ts` already owns many unrelated handlers, and the TLA
  workflow has enough shape to justify its own module.
  Source: `scip-query system src/runtime/query-commands`;
  `scip-query outline src/runtime/commands/command-handlers.ts`.

- [ ] Render human output as grouped findings with checker status first, then
  conformance findings, then unknowns, then next actions. Render JSON through
  `printJsonEnvelope()`.
  Source: `scip-query code printJsonEnvelope -C 6`;
  `scip-query code handleDiffGate -C 45`.

- [ ] Exit non-zero when model checking fails or conformance errors exist.
  Exit zero with unknown findings only when the user passes an explicit
  `--allow-unknown` flag; otherwise unknown means the verifier could not prove
  the declared goal.
  Source: `scip-query code handleDiffGate -C 45`.

### Phase 4 - Skill

- [ ] Add `skills/tla-model-system/SKILL.md`. The skill should force this loop:
  `scip-query plan-context <target>` -> `system/trace/call-graph/dataflow`
  exploration -> draft model -> draft mapping -> `scip-query tla verify` ->
  classify findings -> patch code/model/map -> rerun.
  Source: `scip-query code planningQueryCommandDescriptors -C 30`;
  `scip-query system src/runtime/query-commands`.

- [ ] The skill must require the agent to classify every finding as code bug,
  model bug, mapping bug, insufficient trace, or accepted non-modeled behavior.
  This keeps the workflow honest when the checker reports unknowns.
  Source: `scip-query code DiffGateFinding -C 8`; existing findings already
  carry message, why, remediation, evidence, file, symbol, and related files.

- [ ] The skill must prohibit generating a model solely from names. It should
  force the agent back to referents: concrete functions, state, transitions,
  failure modes, and observed traces.
  Source: `scip-query code callGraph -C 20`;
  `scip-query code dataflow -C 20`.

### Phase 5 - Runtime Trace Checking

- [ ] Define a trace JSON format that records action name, code referent,
  before/after projected state, inputs, outputs, and errors. A projected state
  is the part of a runtime state that the model intentionally represents.
  Source: `scip-query code dataflow -C 20`.

- [ ] Add `src/tla/trace-projection.ts` to validate trace files against the
  mapping contract. Do not ask TLA+ to understand arbitrary JavaScript values;
  normalize values into finite sets, records, strings, booleans, and bounded
  integers before checker handoff.
  Source: Apalache docs state its assumptions: fixed finite parameters, finite
  data structures, and bounded executions.

- [ ] Add a generated trace-check harness that asks the checker whether each
  observed step is permitted by the mapped `Next` relation. Keep this as a
  second slice after static conformance because it depends on real traces from
  user systems.
  Source: official TLA+ tools README documents SANY/TLC command-line tools;
  Apalache docs document bounded `check`.

### Phase 6 - Optional Diff Integration

- [ ] Add `scip-query tla drift --map <file> --base <ref>` only after the
  on-demand verifier is stable. It should report mapped code changes whose
  model or mapping file did not change, but it should not run by default.
  Source: `scip-query code diffGate -C 20`;
  `scip-query code DIFF_GATE_CHECKS -C 8`.

- [ ] Do not add `tla` to `DIFF_GATE_CHECKS` in the first implementation.
  The current check list is canonical for `--skip`; widening it would imply
  default gate behavior the user explicitly does not want.
  Source: `scip-query code DIFF_GATE_CHECKS -C 8`.

## Verification Plan

- [ ] Add unit tests for contract validation: missing module, missing map,
  duplicate action names, ambiguous referents, unknown checker, unsupported
  projection shape, and invalid trace state.

- [ ] Add tool-runner tests with fake binaries/scripts so timeout, exit code,
  stdout/stderr capture, and missing dependency behavior do not require Java or
  Apalache in CI.
  Source: `scip-query code runBenchCommand -C 8`;
  `scip-query code binaryAvailable -C 6`.

- [ ] Add a fixture TypeScript system and matching TLA+ spec where the model
  passes, then mutate one code path so the verifier flags an unmapped write.
  Source: `scip-query code callGraph -C 20`;
  `scip-query code dataflow -C 20`.

- [ ] Add a fixture where the model checker fails and confirm CLI output keeps
  model-checking diagnostics separate from code-conformance diagnostics.
  Source: `scip-query code handleDiffGate -C 45`;
  `scip-query code printJsonEnvelope -C 6`.

- [ ] Before declaring implementation done, run the project-required checks:
  `scip-query reindex`, `scip-query diff-gate --json`, and the repository's
  TypeScript test/typecheck command.
  Source: project AGENTS.md and `scip-query status --capabilities`.

## Design Stress Test

- **Understand before touch:** The first implementation does not attempt full
  TypeScript-to-TLA equivalence. It validates an explicit conformance contract.

- **Blast radius:** Avoid exporting through `src/queries/index.ts` until the
  command has proven stable because that file is high risk.
  Source: `scip-query change-surface src/queries/index.ts`.

- **Valid intermediate states:** Phase 1 can ship as a TLA syntax/model-check
  wrapper. Phase 2 adds static conformance. Phase 5 adds traces. Each phase is
  useful without depending on unfinished later work.

- **Reversibility:** The first slice adds a new on-demand command and skill.
  It does not change default hooks, default diff-gate behavior, or existing
  query outputs.

- **Failure design:** Missing tools, timeouts, model-checker failures, and
  uncertain static evidence all become structured findings, not thrown generic
  errors.

- **Concurrency:** The verifier should write checker artifacts under a unique
  run directory and avoid shared mutable files except user-provided specs/maps.

- **Boundary defense:** The mapping file is untrusted input. Validate all paths
  under the project root unless the user explicitly opts into external paths.

- **Data integrity:** No repository mutation is required by the verifier. The
  skill may edit code/model/map during its loop, but only through normal agent
  patching.

- **Observability:** Every finding should include checker, evidence source,
  code/model location, command run, and remediation.

- **Human use:** The human-facing output should answer: "is the model valid?",
  "does it match the mapped code?", "what state is bad?", and "what do I fix
  next?"

- **Reuse:** Use current command descriptors, JSON envelope, semantic provider,
  call graph, dataflow, and process-runner patterns.
