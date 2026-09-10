# TypeScript accuracy discovery audit — 2026-09-09

Discovery is complete for the finite suite documented here. Production fixes remain deferred. The audit added reproducible programs, recorders, and this report; it preserved the earlier uncommitted production work.

The main finding is a problem in the analysis model: the graph combines compiler declaration identity with selective reasoning about callable values. Different operations that produce the same object relationship receive different treatment. There are also narrower, independently demonstrated errors in derived values and the retention of compiler identities. Repeatedly adding special cases would leave the model problem unresolved.

## What accuracy means here

A compiler reference is a source occurrence that the TypeScript compiler associates with a declaration under a particular project configuration. For example, `service.run()` can refer to the declaration of `Service.run` even after another function has been assigned to that property.

An execution target is an implementation that can receive an invocation. It requires reasoning about the value being called, beyond locating the declaration. An alias is a second expression or binding referring to the same object; a mutation changes that object's stored properties. These distinctions explain why an accurate compiler reference can coexist with an incomplete execution graph.

A derived value is a result computed from source facts under an analysis rule, such as the path passed to `fetch`. Its correctness depends on the rule accounting for the operations that can change that value. An unresolved result states that the analysis cannot establish the requested fact. It is different from establishing a wrong fact.

## Evidence and scope

The main corpus contains **472 compiler-valid, independently executed programs**. All 472 produced the hand-specified result. The bundled compiler used for diagnostics and direct declaration checks was **TypeScript 6.0.2**; execution used Node 26.8.1. The project configuration was strict ES2022 with ESNext modules and Bundler resolution. The runtime recorder transpiles the closed examples to CommonJS; it does not test every native ESM loading behavior.

| Area                          | Programs | Principal observations                                                                            |
| ----------------------------- | -------: | ------------------------------------------------------------------------------------------------- |
| Direct mutation               |       10 | Direct writes are detected; helper and reflective effects can be missed                           |
| Write ordering                |        5 | Conservative withholding around snapshots, unused writes, and ordering                            |
| Containers                    |       16 | Several array, rest, collection, and helper paths lose shared-object identity                     |
| Async and generators          |        3 | Mutation through these paths is not generally modeled                                             |
| Binding expressions           |        7 | Logical and chained assignments expose alias gaps                                                 |
| Calls                         |       20 | Ordinary direct forms work; wrapped computed access and indirect callable forms have limits       |
| Classes                       |       12 | Local callable fields/getters lose catalog identity; runtime overrides are not generally resolved |
| Values                        |       24 | Three wrong mutable-member constants; two normal-completion qualification issues                  |
| Generated compositions        |      320 | All 5 × 4 × 4 × 4 combinations executed; details below                                            |
| Modules                       |       21 | Basic import/re-export controls work; anonymous defaults and imported mutation expose gaps        |
| Parameter transfers           |       10 | Three wrapper omissions, two additional capability gaps; no unexpected direct transfers           |
| Meaning-preserving variations |       24 | No new discrepancy from formatting, renaming, CRLF, or Unicode                                    |

Additional checks:

- **451 selected compiler declaration comparisons:** ten mismatch cases, representing four original programs and six variations of the same callable-field omission. These compare declaration file/line identities; they are not exhaustive checks of all source columns, overloads, or every reference in each file.
- **472 marker and whole-file invocation-count comparisons:** zero count mismatches against independent TypeScript call/new/tagged-template traversal. Count equality alone does not prove identical site ownership or target sets.
- **11 indexing histories:** published compiler occurrences match an independent clean compiler build; selected execution/dependency projections match a separately indexed clean repository. Four steps used the incremental TypeScript emission path, six used broader refresh paths, and one reused unchanged input. Do not describe these as eleven incremental emissions.
- **13 module-reference forms:** expected kind, syntax, and destination all matched. The forms cover named/default/namespace/side-effect/type-only imports, mixed specifiers, re-exports, import types, and a literal dynamic import.
- **15 public CLI projections:** nine emitted call relationships were found through incoming queries; all fifteen bounded projections accounted for their larger projection through emitted edges and fold identities. This checks fold accounting, not every fold-expansion command.
- **180 exact source lines over two CLI pages:** every expected line was recovered and no continuation remained. This is not an assertion that all transport modes or duplicate suppression are correct.
- **Three HTTP consumers:** executable fixtures with a recording `fetch` replacement requested `/right`; the runtime-boundary extractor reported `/wrong` for all three. No network request was made.

