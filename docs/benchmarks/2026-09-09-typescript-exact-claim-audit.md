# TypeScript exact-claim audit

The next sweep found **six additional accuracy problems** on the repaired build. Discovery is complete for the finite scope below; these new findings have **not** been fixed. All 535 production source files remained byte-identical during the audit. Changes in this turn are audit tooling and documentation.

The [recorded results](typescript-accuracy-audit/2026-09-09-exact-claim-results.json) contain individual programs, observed values and callable locations, public CLI/HTTP output, compiler comparisons, index histories, and production hashes. The [execution checklist](../plans/2026-09-09-typescript-exact-claim-audit.md) tracks the next repairs. Earlier discovery and repair artifacts remain unchanged.

## Scope and method

The combined run exercised **686 compiler-valid programs**: the previous 472 plus 214 new programs. All independent execution expectations passed. TypeScript was 6.0.2 and Node was v26.8.1. The new corpus contains 60 explicit combinations of three writers, four execution arrangements, and five import styles, together with focused examples and formatting controls.

For 27 selected programs, a compiler transformation records the source location of each callable body during a second execution. The transformed and original outcomes must agree. These programs deliberately end with a single marked invocation of a leaf callable, so the final recorded body identifies that invocation's implementation. This test does not infer absence of a static may-call relationship from an arbitrary execution trace.

We also compared compiler declaration locations including columns, examined raw SCIP, checked 13 parameter-transfer programs, exercised eight built-CLI projections and seven HTTP consumers, and compared 18 index histories with independent clean indexes. The selected public fixtures also run as native ES modules, ruling out a CommonJS-only explanation for the confirmed results.

## Confirmed findings

### TS-X01 — cross-file writers leave stale literal values

**66 programs.** One module exports `box = { path: '/wrong' }`; another imports it and changes `box.path` to `/right`; the consumer invokes that writer before reading the property. Direct static-value evaluation still returns `/wrong` with literal precision. Actual execution returns `/right`.

This occurs through direct writes, Object.assign and Reflect.set; named, renamed, namespace, barrel and default imports; immediate calls, callbacks and awaited execution. These are variants of one missing effect model, not 66 separate bugs.

`memberBase` in `src/symbols/graph/static-value-flow.ts` checks the reading file and the exporting file. It does not establish the absence of effects in a third writer module. The local effect collector models arguments and receivers passed to unknown calls; a writer can mutate an imported object without receiving it as an argument.

The tested HTTP consumer requalifies this value as unknown. Therefore this audit confirms the direct evaluator error, but does not claim that this particular HTTP path emits the stale literal. Repair requires shared evidence about effects across module boundaries, or withholding literal precision where that evidence is incomplete.

### TS-X02 — incomplete checks for evaluation that throws

**39 programs, including formatting variants.** The existing check recognizes explicit calls and several other operations that can interrupt evaluation. It misses exceptions caused by extracting parameter properties, iterating arguments or initializers, converting values during arithmetic/templates, mixing BigInt with numbers, and reading an absent runtime binding.

For example, `function read({x}) { return '/wrong'; }` can throw while extracting `x`, before executing its return. Calling it with a throwing property reader still produces the literal `/wrong` in analysis. Similar failures occur in declarations preceding a return.

Three built-in HTTP consumers confirm that these conclusions reach published evidence: argument property access, numeric conversion, and an initializer's iterator all throw and make no HTTP request, while extraction emits a constant `/wrong` path. The request observation remains a may-observation; the defect is its unjustified constant value and the incomplete normal-completion check, not a claim that the tool says the request definitely happened.

The owner is `eagerCompletionIsUnproved` and the bounded-return path in `src/symbols/graph/static-value-flow.ts`. Repair should establish the safety of supported evaluations; a short list of visibly effectful syntax is insufficient.

### TS-X03 — Reflect.set ignores its separate receiver

**Three formatting variants.** `Reflect.set(other, 'path', '/right', box)` writes to `box` in the tested program. The effect model records only `other`, its first argument. Reading `box.path` can therefore retain `/wrong` as a literal.

The concrete cause is the Reflect.set branch in `builtinCallEffects`, `src/source/ast/source-binding-effects.ts`. It treats Reflect.set like Object.defineProperty and omits the fourth argument. The tested HTTP layer returns unknown here; the direct evaluator is wrong. Repair needs the receiver and property-set semantics, with controls for failed writes and accessors.

### TS-X04 — direct eval bypasses callable and value invalidation

**Three callable and three value programs.** Direct eval changes a function, an arrow binding, a class binding, or an object's property. The original source declaration remains the reported established callable or literal value.

