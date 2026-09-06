# Full-tool audit: assessment and repair decisions

Status: all ten findings assessed; production repairs remain open. This assessment supersedes the original report's priority judgments and the interpretation of its assertion totals.

This document assesses the ten findings in the [original audit report](../benchmarks/2026-09-05-full-tool-audit.md). The [original probes and captured results](../../benchmarks/full-tool-audit/2026-09-05/README.md) remain historical evidence. Reclassification here does not silently change those captures.

For each finding, check the observed failure, the strongest explanation in the implementation's favor, the effect on an agent's decision, the smallest justified repair, and the behavior that would demonstrate the repair. A priority is a repair-order judgment, not a count of failed assertions.

- [x] F01 — Slice completeness and omitted dependencies.
- [x] F02 — Exact file identity and fuzzy symbol fallback.
- [x] F03 — Setup operation results versus readiness checks.
- [x] F04 — Trace-loading failures from mappings versus CLI arguments.
- [x] F05 — Complexity definitions and actual call counts.
- [x] F06 — Current files versus Git-tracked deletions.
- [x] F07 — Suppression storage, containment, and decision application.
- [x] F08 — Test declarations versus invocation callbacks.
- [x] F09 — Checker distribution and checksum rejection.
- [x] F10 — Discovery of the primary maintenance workflow.
- [x] Assess the audit assertions themselves and record verification limits.
- [x] Update the repair sequence and link this assessment from the original documents.

## Decisions

The first-use scanner reads current TS/JS files and reports measured functions, repeated code, and module/import findings within its disclosed coverage. These findings do not establish that every module has one coherent purpose or that every flagged pattern should be changed. The present audit supports repairing this scanner and its surrounding workflow, not discarding it.

Four finding groups retain P1 priority: they can give an agent the wrong source identity, omit relevant behavior while claiming completeness, silently skip required verification input, or write outside the intended directory. P2 covers measurement and workflow failures to repair next. P3 covers lower-impact detector noise and product discovery. These are relative priorities for this product, not security severity ratings or estimated failure frequencies.

| Finding | Assessed status | Priority | Decision |
| --- | --- | --- | --- |
| F01 | Confirmed, with four separate repair areas | P1 | Correct supported local flow; disclose unsupported constructs immediately. |
| F02 | Confirmed | P1 | Preserve explicit file intent before symbol suggestions. |
| F03 | Confirmed but narrower than the original framing | P2, reduced from P1 | Fix obsolete command; distinguish readiness from exercised operations. |
| F04 | Confirmed | P1 | Report every declared trace load error. |
| F05 | Actual call-count defect plus metric-definition inconsistency | P2 | Separate call evidence; establish a shared TS/JS metric contract. |
| F06 | Confirmed for the current-file locator | P2 | Filter absent working-tree files at the appropriate boundary. |
| F07 | Two storage defects plus a source-workflow integration gap | P1 storage; P2 workflow | Repair containment and round trips before applying decisions. |
| F08 | Confirmed heuristic false positive | P3, reduced from P2 | Recognize test invocations structurally. |
| F09 | Confirmed distribution failure; checksum guard works | P2, optional subsystem | Repair the distribution contract while preserving verification. |
| F10 | Confirmed mismatch with the intended product workflow | P3 | Expose first-use health and change review; label specialist modes. |

## F01 — Incomplete slices presented as complete

A backward slice is an analysis result identifying the statements and inputs that can influence a selected value. Here, four valid functions have behavior that their supposedly complete slices omit: a fallback used when a conditional assignment does not run, a write through another name for the same object, or an increment inside an initializer. A fifth case accepts malformed syntax without disclosing incomplete coverage. The focused rerun reproduced all five failures; actual executions establish the behavior of the four valid cases.

**Assessment:** confirmed P1. The strongest defense is that the analysis is deliberately local and bounded. That does not cover these cases: the relevant operations are inside one function, and the results say `complete`, with no unsupported constructs or omitted edges. The separate bounded-output control correctly reports omissions. An agent could therefore plan an extraction using an incomplete account of what affects its result. No unsafe agent edit was executed in this audit.

**Repair:** split the work into conditional writes, local aliases, expression-level mutations, and parse diagnostics. First prevent affected results from claiming completeness, identifying the unsupported construct and its location. Then implement the supported cases correctly. Preserve the existing conservative treatment of unfamiliar syntax; do not promise general alias analysis across arbitrary object graphs or function calls.