The generated space varies five object holders, four equivalent alias wrappers, four writes, and four receiver wrappers. Its 320 combinations are fully enumerated, not randomly sampled. Of these, 176 retained a declaration target whose simple implementation returns a different result from execution: 80 `Reflect.set`, 80 `Object.assign`, and 16 direct writes through an array-rest holder. Another 64 direct writes withheld the old target; 80 unrelated-property writes retained it correctly. This identifies a few repeated mechanisms, not 176 independent bugs.

Across the entire corpus, **227 cases** have such declaration/runtime disagreements: 221 original cases and six equivalent variations. The current graph explicitly disclaims general runtime replacement and virtual dispatch. Therefore this number must not be presented as 227 false compiler references, or converted into an overall accuracy percentage.

## Findings and repair decisions

### TS-A01 — Mutable members become incorrect constant values

**Confirmed incorrect derived facts; fix first.**

```ts
const paths = { path: '/wrong' };
function change(value: typeof paths) {
  value.path = '/right';
}
change(paths);
export function entry() {
  return fetch(paths.path);
}
```

The same failure occurs with `Object.assign(paths, { path: "/right" })` and `Reflect.set(paths, "path", "/right")`. The static evaluator reports the original member as a literal constant, and the HTTP extractor publishes that wrong path as derived evidence. This is not just an inaccurate description of a compiler reference.

The demonstrated cause is that member-constant evaluation accepts an initializer despite effects that invalidate its value. Exact helper-effect handling remains to be designed; the required immediate guarantee is that an unproved mutable member cannot become a proved literal. Preserve known constant controls while qualifying or withholding unsupported values. Cases: `value-member-helper-mutation`, `value-member-object-assign`, `value-member-reflect-write`.

### TS-A02 — Local callable fields and getters are classified as external

**Confirmed compiler-fact loss and misleading coverage.**

For `class Base { run = original; }` and `class Base { get run() { return replacement; } }`, raw SCIP contains the local member definition and its reference. `getAllDefinitions` omits that member. The occurrence decoder treats a reference missing from that catalog as external; the public graph says that external behavior is unavailable.

The failing join is observable in `scip-chunk-occurrences.ts:160-168`, with the message selected in `program-execution-frontiers.ts:62-85`. The raw identity did not disappear in the TypeScript producer. Retain local declaration identity independently of whether it has a directly executable body. A getter's invocation and the callable value it returns must remain distinguishable. The exact upstream catalog filter responsible for each omission is not fully traced by this audit.

Cases: `field-function`, `getter-callable`, and six field variations. The diagnosis artifact preserves raw occurrences and catalog membership side by side.

### TS-A03 — Anonymous default callables have no usable producer identity

**Confirmed missing capability upstream of query projection.**

Both `export default function () { return 1; }` and `export default () => 1` execute correctly when imported and called. The direct compiler identifies their declarations, but the emitted SCIP owner documents contain only a module symbol. The imported call remains unresolved. A named default callable is a working control.

Add a compiler-grounded callable identity at the producer or its shared augmentation boundary. A query fallback based on a matching name cannot repair a missing anonymous identity reliably. This audit locates the loss at or before emitted SCIP; it does not prove that the third-party producer alone is responsible. Cases: `module-anonymous-default`, `module-default-arrow`.

### TS-A04 — Direct mutation of an imported binding bypasses write tracking

**Confirmed inconsistency in a supported direct-write mechanism.**

```ts
import { service, replacement } from './owner.js';
service.run = replacement;
export function entry() {
  return service.run();
}
```

