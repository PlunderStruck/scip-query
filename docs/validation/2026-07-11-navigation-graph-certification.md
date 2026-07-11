# Navigation and graph answer certification

Date: 2026-07-11

Verdict: **basic indexed/source answers are exact or qualified under visible
fallback boundaries; compiler overload selection, type inheritance, true value
flow, unowned top-level calls, and semantic cross-language edges are not
claimed.**

## What this certificate means

A navigation answer identifies source units, symbols, references, lexical
owners, imports, or graph neighbors in the indexed repository. What
distinguishes it from a cleanup signal is that its rows can be compared exactly
with source text, SCIP occurrences, and a hand-established graph. A qualified
answer is exact for the stated indexed/source relation but may omit facts that
require an unavailable compiler, runtime, build target, generated expansion,
or cross-language resolver.

The audit uses “dataflow” in the command's actual sense: a reference-level
producer/consumer relation around one symbol. It is not a value-flow or control-
flow analysis. “Hierarchy” means lexical containment from member to class and
module; it does not mean base-class or trait inheritance.

## Reproducible evidence

The focused suite ran 14 files and 107 tests, all passing. Hand-built SQLite,
SCIP, and source fixtures covered exact document/symbol counts, TypeScript,
Python, Rust, Scala, Java, Ruby, and source-fallback paths. The suite includes:

- ambiguous short names, same-file and direct-import disambiguation, and a
  deliberately unresolved ambiguity;
- missing definition ranges, role-one fallback definitions, exact source
  ranges, editor line syntax, nested lexical owners, and SCIP descriptor-chain
  fallback;
- TypeScript source imports when SCIP import roles are missing, Java imports,
  Ruby `require_relative`, and conservative Rust implicit-trait imports;
- exact forward/reverse file edges, source-import cycles versus ordinary
  references, diamonds/cycles, and condensed graph paths;
- source-attributed TypeScript calls, Rust qualified-path calls, Scala
  definition fallback, exact reference lines, and callable-only callee rows;
- interface versus class/type-alias kind classification, member/outline/system/
  surface range parity, and exact stats/kind aggregations.

The live replay used `discloseHealthCapabilities` and
`src/runtime/health-capability-disclosure.ts` as a single source oracle:

- `files` returned the three `src/runtime/*health*` files visible in source;
- `methods ProjectIndex` returned the 16 class methods and constructor in
  source order;
- `refs` and `trace` returned the import at line 67 and call at line 282 in
  `command-handlers.ts`, while the definition/source span was lines 22-33;
- `deps` returned exactly `health-report.ts` and `project-readiness.ts`;
  `rdeps` returned exactly `command-handlers.ts`;
- `imports`, `system`, `outline`, `code`, and `change-surface` agreed on the
  same file, definitions, signatures, and ranges;
- `call-graph` returned only callable `handleHealth` as the incoming caller and
  `unavailableCapabilityWarnings` as the callee;
- backward `slice` returned the helper dependency, while forward `slice`
  retained both module/reference and callable consumers as its broader
  reference-level contract requires;
- `kind-counts` reported 2,972 functions, 798 interfaces, 326 modules, 258 type
  aliases, 168 methods, 20 classes, and one variable; `stats` reported 328
  documents, 22,309 symbols, 20,878 definitions, and 52,626 references for the
  pinned index generation.

## Per-command verdicts

| Command       | Verdict   | Exact answer and boundary                                                                                    |
| ------------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| `files`       | certified | exact indexed document-path/glob match, including segment-aware globs                                        |
| `methods`     | qualified | lexical class/member definitions with source fallback; inherited methods are outside the contract            |
| `refs`        | qualified | resolved reference sites plus source fallback; compiler-unresolved/dynamic sites may be absent               |
| `trace`       | qualified | definition source/range plus the same reference relation as `refs`                                           |
| `deps`        | qualified | indexed/source file dependencies under the selected edge policy                                              |
| `rdeps`       | qualified | exact inverse of the available file-dependency relation                                                      |
| `system`      | qualified | matched files, owned symbols, deps, and rdeps; module matching is path-based                                 |
| `surface`     | qualified | indexed symbols consumed from a module; transparent/dynamic external package consumers are unavailable       |
| `imports`     | qualified | source/SCIP import bindings; Rust implicit-trait uncertainty is withheld rather than called unused           |
| `imported-by` | qualified | files importing the resolved symbol under available binding/path evidence                                    |
| `outline`     | qualified | lexical definition tree and source-corrected ranges; generated/unindexed definitions are absent              |
| `members`     | qualified | direct lexical children; inherited and intersection/type-alias members are not expanded                      |
| `by-kind`     | qualified | exact stored/inferred kind rows; language indexers may omit or classify constructs differently               |
| `kind-counts` | certified | exact aggregation of the current indexed kind rows                                                           |
| `hierarchy`   | qualified | lexical ancestry only; base classes, traits, and implementations are not an inheritance answer               |
| `code`        | qualified | bounded source text for the resolved definition; unavailable source remains unavailable                      |
| `dataflow`    | qualified | definition/usage sites and reference-level producers/consumers; not runtime value flow                       |
| `slice`       | qualified | bounded transitive reference relation in the requested direction; not control dependence                     |
| `call-graph`  | qualified | callable incoming/outgoing source/index edges; unowned top-level calls and dynamic dispatch are not complete |
| `stats`       | certified | exact SQLite document/symbol/definition/reference counts and index bytes for one generation                  |

## Defect found and corrected

On the live index, `call-graph discloseHealthCapabilities` initially reported
the module import and an interface/type-reference owner as callers alongside
the actual `handleHealth` call. Those rows were valid references but false call
edges. Incoming call-graph rows now require a function-like owner. The
regression fixture plants a module definition around a top-level import/call
and proves it is excluded from callers while `refs` and `dataflow` retain the
reference sites. The untouched live replay then returned only `handleHealth`.

This correction deliberately exposes a boundary: a call made at module top
level has no callable owner and is not manufactured into a caller symbol. The
reference remains visible in reference-oriented commands.

## Applicability boundaries

- Aliases and re-exports are followed only where SCIP or the source import
  resolver preserves target identity. Transparent public-barrel and dynamic
  path completeness is not claimed.
- Overload rows retain exact symbol identity and visible alternate matches, but
  choosing the compiler-selected overload for a call site is unsupported.
- Traits and implementations participate when the index exposes their symbols;
  Rust qualified-path recall has a focused regression, while macro-expanded
  and feature/target-only edges remain outside the observed graph.
- Generated files follow repository ignore/generated policies. A generated or
  omitted source unit is not recreated by navigation commands.
- Cross-language documents can coexist in one SQLite graph, but semantic edges
  between languages are unsupported unless an upstream indexer emitted the
  exact shared symbol relationship.

## Publication decision

Certified count/path rows and qualified indexed/source relationships are ready
for private shadow use with their boundaries attached. They are not proof of
runtime reachability, compiler overload choice, inheritance, or whole-program
call completeness.

Machine-readable verdicts:
[`2026-07-11-navigation-graph-certification-verdicts.json`](./2026-07-11-navigation-graph-certification-verdicts.json).