**Acceptance:** the conditional and alias slices include the witnessed influence, and the increment slice includes the mutation, or each explicitly states its limitation. Malformed input cannot receive unqualified complete coverage. An unconditional overwrite must still exclude the overwritten value. Test both outcomes of each conditional, bounded output, and the slice-cohesion/evidence consumers of the shared provider. Passing disclosure tests establishes honest limitations; it does not establish that the missing flow has been implemented.

Producer: [local-flow.ts](../../src/semantic/typescript/local-flow.ts), especially lines 138–180 and 695–794; [dependence-slice.ts](../../src/queries/graph/dependence-slice.ts), lines 163–172. Retain the slice capability, restrict its claims, and repair it before using it as a refactoring authority.

## F02 — A missing file becomes another symbol

The exact missing path `src/runtime/command-kit/help.ts` produced the source of `CommandDescriptor.helpAfter`. An isolated fixture reproduced the same behavior. A different missing path correctly returned no match, so this is an input-dependent failure, not every missing-file lookup failing.

**Assessment:** confirmed P1. Flexible selectors legitimately accept both file names and compiler symbol identities, but substituting an unrelated symbol after an explicit path fails is not a valid resolution of that path. The single fuzzy candidate is labeled matched. This can make an agent cite or edit the wrong source.

**Repair:** classify explicit file selectors before fuzzy symbol matching. An absent file must remain absent; possible symbols can be separately labeled suggestions. Apply the rule to both batch and legacy code-reading APIs. Preserve full compiler symbols, which can themselves contain path-like text, rather than rejecting every selector with a slash.

**Acceptance:** reproduce the missing-path witness through the library and CLI; retain valid exact files, file ranges, qualified symbols, and full compiler symbols. Cover extensionless and Windows-style paths before claiming support for them. Ambiguous text must remain ambiguous or suggested, never silently promoted to exact file evidence.

Producer: [code.ts](../../src/queries/navigation/code.ts), lines 123–135 and 172–217. Retain symbol suggestions; remove implicit substitution for explicit file requests.

## F03 — Setup conflates readiness and execution

Setup prints `scip-query capability-matrix --json` as a passed smoke test, although invoking that command fails because it does not exist. Other rows infer availability from a fresh index or capability data. A smoke test is a small execution intended to demonstrate that an operation runs; a readiness check inspects the prerequisites for running it.

**Assessment:** confirmed, reduced to P2. The original framing was too broad. Reindex, configuration, and other rows reuse real operation results, the evidence text explains several readiness inferences, and the captured overall setup verdict was `partial`. This is not evidence that all setup validation is fictitious or that setup declared the whole repository healthy. The obsolete command and misleading row classification still need repair.

**Repair:** print the supported `capabilities --matrix` invocation. Keep actual operation results separate from readiness checks, or explicitly identify the basis of each result. Setup's health label must name the health mode actually run; it currently runs indexed health while displaying ordinary `health`.

**Acceptance:** every printed command parses; a failed exercised operation cannot become a pass because its prerequisites exist; a readiness-only row is not described as an executed test. Preserve valid reuse of results already collected during setup. Test source and indexed health selection and failures separately.

Producer: [project-setup.ts](../../src/runtime/project-setup.ts), lines 902–1011 and 1158–1189. Remove redundant or misleading rows rather than launching every expensive command just to justify the table.

## F04 — Mapping-declared trace failures disappear

A trace is a recorded sequence of program states or events supplied for comparison with a model. Declaring `missing-trace.json` in a model mapping yields no load-error finding and an exit code of zero. Passing the same missing trace through `--trace` yields a load-error finding and failure.

**Assessment:** confirmed P1. Both tests deliberately selected `--checker none`; no external model checker ran. That limits claims about checker integration, but it does not excuse silently omitting an explicitly declared input. The missing mapping trace also passed without `--allow-unknown`. The implementation filters errors by their appearance in CLI arguments, after combining inputs from both sources.

**Repair:** report load errors for every declared trace, retaining its resolved identity and declaration source. Deduplicate equivalent paths without losing failures. Do not fix this by making an omitted trace look like an empty valid trace.

**Acceptance:** missing, unreadable, and malformed traces fail consistently whether declared in the mapping, CLI, or both. Equivalent relative paths produce one trace contribution and a recoverable error rather than suppressing it. Valid inputs continue to distinguish skipped checker execution from actual checker results.

Producer: [tla.ts](../../src/runtime/query-commands/tla.ts), lines 313–353. Keep formal verification optional, but repair this unearned success before trusting that subsystem.

## F05 — Complexity needs a defined unit; callees need call evidence