All three callable failures appear as **exact call edges in the built CLI**. Independent body traces identify the replacement, and native ES module execution produces the replacement result too. A general reflection limitation in coverage text does not qualify the specific exact edge.

The effect collector sees the string argument passed to eval but does not invalidate lexical bindings affected by the evaluated code. Repair must qualify affected scopes and consumers when direct eval can alter them. Parsing a fixed string alone would not cover dynamic strings or the surrounding binding environment.

### TS-X05 — class decorators can replace a constructor

**Three invocation forms.** A decorator returns a different class whose constructor produces `value = 2`. Analysis reports the original class or its constructor as the established target; the original would produce `value = 1`. Runtime traces show the replacement constructor.

All three false targets are **exact in the built CLI**, including parenthesized and asserted constructor expressions. Native ES modules reproduce them. `invocationImplementationProof` in `src/symbols/graph/scip-occurrence-call-targets.ts` accepts a bare constructor/type declaration before proving that the runtime class value survived decoration. Compiler binding correctly identifies the source declaration; that fact does not prove the runtime constructor.

### TS-X06 — formatting changes implementation qualification

**Six paired examples.** For `const replacement = () => 2; const alias = replacement`, an alias on the same line as its target receives established implementation status. Splitting the declarations onto separate lines changes the result to unresolved. Execution is identical.

The alias target has a zero-width placeholder location, not a precise body range. `invocationImplementationProof` compares file and line containment without columns. That lets unrelated source constructs on the same line satisfy its implementation test. The built CLI preserves this exact/candidate difference for the selected pair.

This is recorded separately from the six bodies demonstrably contradicted by execution: it is an unjustified, formatting-dependent proof of implementation identity. Repair should resolve the alias to its actual callable definition and compare exact identity/ranges, while keeping the compiler declaration reference distinct.

## Counts and counterevidence

The six causes account for **111 faulty literal conclusions** (72 stale values and 39 evaluations that throw), **six wrong established callable bodies**, and **six additional established aliases without a precise body range**. Counts include deliberate variants; they are not independent bug counts or a representative error rate for ordinary repositories.

- The original 472 programs still have zero wrong derived values and zero compiler line-identity mismatches. Their twelve previously disclosed declaration/runtime disagreements remain unresolved. Stronger range checks reveal two additional placeholder-range limitations in that original set.
- Nine new compiler-reference checks lack a projected local target. Raw SCIP contains the correct document-local symbol references. Fifteen new alias/indirect declarations lack precise body ranges. These are coverage gaps, separately recorded from false exact targets.
- A raw line-only comparison also flags a decorated class reference whose returned constructor range is contained within the compiler class declaration. The stronger range comparison accepts that relationship; it is not counted as a compiler identity error.
- No false parameter pairs were found in the 13 new transfer programs. Rest-argument and mutated-spread cases omit relationships; these remain support limits rather than invented transfers.
- All **18 histories** match independent compiler facts and clean graph/value output after substituting the disposable checkout root. Sixteen perform actual incremental updates. Ten raw comparisons differ only in checkout paths inside diagnostic text; no semantic incremental mismatch was found in these histories. Agreement with a clean index does not make a value correct when both use the same faulty analysis.
- The HTTP constant control is correct. Three mutation consumers return unknown rather than stale paths. Three exception consumers expose the incorrect constant described above.

## Validation and next work

The combined recorder completed in 139.21 seconds. The final public recorder completed eight CLI projections, seven HTTP consumers, and 15 native ES module executions. The history recorder completed all 18 transitions. The audit TypeScript check, ESLint for changed audit files, formatting and whitespace checks passed. The production suite was not rerun because production and regular test files were unchanged; the previous 3,732-test pass still describes that frozen build.

Commands for reproducing the sweep are in the [audit README](../../benchmarks/typescript-accuracy-audit/README.md#exact-claim-follow-up). A passing recorder means measurement completed. The summarizer preserves discrepancies rather than turning their presence into a successful accuracy verdict.

The main design problem is the step from a compiler declaration or local source observation to a stronger runtime conclusion. Most confirmed failures occur in that interpretation, not in SCIP's name binding. The next repair pass should make the proof requirements explicit for calls, values and evaluation effects, then promote these reproductions into required regression assertions. Unsupported behavior must reduce the particular claim's strength, not merely add a general warning elsewhere.

This sweep does not exhaust TypeScript. It does not validate every state, temporal, ownership, identity or contract relation; every framework adapter; arbitrary scheduling and heap behavior; or all module loaders/configurations. No production fix, commit, push or VM installation was performed in this audit.
