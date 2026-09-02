# Graph accuracy investigation

Date: 2026-09-02

## Purpose

The detector calibration recorded in
`docs/validation/2026-09-02-launchpoint-health-calibration.md` corrected how
findings are _interpreted_. The graph underneath the detectors (references,
calls, file dependencies, change history) has its own error modes, and three
probes on the same repository exposed two of them. This plan records every
lead and the method for finding the next ones, and tracks each to a result.

An inaccuracy here is a case where a graph question (`who references X`,
`what does X call`, `which files form a cycle`) answers differently from
what the compiler or a reader of the source would answer. Precision errors
make detectors report non-findings; recall errors hide findings and are the
more dangerous kind because nothing in the output points at them.

## Leads

| #   | Lead                                                                                                                                                                                                        | Evidence                                                                                                                                                                                                                                                                                                                                                                 | Status |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| 1   | JSX rendering is not an execution edge. A component that renders `<Child />` has no callee edge to `Child`; the child appears only as a same-chunk candidate, or not at all when it lives in the same file. | `call-graph` on `BulkMetaRunDialog`: 21 exact callees, all helpers; four rendered children only as `chunk-candidate`; same-file `SendingListThumb` absent while `refs` sees line 905. Understates fan-out for React orchestrators, hides child clusters from `extract-candidates`, blinds `similar` callee fingerprints, weakens `diff-impact`/`entry-map` reachability. | closed |
| 2   | Callee accuracy is unmeasured. `self-audit` scores references (0.96 precision, 1.0 recall on 100 samples) but skipped the callee question for 98 of 100 symbols because the oracle was partial.             | `self-audit --samples 100` on Launchpoint. Every callee-based detector (complexity, extract, similar, passthroughs, wrapper delegation) rests on an unscored graph.                                                                                                                                                                                                      | closed |
| 3   | No seeded-defect recall check. Every calibration so far removed rows; nothing asserts that a planted cycle, duplicate, dead export, rendered-only component, forwarder, or twin is still found.             | Precision work without a recall counterweight trades recall away silently.                                                                                                                                                                                                                                                                                               | closed |
| 4   | No labeled-sample harness. The full-list classification was a one-off; detector changes cannot be re-scored against it.                                                                                     | Today's labels live in a scratch directory.                                                                                                                                                                                                                                                                                                                              | closed |
| 5   | Policies validated on one repository.                                                                                                                                                                       | All calibration data came from Launchpoint.                                                                                                                                                                                                                                                                                                                              | closed |

Negative result worth keeping: the 731-file cycle component (symbol-reference
basis) shrinks to 57 files on the imports-only basis, and after removing barrel
and test files it contains no cycle at all. The module-hierarchy dismissal is
correct there.

## Method

1. **Oracle comparison per graph question.** Sample symbols stratified by kind,
   ask the cheap path and the compiler the same question, score precision and
   recall. `self-audit` is the instrument; it must cover callees with real
   oracle coverage and treat JSX rendering as a callee question.
2. **Cross-view contradiction sweeps.** Ask the same fact through two views and
   flag disagreement: identity says referenced but execution says uncalled; a
   file has import edges but no symbol edges; a co-change pair with a
   dependency edge the graph missed. Lead 1 came from this.
3. **Seeded-defect recall.** Plant known problems in a fixture and assert each
   detector reports them.
4. **Labeled full-list samples per detector**, kept in the repository and
   re-scored on every detector change.
5. **Cross-repo calibration** before a policy ships.

## Steps

1. Lead 1: record JSX element usage as a render call site in source facts so
   the AST call-site path resolves `<Child />` to `Child` like a call; mark the
   site kind so consumers that want only invocation semantics can exclude it.
   Verify with `call-graph`, `complexity`, and the React fixtures.
2. Lead 2: make `self-audit` sample callables for the callee question, report
   oracle coverage per question, and include JSX render edges on both sides.
3. Lead 3: add a seeded-defect recall test that plants one instance of every
   scored finding kind in a fixture and asserts `health` and each focused
   detector report it.
4. Lead 4: add a labeled-sample scorer that reads a detector's `--json-output`
   dump plus a label file and reports precision, plus missing labeled
   positives; seed it with the Launchpoint labels.