Cyclomatic complexity is a numerical measure of control-flow branching, normally starting at one and increasing for decisions under stated counting rules. A function containing a nested function is measured as 1 by the source scanner and 2 by the indexed estimator; `x ?? 0` is measured as 2 and 1 respectively. Separately, the compiler-indexed fixture's call-free `choose` function reports three callees, meaning three functions it supposedly calls.

**Assessment:** keep P2, split the claims. The indexed field is explicitly named `cyclomaticEstimate`, so two differing counting conventions do not alone prove a broken exact measurement. They do make cross-command comparisons unsuitable without a shared definition. The callee count is a stronger defect: chunk-level candidate neighbors are added to direct call evidence and reported as distinct callees. The ordinary call-graph control correctly found the real `run → choose` call; this does not condemn every graph query. Cognitive-complexity correctness is not established or refuted by these particular witnesses.

**Repair:** publish one versioned function-level TS/JS counting contract and reuse its implementation where commands claim the same metric. If a specialist estimate retains different rules, label it distinctly and prevent direct comparison. Keep possible call targets separate from established call counts; correct derived fan-out values using the same evidence distinction.

**Acceptance:** the call-free witness has zero established callees, while actual calls still appear. Check nested functions, nullish expressions, branch chains, and method boundaries under the selected metric rules. Source/indexed equality becomes a required test only where the contract explicitly promises the same measurement. CRAP calculations must identify the complexity definition and coverage input used; existing full/half/zero-coverage controls remain valuable.

Producers: [complexity.ts](../../src/queries/quality/complexity.ts), lines 61–80 and 222–249; [call-graph-evidence.ts](../../src/symbols/graph/call-graph-evidence.ts), lines 314–363; [function-metrics.ts](../../src/source/ast/function-metrics.ts). Consolidate duplicate metric implementations where their intended meaning matches.

## F06 — Current-file results contain deleted files

After a tracked file is deleted from disk, the `files` result still includes it. Git retains tracked path names for deletion reporting, so a Git inventory can legitimately contain absent working-tree files.

**Assessment:** confirmed P2 at the current-file locator boundary. This does not mean the new scanner reads deleted files: `currentSourceSnapshot` uses `presentProjectFiles`, which already filters them. Nor should a repair remove deleted paths from the historical snapshot or change-review comparison that needs them.

**Repair:** make the current-file surface select present files, preserving the separate Git inventory where it describes tracked or historical state. Report failures to read a file that disappears during scanning rather than implying complete source coverage.

**Acceptance:** the deleted tracked file disappears from current-file results; newly created eligible files appear; a base-versus-current review still reports the deletion. Keep explicit exclusions and unreadable-file coverage visible.

Producers: [project-files.ts](../../src/platform/project-files.ts), lines 488–494 and 828–839; [files.ts](../../src/queries/navigation/files.ts), lines 14–19. Scanner control: [maintenance-snapshot.ts](../../src/source/maintenance-snapshot.ts), lines 49–55. Clarify inventories rather than globally changing Git enumeration.

## F07 — Suppression storage and policy application are separate failures

A suppression is a stored decision requesting that a particular finding stop blocking work under specified conditions. Saving its JSON and validating its shape do not establish that the decision satisfies those conditions. Adjudication is the policy evaluation that accepts the decision, expires it, invalidates it after relevant changes, or requires further review.

**Assessment:** split into three work items:

1. **Directory containment, P1.** The ID `../../escaped-audit` created a JSON file outside `.scipquery/suppressions` in the disposable repository. Raw IDs are used as file names. The existing revision comparison and record parsing defend existing files; this audit did not demonstrate arbitrary overwrite, remote access, or privilege escalation. A locally supplied ID still must not select another write directory.
2. **Storage round trip, P1.** A normal source-finding ID containing `src/calculate.ts` creates a nested record which the top-level directory reader does not discover. An ordinary successful write can therefore disappear from subsequent reads without a warning.
3. **Source workflow, P2.** First-use suppression requires an index even though source health does not. After indexing, a flat-ID control avoids the nested-file bug but source health still gives no decision result. The source report constructs findings without suppression adjudication. The original claim that an *accepted* exception was ignored was too strong: successful writing and configuration validation did not prove acceptance.

**Repair:** use deterministic safe storage names and retain the original finding identity inside each record. Preserve conflict detection when separating logical identity from filename; those concepts currently share an implementation. Make old nested records discoverable or migrate them with explicit diagnostics and conflict handling. Never silently search for or move records outside the storage boundary. Then connect policy evaluation to source health/review without requiring an index for source-backed evidence.

Raw findings and measurements should remain inspectable. Report whether a matched decision is accepted, expired, invalidated, or requires review, and let that result determine whether the finding blocks a check. A syntactically valid reason code or unchanged evidence hash does not itself prove that an agent's justification is correct.

