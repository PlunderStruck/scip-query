# TypeScript accuracy repair validation

The ten findings from the [discovery audit](2026-09-09-typescript-accuracy-discovery.md) have been addressed. The repaired build passes the full repository suite and the bounded audit checks below. The [repair artifact](typescript-accuracy-audit/2026-09-09-repair-results.json) preserves individual results, unresolved disagreements, source hashes, and quality findings. Historical discovery results remain unchanged.

A compiler declaration is a named source definition to which TypeScript binds a reference. A runtime implementation is the callable body selected when an invocation executes. Mutation and method dispatch can make these differ. The graph now preserves declaration evidence without claiming an implementation is established when the evidence is insufficient.

## Results

Same 472 valid programs, TypeScript 6.0.2, Node v26.8.1; repaired producer revision 6. The corpus includes 320 combinations of selected mutation forms, plus targeted programs and transformations of formatting and identifiers. It does not enumerate the TypeScript language or every execution state.

| Observation                                              | Discovery | Repaired |
| -------------------------------------------------------- | --------: | -------: |
| Compiler/catalog mismatch cases                          |        10 |        0 |
| Derived values contradicted by execution                 |         5 |        0 |
| Declaration targets whose bodies disagree with execution |       227 |       12 |
| Required targets missing                                 |         3 |        0 |
| Runtime expectation failures                             |         0 |        0 |

All twelve retained disagreements have unresolved implementation status, a public invocation-level explanation, and no exact call edge to the contradicted declaration. They remain visible in the raw data. This corrects overclaiming; it does not discover the actual implementation in those cases.

The selected target records contain 44 established and 117 unresolved implementations. Another 301 cases have no static target. These denominators differ from program count because the programs have different invocation shapes. They are not a general accuracy percentage. Unknown results occur more often because several previously unjustified claims are now withheld.

The twelve cases cover generator-mediated aliasing, base/derived dispatch, constructor/prototype method replacement, callable proxies, static overrides, side-effect imports, imported writer functions, and namespace/re-export replacement. Ordering of unreachable writers, writes after invocation, and restoration of earlier values also remains unproved.

## Repairs

| Finding                                   | Implementation and regression evidence                                                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TS-A01: stale member values               | Shared property effects invalidate literals after helper, Object.assign and Reflect writes. Independent execution and real HTTP extraction confirm stale paths are withheld. Unchanged and sibling-property controls retain useful values. |
| TS-A02: missing local declarations        | The producer attaches precise ranges to fields/accessors and preserves compiler-owned catalog declarations. Published-index and clean-index checks agree.                                                                                  |
| TS-A03: anonymous defaults                | A module-owned compiler identity covers anonymous functions, arrows and function expressions, including erased wrappers. Imported-call and clean-index parity checks pass.                                                                 |
| TS-A04: import write identity             | Alias declarations participate in local binding identity without requiring a compiler value declaration. Named/default/namespace tests pass.                                                                                               |
| TS-A05: argument wrappers                 | Common expression normalization retains parameter identity through all six supported forms. All ten flow programs match their expected pairs, including swapping, aliases, flat tuple spread, transformations and shadowing controls.      |
| TS-A06: computed invocations              | Wrapped literal property access receives a unique compiler-grounded declaration reference. Source call syntax uses the normalized property.                                                                                                |
| TS-A07: divergent effects                 | A shared owner handles actual-to-parameter aliases, bounded returns, logical/chained aliases, array-rest offsets, known built-in writes and unknown exposure. Call and value consumers reuse these effects.                                |
| TS-A08: declaration versus implementation | Call graph, evidence, anchor candidates and callsite propagation share implementation qualification. Unresolved dispatch preserves candidate declarations and invocation-level explanations.                                               |
| TS-A09: exceptional completion            | Eager arguments/defaults and preceding initializers must support normal completion before a return becomes a constant. Both throwing regressions failed before and pass through static evaluation and HTTP consumers.                      |
| TS-A10: conservative order                | Written or potentially written values retain declaration identity, invocation location and an unresolved reason. General last-write or execution-order proof is not implemented.                                                           |

Validation also exposed and repaired leading-trivia source offsets, an eight-container exposure cutoff, self-call receiver observation order, shorthand parameter aliases, renamed re-exports, and wrapped default declarations. Depths 1/8/16/32, cycles, copied slots, LF/CRLF and wrapper regressions pass.

## Verification

- `npm test`: **3,732 passed in 412 files**, 350.05 seconds.
- Focused binding/declaration/value group: **74 passed**, including 2,000 generated binding controls.
- `npm run lint`: passed, including formatting, ESLint, build, public API/consumer and skill checks.
- `npm run typecheck` and the audit's TypeScript check: passed.
- All four audit recorders completed. Their results were separately checked for compiler/value mismatches and proper qualification of all twelve disagreements. A passing recorder alone is not an accuracy assertion.
- **11/11 edit histories** match clean compiler and graph output. Four use actual incremental updates; the others rebuild or handle unchanged inputs. Coverage includes edits, replacement, barrels, renames, deletion/restoration, path aliases and type-only references.
- **13/13 dependency cases** match the independent compiler destination and expected relationship kind.
- **15/15 public projections** preserve observed outgoing/incoming symmetry and output-budget accounting. Both pagination pages were recovered without missing lines or a remaining cursor.
- **3/3 mutation HTTP consumers** independently execute `/right`; analysis emits unknown path evidence instead of the obsolete literal.
- Fresh repository indexing completed in **53.9 seconds**. Diff-impact identifies **147 changed symbols and 175 affected files**, with absent/excluded paths disclosed separately.

Reproduce the corpus with:

```sh
SCIP_QUERY_AUDIT_OUTPUT=/tmp/scip-query-ts-repairs-check npx vitest run --config benchmarks/typescript-accuracy-audit/vitest.config.ts
```

Regular tests contain executable regressions for the production fixes. The audit records a wider set of observations, including unsupported cases; inspect its results rather than interpreting four passing recorder tests as proof of completeness.

## Compatibility and retained findings

Producer revision 6 sends older TypeScript output through the existing freshness/migration path. The public API adds `scip-declaration` candidate evidence. This is recorded as breaking because consumers that exhaustively handle that union must account for the new member. No VM install, commit, or push was performed in this turn.

Complete heap/alias analysis, virtual dispatch, inter-module write ordering, asynchronous scheduling, exception/finally propagation, and complete dynamic target sets remain unsupported. Candidate declaration edges are inspection leads; they must not establish execution or propagate values through an unproved body.

Final quality review retains **23 findings**: ten existing, nine introduced complexity warnings, and four worsened findings. Source contains **72 files against its limit of 67**, including the two newly separated binding modules. No threshold or suppression was changed. Architecture reports no observed cycles or forbidden production/test edges, but ten audit source files remain outside a configured boundary. These maintainability findings remain separate from the repaired accuracy violations.