`hasObservedCallableWrite` returns false here and true for the equivalent local binding. The imported identifier has an `ImportSpecifier` declaration and no `valueDeclaration`. The binding resolver uses `symbol.valueDeclaration` at `source-binding-identity.ts:581-586` and in its local declaration lookup. This drops the imported binding needed to associate its writes.

Model import aliases as local bindings connected to their exporting value, preserving both identities. Merely checking the exporting file cannot detect a direct write in the importer. Other cross-file writer and side-effect examples remain broader effect-analysis limits; do not assume this narrow repair solves them all. Case: `module-direct-import-write`.

### TS-A05 — Transparent argument wrappers lose parameter-transfer edges

**Confirmed omissions in simple value transfer; unsupported results remain visible.**

`consume(first, second)` exposes both direct transfers. `consume((first), (second))` exposes neither. Type assertions/non-null wrappers have the same effect, and `satisfies` loses the wrapped argument's transfer. These wrappers do not change the values being passed in these valid programs.

`directParameterPosition` rejects node kinds other than bare identifiers at `source-binding-identity.ts:204-205`; the graph's shared value-flow owner uses that result. Normalize these wrappers before checking compiler binding identity. Keep transformed expressions and shadowed locals distinct. Constant aliases and tuple spreads are two additional tested capabilities currently unavailable; they require their own defined transfer rules. Cases: all ten `flow-*` examples.

### TS-A06 — A wrapped literal member call is unresolved

**Confirmed syntax coverage gap, not an invented target.**

`service["run"]()` and the constant template-literal form resolve. `service[("run" as const)]()` is counted as an invocation but has no selected implementation target. The public graph reports it as unresolved. The direct checker lookup on the inner literal also lacks the ordinary occurrence identity, so this cannot be fixed by assuming a missing occurrence already exists.

Investigate the compiler's resolved signature and receiver-member identity through the wrapper, with the same declaration/value distinction used elsewhere. Case: `wrapped-bracket-call`.

### TS-A07 — Shared-object movement and effects have inconsistent coverage

**Confirmed analysis-model limitation; larger than one parser branch.**

Counterexamples include helper parameters/returns, array rest and collection operations, logical aliases, callbacks, asynchronous paths, prototype writes, and cross-file writers. Selected direct writes are rejected while equivalent effects through these paths retain the old declaration target. Controls include array spread, unrelated-property writes, and direct same-file writes.

Introduce one shared representation of values, object properties, and effects for the supported subset. An effect is an operation's change to program state, including changing a property later read or invoked. Track unsupported effects explicitly where they can invalidate a value-dependent claim. The audit demonstrates missing paths, but does not establish that every listed operation must be fully resolved in the first implementation.

### TS-A08 — “Exact” compiler identity shares an execution relation with incomplete target reasoning

**Confirmed contract ambiguity and design decision.**

The public call edge uses `evidenceStrength: exact` and establishes “The source construct may call the resolved target.” It also disclaims unique runtime implementations, cross-file callable replacement, and virtual dispatch. These caveats matter: a base declaration is not necessarily a wrong reference when an override executes.

However, the tool selectively removes some declaration targets after recognizing writes and leaves others when it cannot model the effect. A site can have zero unresolved frontiers while its runtime target set is not established. That prevents an agent from reading the local result as a complete account of potential execution.

Preserve an exact **referenced declaration** fact, and represent **possible implementation targets** separately with site-specific completeness and reasons. Exactness should describe the asserted relationship; output-budget completeness should not stand in for semantic completeness. The broad caveats are useful and must not be discarded, but they do not replace that distinction.

### TS-A09 — Constant-return evaluation lacks a normal-completion qualification

**Confirmed behavior outside the evaluator's demonstrated guarantee; contract correction needed.**

`path(fail())` and a `path()` containing a throwing initializer both evaluate to `/wrong` in the static evaluator, although the executed programs always throw. General exception propagation is explicitly outside the graph's support. Therefore these are not the same defect as returning the wrong literal after a successful computation.

The result must say whether it describes a value only if evaluation completes normally. Consumers must not turn such a conditional value into proof that the operation is reached. Cases: `value-argument-throws`, `value-initializer-throws`.