**Acceptance:** round-trip ordinary slash-containing IDs and adversarial path IDs; prevent writes outside the intended directory, including relevant symlink cases; preserve existing-file conflicts and explicit replacement checks. Test migration with duplicate/conflicting records. For source health and review, explicitly establish an accepted decision before expecting its gate effect; separately test missing evidence, expiry, changed content, unmatched IDs, and no-index first use. Do not require findings to vanish from raw output.

Producers: [suppression-store.ts](../../src/storage/suppression-store.ts), lines 87–95 and 178–211; [suppression-writer.ts](../../src/runtime/suppression-writer.ts), lines 118–153 and 219–237; [source-review.ts](../../src/queries/health/source-review.ts), lines 62–67 and 125–143. Existing policy: [suppression-adjudication.ts](../../src/domain/suppression-adjudication.ts), lines 62–101. Retain reviewable exceptions and remove the raw-ID-as-path coupling.

## F08 — A test declaration is mistaken for a test invocation

The detector reports both `declare function test(...)` and the actual `test('does no assertion', ...)` invocation as assertion-free tests. The declaration describes a callable interface; it does not register or execute a test callback.

**Assessment:** confirmed false positive, reduced to P3. This detector supplies heuristic review candidates, so the failure is lower impact than a false claim of complete dataflow. The actual weak test is correctly detected. The observed declaration error warrants correction; it does not show that all test-quality findings are noise or measure detector accuracy across real repositories.

**Repair:** identify supported test call expressions and their callbacks using parsed syntax, instead of treating every matching character sequence as a call. Keep unsupported wrappers and indirect assertions visibly uncertain. `test.each` is currently skipped; improving it is a separate coverage expansion, not required to fix this declaration bug.

**Acceptance:** the declaration produces no finding, the actual assertion-free callback still does, and assertion-bearing callbacks remain distinct. Cover comments/strings, regular-expression `.test()` calls, skipped tests, supported modifiers, and imported aliases where supported. Do not turn unsupported callback shapes into a clean-test claim.

Producer: [test-quality.ts](../../src/queries/cleanup/test-quality.ts), lines 155–186. Keep a bounded detector with disclosed support; replace the fragile call-identification mechanism.

## F09 — The checker download violates its expected digest