5. Lead 5: run the new build on a second indexed repository, inspect every
   policy exclusion class there, and record what over- or under-excludes.

## Verification

- `npm run typecheck`, `npm test`, `npm run lint`
- `node dist/cli.js call-graph <component>` shows rendered children as exact
  callees
- `node dist/cli.js self-audit --samples 100` reports callee coverage
- the seeded-defect test and the label scorer pass in CI

## Result

All five leads are closed on this branch. Numbers are from the runs recorded
in `docs/validation/2026-09-02-launchpoint-health-calibration.md` and the
Vega section below.

1. **JSX render edges.** Source facts now record a component element as a
   `jsx-render` call site (host tags and namespaced tags are skipped), the AST
   callee path resolves it like a call and marks the row `kind: jsx-render`,
   the compiler oracle resolves JSX tag names the same way, `call-graph`
   prints `[exact:resolved-call:render]`, complexity fan-out counts rendered
   children, and `similar` keeps its callee fingerprint about calls by
   excluding render rows. The source-facts payload version moved to 8 so
   persisted facts are rebuilt. Verified by `tests/symbols/jsx-render-callees.test.ts`
   and the JSX case in `tests/source/source-facts.test.ts`.
2. **Callee accuracy measured.** `self-audit` gained a `renders` question and
   treats an empty compiler answer as complete when the definition contains no
   call or render site, so the comparison no longer skips every symbol the
   partial oracle left empty. On Vega (120 samples): references precision
   0.99 / recall 1.0; renders recall 1.0 over 99 compared symbols; callees
   recall 0.294 over 32 compared symbols. That last number is the next lead:
   the cheap path misses member calls through typed receivers
   (`this.service.method()` in DI-heavy code), which the semantic path does
   resolve. It is recorded below as follow-up 6, not fixed here.
3. **Seeded-defect recall gate.** `tests/queries/health/seeded-defect-recall.test.ts`
   plants a cycle, an exact duplicate, a dead export, drifted twins, a literal
   passthrough, a forwarding wrapper, a duplicated React pair, and a
   rendered-only child, and asserts each detector and `health` still report
   them. Writing it exposed a real attribution bug: the wrapper detector
   picked the import line as the call site, lost the function-level caller,
   and fell back to file-level fan-in; it now prefers identifier lines inside
   a callable.
4. **Labeled-sample harness.** `scripts/score-detector-labels.ts` scores a
   detector dump against `docs/validation/labels/<repo>/<detector>.json`,
   separating signal-tier hits, support-tier demotions, and absences per
   verdict, and fails on a missing or demoted labeled true. The seeded
   Launchpoint sets (20 component pairs, 20 hook pairs) immediately caught a
   policy error: route-entry pairs had been demoted for hook candidates too,
   which hid three genuine invite-page pairs (recall 0.75). Shared behavior
   between route entries now counts; only shared JSX structure between route
   entries is treated as scaffolding.
5. **Second repository (Vega, 2,712 files, Next.js + NestJS monorepo).**
   Health 79 / 98 / 79 with the same build. Every exclusion class was
   inspected: 36 test-file components and 12 hook-versus-component pairs are
   correct exclusions; nothing product-relevant was removed. Two conventions
   Launchpoint does not have surfaced and were added: CRUD and lifecycle
   method names (`delete` across 24 services, `create`, `getById`, `update`,
   `list`) grouped as drifted twins, and 357 literal forwards in NestJS
   facade services reported as direct inline advice. Facade files (three or
   more sibling forwards to one collaborator) are now boundary signals, which
   moved passthroughs from 171 direct / 186 signal to 38 / 319 and the
   pressure penalty from 4 to 3 points.

Follow-up lead recorded for a later change:

| #   | Lead                                                                                                                                                                       | Evidence                                                                                                                                           | Status |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 6   | The cheap callee path misses member calls through typed receivers (`this.dep.method()`), so bounded-mode callee consumers under-count fan-out in dependency-injected code. | Vega `self-audit`: callees recall 0.294 versus the compiler; every top disagreement is a controller or service calling an injected service method. | open   |