### TS-A10 — Flow-insensitive write checks discard valid simple targets

**Confirmed precision limitation; lower priority than false derived facts.**

A never-called writer, an unreachable write, a saved callable snapshot, a write after the call, and a write followed by restoration can all withhold a target that is used by the executed example. The current check collects writes without proving their execution order relative to the use.

Do not repair these by weakening mutation checks globally. Either report this conservative limitation clearly or add ordered value-state analysis for a deliberately bounded subset. Cases: `never-called-write`, `unreachable-write`, `saved-function-snapshot`, `write-after-call`, `write-then-restore`.

## Proposed repair order and acceptance criteria

1. Establish the declaration/implementation/value contracts from TS-A08, and prevent TS-A01's invalid constants from reaching consumers. Unknown effects must not silently count as proof of an unchanged value.
2. Preserve local compiler identities and import bindings (TS-A02, TS-A04), and provide compiler-grounded anonymous callable identities (TS-A03). Every known local declaration must remain local even if its execution target is unresolved.
3. Centralize transparent expression handling for the dataflow and call gaps (TS-A05, TS-A06). Reuse the same identity mechanism; retain the negative controls for transformation and shadowing.
4. Replace the growing collection of mutation vetoes with the bounded shared value/effect representation described in TS-A07. Select its supported operations explicitly and test their compositions. Qualify exceptions (TS-A09) and improve ordering only with corresponding proof rules (TS-A10).
5. Turn each repaired guarantee into a failing-before/passing-after regression test. Require compiler-valid fixtures, known positive and negative relationships, independent executions where applicable, and clean/incremental parity for changes to indexed facts. Retain discovery observations for unsupported cases instead of marking them fixed by changing expectations.

The outcome should be a graph that can say exactly which declaration is referenced, which implementations it has established, and what remains unknown. It should not promise complete runtime execution merely because the syntax was parsed successfully.

## What this audit does not establish

The finite generated space is exhausted; TypeScript is not. Remaining unexercised or insufficiently covered dimensions include TSX/JSX, decorators, private members, overload/generic combinations, declaration merging, computed symbols, accessors with effects, proxies beyond the single example, native ESM cycles and evaluation ordering, package exports/conditions, project references, CommonJS `require`, mixed JS/TS projects, compiler versions/configurations, ambient declarations, `eval`, dynamic names, generated code, and framework-specific dependency injection. Broader state/temporal/contract graph families were not audited here.

The history tests cover a short source/configuration sequence, not arbitrary concurrent edits, crashes, restarts, or every cache state. The public checks cover selected projections and one human pagination path. No new large-repository or agent benchmark was run.

The four recorders passing means the audit ran and recorded its observations. It does **not** mean all 472 graph/value probes passed. Runtime agreement cannot prove unobserved executions impossible, and agreement with a fresh index cannot prove that both indexes are semantically correct.

During audit development, type checking caught an unsupported `force` option in the first history recorder. Its supposed full-build graph comparison was discarded and replaced with a separate clean repository for every step. Invalid function-reassignment fixtures were also rejected and replaced with legal mutable bindings before the final corpus run. Only the corrected final runs contribute to the counts above.

## Artifacts and reproduction

- [Recorder instructions](../../benchmarks/typescript-accuracy-audit/README.md)
- [Compact results, every case verdict, and raw identity diagnosis](typescript-accuracy-audit/2026-09-09-results.json)
- [Discovery plan and completed checklist](../plans/2026-09-09-typescript-accuracy-discovery.md)
- [Baseline verification: all 1,671 source/test/build files unchanged](typescript-accuracy-audit/2026-09-09-baseline-verification.json)

Full local JSON artifacts are in `/tmp/scip-query-typescript-audit-2026-09-09`; the main run's binary SCIP is in `/tmp/scip-query-ts-discovery-final/index.scip`. Temporary artifacts can be regenerated from the checked-in runners and cases. No production fix, commit, push, deployment, or restart of an existing watcher was performed by this audit.
