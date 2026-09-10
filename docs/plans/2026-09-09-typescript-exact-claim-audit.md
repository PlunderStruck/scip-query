# TypeScript exact-claim audit

Status: this bounded discovery sweep is complete; six new findings are confirmed and remain unfixed. See the [audit report](../benchmarks/2026-09-09-typescript-exact-claim-audit.md) and [results](../benchmarks/typescript-accuracy-audit/2026-09-09-exact-claim-results.json). The user authorized the next accuracy audit after the ten previous repairs. Preserve the repaired production baseline and collect independently verified failures before making further production changes. Do not change historical results or operate on VM watchers.

An exact claim is a reported relationship or value whose stated evidence identifies it directly within the disclosed scope. A candidate is a relationship requiring confirmation. An unknown records a limit of the analysis. Missing information and contradicted claims must be counted separately.

## Material questions

- Do established call targets identify the callable selected by an invocation, including captured functions, imported writers, constructors, and callbacks?
- Do inferred literal values survive object mutation, closure capture, getter evaluation, parameter defaults, exceptions, and evaluation order?
- Do compiler references identify the correct declaration and source range after harmless formatting and same-line declarations?
- Do exact parameter transfers preserve argument evaluation and binding identity?
- Do edits to those relationships yield the same compiler and graph evidence as a clean index?

## Existing paths and reuse

Reuse the real compiler/index/database/query fixtures in `benchmarks/typescript-accuracy-audit`. The main recorder already compiles and executes closed programs, compares compiler occurrences, evaluates marked values, and materializes execution/dataflow evidence. Extend it with an explicitly selected corpus so the historical 472-case suite remains stable. Use a separate execution identity observation where return values cannot establish the invoked body. Preserve unsupported cases rather than making every recorder test assert tool success.

Production owners under audit are source-binding access/effects, imported value context, call implementation qualification, static value flow, public graph projection, and incremental publication. The review must follow discrepancies into these owners and their live consumers before naming a defect.

## Checklist

- [x] Freeze production-source hashes and record scope/versions.
- [x] Enumerate new finite cases across calls, mutation/capture, evaluation order, binding forms, and harmless source transformations.
- [x] Validate fixtures with the compiler and independent execution; repair invalid expectations before classifying tool failures.
- [x] Compare established calls, literal values, parameter pairs, and compiler identities separately; inspect public evidence for confirmed failures.
- [x] Run incremental/clean comparisons across changed call/value relationships.
- [x] Group reproducible failures by mechanism, preserve counterexamples and controls, and record all untested areas.
- [x] Save findings and reproducible artifacts; validate the audit changes without claiming production repairs or exhaustive correctness.

## Results

- 686 compiler-valid programs executed: 472 prior controls and 214 new programs. No invalid fixtures or execution-expectation failures remain.
- 27 programs have separately instrumented callable observations with unchanged runtime outcomes.
- Six causes explain 111 literal overclaims, six wrong established callable bodies, and six aliases with formatting-dependent implementation proof. Counts include variants, not independent bugs.
- Eight built CLI projections and seven HTTP consumers checked; 15 native ESM executions confirm the selected runtime results.
- Eighteen histories match clean compiler and graph/value output after checkout-root normalization; sixteen use actual incremental updates. Raw diagnostic-path differences are preserved separately.
- All 535 production files remain byte-identical. Audit TypeScript, ESLint, formatting and whitespace checks pass. Historical artifacts and the unrelated LaunchPoint document are preserved.

## Repair queue (not implemented in this discovery turn)

- [ ] TS-X01: shared cross-file effect qualification for literal values; include imported and deferred writers.
- [ ] TS-X02: explicit normal-completion requirements for parameter patterns, iteration, conversions and binding reads.
- [ ] TS-X03: model Reflect.set's separate receiver and setter behavior.
- [ ] TS-X04: qualify bindings and values exposed to direct eval; propagate the limitation to exact edges.
- [ ] TS-X05: qualify constructor identity after class decoration.
- [ ] TS-X06: replace line-only callable proof with exact alias/body identity and ranges.
- [ ] Preserve and assess nine local-target omissions and 17 placeholder-range gaps across both corpora as separate coverage work.
- [ ] Turn confirmed examples into required regressions before production repairs; retain independent execution, controls and public consumers.

No new production repairs, commit, push, or VM deployment were performed. Full TypeScript correctness and all-family graph coverage are not established.
