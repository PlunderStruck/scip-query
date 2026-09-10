# TypeScript exact-claim repairs — 2026-09-09

Status: fixes and verification complete. Historical discovery observations remain unchanged in [the original audit](2026-09-09-typescript-exact-claim-audit.md).

An exact implementation claim identifies the function or constructor body that an invocation executes within the tool's stated coverage. A compiler reference identifies a declaration; that alone does not establish the current runtime body. A literal value claim identifies the value an expression produces. Both claims now require the corresponding source proof rather than inheriting certainty from a declaration.

## Repairs

| Finding | Repair |
| --- | --- |
| TS-X01: shared mutable values | Follow compiler-linked references into other modules and qualify writes through imports, aliases, callbacks and deferred writers. Preserve primitive constants and unchanged properties. Namespace bracket accesses retain their complete access expression; unmapped references prevent constant claims. Whole-file checks include writes at the inspected occurrence itself. |
| TS-X02: evaluation before a return | Require supported argument evaluation, parameter binding and preceding declarations to complete before publishing a constant return. Destructuring, iteration, conversion, absent bindings and other unproved operations remain unknown. Lazy function creation and ordinary parameters/constants retain their supported results. |
| TS-X03: Reflect receivers | Attribute writes to the receiver argument. Qualify setter behavior, including setters installed with property descriptors; a declared property type does not establish its current descriptor. Preserve unaffected target and sibling-property controls. |
| TS-X04: direct eval | Treat visible lexical bindings as potentially changed by direct builtin eval. Share that qualification between value evaluation and callable identity. Indirect eval retains its separate scope. |
| TS-X05: decorated constructors | Preserve the compiler declaration but withhold established implementation identity when class decoration can replace the constructor. Check precise class containment, including adjacent classes on one line. |
| TS-X06: inadequate body ranges | Require column-precise containment of the resolved callable body. Zero-width declaration placeholders and neighboring same-line bodies cannot establish implementation identity. Alias formatting no longer changes that decision. |

## Runtime caches and build correctness

A reference-file set is the collection of indexed files that mention a particular compiler symbol. A new writer can change a shared value without changing any previously consulted file. Runtime extraction now records these sets alongside consulted file hashes, revalidates both before a cache hit, and revisits affected proofs during incremental retention. Its version is `runtime-boundaries-v29`, invalidating older extracted facts. Regression tests check both saved graphs and live queries while writers are introduced and removed.

Verification also exposed a build race: `dist/cli.js` was emitted before another concurrent build configuration cleaned the output directory. Cleanup now runs once before any configuration starts. An earlier full-suite run had 12 missing-CLI failures because of this race; those failures are not counted as successful validation.

## Verification

The required regression file contains 35 tests, including independently compiled and executed programs, graph strength checks, positive controls, and repeated changes to shared writers. The audit additionally executes 686 programs, checks 27 instrumented call traces, exercises 7 HTTP consumers and 8 built-CLI projections, and compares 18 indexing histories with clean builds. Native ESM execution checks the same 15 public fixtures.

`benchmarks/typescript-accuracy-audit/verify-exact-repairs.mjs` fails when the audited errors return. It also requires 16 actual incremental transitions; clean rebuild fallback is not counted as incremental coverage. Running it on the saved faulty audit correctly fails at its 111 wrong literals. No agents or agent benchmarks are involved.

The [verified machine report](typescript-accuracy-audit/2026-09-09-exact-claim-repairs.json) records 536 source/configuration hashes and these results:

- All 686 programs compile and match their independent execution expectations.
- The additional corpus's 111 wrong literals, six wrong established bodies and six inadequate established body proofs are reduced to zero. No wrong literals remain across the combined corpus.
- No false parameter mappings were observed in the selected transfer cases.
- All 18 histories match clean compiler and graph results after normalizing disposable checkout paths; 16 exercised incremental indexing.
- All seven HTTP consumers, eight CLI projections and 15 native ESM checks pass the strict verifier.
- Build, formatting, lint, type checks, public API checks and skill-link validation pass.

The final full-suite run covered 3,767 tests in 413 files: 3,765 passed and two hit timing failures. The new multi-update test exceeded Vitest's default five-second budget; it now has an explicit 30-second budget. An existing watcher-cleanup test timed out waiting for process termination. A targeted rerun of both files passed all 36 tests, including all 35 new regressions. No production change was made to hide the watcher-cleanup failure. All test cases have passing results across the full run and this rerun; a single uninterrupted green full-suite run is not claimed.

The source review accounts for all 586 eligible source files and retains 23 findings from the existing changes. No additional complexity warnings remain in the helpers introduced by this repair. Architecture reports no forbidden edges, cycles or test-boundary violations within its disclosed coverage; its existing source-file limit violation remains. Diff-impact reports 154 changed symbols and 179 affected files across the entire existing working-tree diff, with 42 excluded/unindexed changed paths disclosed. These totals include work that predates this repair.

Earlier failed runs and the additional fixes they motivated are described above and in [the repair plan](../plans/2026-09-09-typescript-exact-claim-repairs.md).

## Remaining limits

These repairs close the six observed failure families. They do not establish complete TypeScript runtime support, whole-program object identity, or protection against unindexed plugins and arbitrary dynamic loading. Unsupported evaluations remain unknown; unproved callable implementations remain candidate or unresolved evidence.

The audit separately reports nine missing projected local compiler targets and fifteen imprecise declaration ranges in the additional corpus. None is used as an established body proof in the repaired measurements. Those are remaining coverage limitations, not evidence that every possible TypeScript graph relationship is now available.

The repository review also retains pre-existing complexity findings and the source boundary's 72-file count against its configured limit of 67. No thresholds or suppressions were weakened to make this repair appear clean.
