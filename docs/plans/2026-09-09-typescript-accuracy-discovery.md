# TypeScript accuracy discovery audit

Status: discovery complete for the enumerated finite suite. Production fixes are explicitly deferred. Existing uncommitted accuracy work and the unrelated LaunchPoint benchmark document are preserved. No commit, push, VM deployment, or existing watcher restart is part of this audit. See the [findings and repair order](../benchmarks/2026-09-09-typescript-accuracy-discovery.md).

## Purpose and definitions

A compiler reference is a source occurrence associated with a declaration by the compiler under a specified project configuration. It establishes declaration identity, not every runtime implementation that can occupy that location.

A call site is a source operation that invokes a callable or constructs an object. An execution target is an implementation that can receive that invocation. A runtime observation records a particular execution; it can refute an asserted unique target but cannot prove that unobserved executions are impossible.

A data-flow relationship connects program locations through which a value can move under a stated analysis model. A dependency relationship records a source unit's reliance on another unit under a stated module-resolution policy. Neither relationship alone establishes execution.

An accuracy defect contradicts the relationship's advertised meaning. An unresolved result discloses that the implementation cannot establish a target. A missing supported fact is an omission from a defined supported set. Keep these verdicts separate.

## Baseline and boundary

Audit the current working-tree build, previously validated with 3,675 passing tests in 410 files. Record source/build hashes before and after. Existing tests demonstrate regressions only; they are not the audit's accuracy denominator.

Use the real bundled compiler, real SQLite index, shared production query owners, and selected public CLI projections. Reuse IndexerHistoryFixture for disposable repositories and real incremental services. Compile audit programs with TypeScript diagnostics enabled; reject invalid fixtures rather than count them as tool failures. Execute closed examples independently of graph interpretation. Do not modify production source or its existing tests to make a probe pass.

## Relationship contracts to assess

| Contract                       | Independent expectation                                                              | Required accounting                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Declaration/reference identity | Direct TypeScript checker declaration and source positions                           | Pinned compiler/configuration; external/local/type-only distinctions                 |
| Invocation inventory           | TypeScript call/new/tagged-template constructs in the selected source                | Each supported site present or explicitly unsupported; nested invocation ownership   |
| Execution targets              | Independently specified targets; executed counterexamples for claimed unique targets | Exact, candidate, unresolved; no inferred runtime proof from a reference alone       |
| Value evaluation/data flow     | Closed programs with explicit expected values and transfers                          | Mutation, sharing, branches, returns, unsupported boundaries                         |
| Module dependencies            | Compiler-resolved module destinations                                                | Imports/re-exports, type-only, dynamic and CommonJS distinctions                     |
| Incremental state              | Fresh rebuild of the same current inputs                                             | Edits, removal, rename, restoration, configuration change, actual incremental status |
| Projection/transport           | Same stored relationship set through both directions and bounded pages               | No missing/duplicated edges; recover all printed continuations                       |

## Discovery matrix

Record case counts and verdicts per row, including rows not yet exercised. A row is not complete merely because one example passes.

| Area                 | Dimensions to cover                                                                                                      | Status                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Calls and syntax     | Direct, member, optional, computed, tagged, new, nested/returned/IIFE, wrappers, Unicode/CRLF                            | 20 call programs plus 24 variations executed; TSX and broader syntax combinations remain untested                                     |
| Binding and scope    | const/let/var, destructuring/default/rest, shadowing, closures, parameter aliases                                        | 7 binding and 10 parameter-transfer programs plus shared controls; not every declaration/scope combination                            |
| Objects and mutation | Direct writes/delete, object/array copies, property assignment, helper calls, Reflect/Object operations, getters/setters | 10 mutation, 16 container, and 320 generated programs; delete/setter combinations not exhausted                                       |
| Classes              | Instance/static/private members, inheritance/override/super, fields, constructor writes, distinct instances              | 12 class programs; private members, decorators, and full super/instance combinations remain untested                                  |
| Function values      | Local/imported aliases, bound/call/apply functions, callbacks, returned functions, metadata                              | Exercised in call/module/mutation cohorts; unsupported indirect forms classified; metadata combinations not exhausted                 |
| Control and lifetime | Branches, loops, write ordering, snapshots, async/await, promise callbacks, generator execution                          | 5 ordering and 3 async programs plus container loops; no full control-state exploration                                               |
| Modules              | Named/default/namespace/star exports, re-export chains, mutable exports, importing-file mutation, cycles, path aliases   | 21 module programs, 13 reference forms, path-alias histories; native ESM cycles and package conditions remain untested                |
| Value analysis       | Constants, object fields, function returns, parameters/defaults, side effects, aliases, conditional values               | 24 value programs and 3 HTTP consumers; wrong constants and normal-completion limits recorded                                         |
| Index histories      | Add/edit/delete/rename/revert, source and configuration changes, incremental/full equivalence                            | 11 histories match independent compiler facts and clean-repository projections; 4 incremental emissions, 6 broader refreshes, 1 reuse |
| Invariants           | Incoming/outgoing agreement, safe renaming, formatting, output folds/pages, repeated builds                              | 24 variation comparisons, 15 public projections, 9 incoming call checks, 180 source lines over 2 pages; selected guarantees only      |

## Work queue

1. [x] Write the contract, audit boundary, baseline procedure, and discovery matrix before implementation.
2. [x] Build reproducible discovery runners without changing production code.
3. [x] Execute broad positive/negative cases and a finite generated composition space; retain failed cases.
4. [x] Compare compiler facts, behavior, value analysis, dependencies, incremental histories, and public projections.
5. [x] Group findings by the responsible representation or rule; distinguish confirmed causes from hypotheses.
6. [x] Publish per-area counts, concrete counterexamples, untested areas, and the proposed repair order/design decisions.
7. [x] Verify source/build baseline unchanged; leave production fixes deferred. All 1,671 files under `src`, `tests`, and `dist` match their pre-audit hashes.

## Stopping rule

Finish this audit when the explicitly enumerated suite and generated finite space have all been classified, every failure has a minimal reproducible input or a clearly recorded unresolved diagnosis, and every unexercised matrix area is disclosed. Never call the full TypeScript language or all runtime executions exhausted. More generated examples do not create an overall accuracy percentage without a defined expected relationship set.

## Design hypotheses to test

- Compiler declaration targets are promoted to execution claims without sufficient evidence about writes and object identity.
- Mutation rejection recognizes selected syntax forms instead of modeling common value movement consistently.
- Separate compiler and source-parser representations lose declaration/source identity at their join.
- Unknown effects are treated as absence of mutation rather than a limit on the claim.
- Bounded constant-return evaluation may omit execution, parameter binding, or asynchronous semantics.
- Incremental caches or public projections may disagree with accurate underlying facts.

These are hypotheses until a distinguishing program and the live implementation establish them.
