# Analysis surface compression atlas

The product supplies evidence for understanding and reviewing code changes. A relationship is a recorded connection between identified source elements, distinguished by what establishes it: a compiler reference, a call, a value transfer, a control condition, a declared dependency, or an observed resource interaction. These connections do not by themselves establish good design.

## Scope and roles

This pass covers redundant public commands and API exports, aggregate health grading, default skill installation, and the truthfulness of data-flow and slicing results. Exact source acquisition, shared graph providers, architecture rules, change impact, and finding suppression remain supported responsibilities. Domain ownership means responsibility for enforcing a rule or controlling a resource; lexical containment alone cannot establish it.

## Opportunity ledger

| Opportunity | Disposition | Evidence and boundary |
| --- | --- | --- |
| Deprecated anchors and system-map CLI workflows | Delete | Current search/evidence/inspect provide the supported workflow. Anchor discovery has no remaining production consumer outside its old handler and public export. Retain the system-map topology provider used by graph evidence. |
| Deprecated evidence-source, deep-chains, convergence, dataflow, slice command names | Delete | Retain inspect, dependency-depth, similar consolidation, reference-neighborhood, reference-reachability, value-flow, and dependence-slice according to their actual meanings. |
| PlanContext and outcome compatibility exports | Delete | The documented one-minor retention period started in 0.20.0; the checkout is 0.25.0. Keep repositoryContext. Record the breaking public API change. |
| Overall, risk, and hygiene grades and deduction/pressure machinery | Delete | Arbitrary weighted deductions cannot establish architectural quality. Preserve findings, concrete complexity measurements, policy exclusions, evidence, and coverage. |
| Score-shaped setup summaries and cached health reports | Supersede | Represent report availability explicitly; invalidate the old cache shape. |
| Installing every specialist skill by default | Supersede | Install the exploration pair by default; provide explicit installation of all shipped skills. Preserve user-owned files and existing optional installations. |
| Navigation session enforcing retired commands | Delete | Remove the anchors/system-map prerequisite for source reads and its exclusive state owner. Preserve immutable output continuation and evidence receipts. |
| Value flow and dependence slicing | Supersede | Preserve compiler value-transfer providers. Replace the symbol-summary slice with traversal from one selected variable occurrence through function-local reaching definitions, assignment sources, and control dependencies. Reject ambiguity; disclose partial analysis and bounds. |
| Missing predicate input edges | Repair | A branch slice included the controlling condition but could omit the variable used by that condition. Connect predicate reads to the predicate point; the regression fixture fails without this edge. |
| Slice-based splitting recommendations | Enforce | A backward slice collects source occurrences connected to a selected occurrence by value use or conditions governing execution. Present possible extractions as review candidates. Tests require partial analysis and withheld cohesion signals for unsupported return/break/continue through finally. |
| Formal-model commands and specialist review workflows | Skip | Distinct optional responsibilities; no verified redundancy sufficient to justify deleting their implementations in this pass. |
| A new whole-program alias and effect analyzer | Skip | This is a separate capability, not a safe consequence of renaming existing queries. Explicitly disclose the present limits and test the supported analysis. |
| Automatic architectural grades or directory-inferred domain owners | Skip | Neither is an adequate substitute for declared responsibilities, checked dependency rules, source evidence, and real change evaluation. |

## Models considered

Keeping deprecated aliases and merely hiding their help leaves duplicated public concepts and maintenance paths. Replacing all analysis with a single generic graph would erase distinctions between calls, references, and values. The selected model removes obsolete surfaces while preserving the providers and distinct factual claims used by current exploration and change review.

## Clusters and order

1. Acquire flow/slicing evidence with a read-only explorer and accept its bounded ledger before source edits.
2. Retire obsolete CLI registrations, exclusive handlers, exclusive implementations, and expired public exports together. Preserve shared topology and reference-analysis providers. Update generated command and API contracts.
3. Remove aggregate grading through query results, CLI rendering, setup summaries, dossier output, and cache validation; migrate tests to the retained findings and explicit availability.
4. Reduce default skill installation while retaining opt-in specialists and ownership checks on filesystem links.
5. Correct verified flow/slicing defects or overclaims with behavioral fixtures, and document exact capabilities and limitations.
6. Run the required build, type checks, meaningful tests, command/API contracts, diff impact, and architecture validation. Review the final diff for remaining dead imports, obsolete documentation, and unintended public removals.

## Touch map and validation

The CLI and query export cluster owns `src/runtime/query-commands`, query barrels and public entries, package exports, exclusive legacy modules, and their contract tests. Health owns `src/queries/health`, runtime health rendering/caching/dossier/setup consumers, and their tests. Installation owns `src/runtime/setup.ts`, its command descriptor/handler, and filesystem-ownership tests. Flow changes are limited to the verified provider/query issue and behavioral fixtures identified by acquisition.

Generated documentation and API manifests follow their source owners. Historical release notes remain historical. No unblocked opportunity is deferred; skipped items are distinct capabilities without an established removal justification.

## Implemented boundaries

Reference navigation retains its actual behavior under `reference-neighborhood` and `reference-reachability`. Context fields, rendering, and traversal options use these meanings. The occurrence slice is local to one function in TypeScript or JavaScript; candidate closure/field edges remain outside its exact result. General heap aliasing, execution across callees, and closure invocation order require separate evidence.

The internal topology engine remains shared production code. This pass removes its obsolete public workflow and exclusive renderer; it does not claim to have replaced the internal engine. Formal analysis and specialist skills remain optional capabilities. Good architectural decisions still require stated responsibilities, checked dependency rules, and evaluation of actual changes.

## Verification record

The build, full lint pipeline (including the public API consumer and skill-link checks), and source/contract type checks pass. The architecture check covers 516 indexed files across 36 boundaries and passes after deleting the retired compatibility boundary and its two unused permissions. Diff impact identifies 77 changed symbols and six additional consumer files; it explicitly reports changed ranges without indexed symbols, so this report is not exhaustive verification of deletions.

The API acceptance record includes the intended breaking removals and slice/context changes. It also synchronizes the manifest with `SliceCohesion` signatures already present in the baseline source. This pass changes that analyzer's recommendation wording and adds coverage tests; it does not redesign its result model.

The full suite passes with `npm exec -- vitest run --maxWorkers=1`: 329 files, 2,838 tests, exit code 0. The default two-worker run passed the same assertions but exited with a Vitest `onTaskUpdate` RPC timeout; serial execution resolves the runner failure in this checkout without changing tests or suppressing errors. Focused slice tests cover overwritten definitions, assignment sources, branch conditions, forward propagation, occurrence ambiguity, output/depth bounds, closure candidates, and unsupported abrupt-finally sequencing. A CLI smoke read also confirms that bounded output and unsupported compiler constructs are disclosed together.

These checks validate analysis and integration behavior. They do not measure whether agents using the tool produce better refactors; that remains an evaluation task on real changes.