A checksum is a value computed from file bytes to detect a mismatch with the expected artifact. The installer expected SHA-256 `237332bdcc79a35c7d26efa7b82c77c85c2744591c5598673a8a45085ff2a4fb`; the earlier download and the independently rechecked official release metadata identify `b658b4e504fdf0b721caf7066320f6b6fe5805f4dd2f717d0e47baba4097205e` for `tla2tools.jar`. The metadata still marks v1.8.0 as a prerelease and identifies a September 4 asset update. [Official release metadata](https://api.github.com/repos/tlaplus/tlaplus/releases/tags/v1.8.0).

**Assessment:** confirmed P2 distribution failure in an optional subsystem. Rejecting the mismatch is correct behavior. It prevents installation through this path, but does not break source scanning or prove an attack occurred. Release metadata matching the downloaded bytes establishes agreement, not that replacing the trusted pin is justified.

**Repair:** establish which immutable build the tool intends to distribute and verify its provenance before changing the version, URL, or digest. Preserve checksum enforcement and an explicit unavailable result. Keep checker installation outside the ordinary exploration/maintenance setup path.

**Acceptance:** the chosen supported artifact installs; altered bytes still fail without execution; the installed checker passes a valid model and rejects a known invalid one through the real adapter. Recheck cache behavior. No live checker was executed in either the original audit or this assessment, so that adapter validation remains open.

Producer: [tool-runner.ts](../../src/tla/tool-runner.ts), lines 76–78. Preserve the guard. No new binary download or pin change was made for this assessment.

## F10 — The primary workflow is hard to discover

Ordinary help omits source `health` and change `review`, although both exist. Setup's optional health run and baseline controls still lead through indexed health. This makes the intended first-use and before-commit workflow difficult to infer from the product itself.

**Assessment:** confirmed P3 product integration gap. The original help grouping was deliberate and the commands remain available through expanded help; this is not a failed source-analysis algorithm. The grouping no longer fits the user's stated purpose for the tool.

**Repair:** expose source health, planning/exploration, and change review as the primary workflow. Make setup's health operation match its displayed command and explain index-dependent specialist modes. Describe baseline scope explicitly. Keep optional formal modeling and other specialist features discoverable without making them prerequisites for first-use value.

**Acceptance:** in a fresh repository, ordinary help leads to an index-free scan; an agent can find the review command and run it after an edit; setup names the mode it ran. Existing indexed workflows still have an explicit route. Evaluate a representative planning/change task with the cheaper model requested by the user after correctness repairs; help visibility alone does not establish agent benefit.

Producers: [command-panels.ts](../../src/runtime/commands/command-panels.ts), lines 84–86; [project-setup.ts](../../src/runtime/project-setup.ts), lines 1158–1189. Remove obsolete workflow labels and redundant routes where compatible; this audit does not justify deleting every specialist capability.

## Assessment of the audit itself

The historical count of **19 failed assertions out of 35** is accurate, but it is not a count of 19 independently established bugs or a defect rate for the product. Six failures need qualification:

| Failed assertions | Assessment |
| --- | --- |
| 13 failures concerning slices, file identity/inventory, storage, calls, declaration detection, missing traces, and the obsolete setup command | Reproducible behavioral defects within their demonstrated scope. Multiple failures belong to the same finding. |
| 2 source/indexed complexity equality failures | Demonstrate different definitions; equality is a repair target where the product adopts a common metric contract. |
| 2 suppression-output failures | Inadequate acceptance tests: one requires a property literally named `suppressions`; the other assumes policy acceptance and requires disappearance from raw findings. Replace them with explicit decision and gate-behavior checks. |
| 2 default-help failures | Verify the desired product workflow, not an existing analysis-correctness contract. |

The original artifacts and assertion results are preserved. In particular, lowering a priority or rejecting an over-specific test does not make the underlying storage or missing-policy-integration problem disappear. Before moving probes into the normal test suite, correct these expectations and use behavioral assertions that allow truthful limitations and explicit policy outcomes. Full metric equality is appropriate only after adopting the shared metric contract.

Verification in this follow-up:

- Compared all **523 recorded source/configuration/package input hashes**: none changed since the full audit.
- Reran the library probes against current source: **7 of 18 assertions passed, 11 failed**, with exactly the same named outcomes as the original capture. Two of those failures are the qualified complexity-equality checks above. The probe run creates and removes its own temporary fixtures.
- Inspected the disputed setup, complexity, suppression, test-call, trace, file-selection, and help contracts in current source. The CLI captures remain historical; this was not a second run of all 83 query invocations.
- Rechecked the official checker release metadata on **2026-09-06 UTC / September 5 local time**. No checker binary was executed.
- The earlier **2,900 passing tests in 337 files** remain evidence from the original audit. Production code was unchanged, so the full suite was not rerun for this documentation follow-up.

Fresh probe results, metadata verification, and the assertion classification are saved under [assessment artifacts](../../benchmarks/full-tool-audit/2026-09-05/assessment/verification.json). Remaining limits include other language adapters, live formal checking, Windows/Linux lifecycle behavior, the accuracy of every smell detector, and whether agent changes actually improve. No new LaunchPoint backend run occurred in this follow-up.

## Repair sequence

These are implementation tasks, all still open. They replace the earlier undifferentiated repair list; completed assessment checkboxes above do not mean repaired code.

1. **F07 storage:** confine filenames, preserve logical identity and conflict handling, then handle existing nested records. Finish storage acceptance before connecting source policy decisions.
2. **F02 identity and F01 completeness:** prevent wrong source substitution and unqualified slice completeness. Implement the supported flow cases and exercise downstream consumers; disclose limits for anything deferred.
3. **F04 trace input handling:** preserve every declared load failure. This repair does not require repairing checker downloads first.
4. **F05 measurements and F06 inventory:** fix actual call counts; adopt and share the metric contract; keep current-file and historical inventories distinct.
5. **F07 source policy and F03 setup:** connect explicit decision outcomes to health/review, then make setup report exercised operations and prerequisites accurately.
6. **F08 and F10:** reduce test-detector noise and expose the intended agent workflow. Small help corrections can accompany setup repairs.
7. **F09 optional distribution:** establish and validate the intended checker build; do not block source-maintenance releases on optional checker installation, provided its unavailability is explicit.
8. **Revalidate:** convert the justified witnesses into regression tests, regenerate current captures without overwriting historical evidence, run relevant and full checks, inspect diff impact after implementation changes, and test representative agent outcomes with the requested cheaper model.

The useful simplification is to remove false equivalences: readiness versus execution, path identity versus fuzzy suggestions, candidate neighbors versus calls, raw findings versus accepted exceptions, and incompatible complexity measures presented as comparable. The retained capabilities should each have one clear contract and evidence that it holds.
