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

Final verification on Launchpoint with the deployed build: `call-graph` on
`BulkMetaRunDialog` now lists 10 exact render edges (the dialog primitives,
`ManagedAdPublicationProgress`, and the same-file children that were
previously invisible); `self-audit --samples 100` compares references for
100 symbols (precision 0.963, recall 1.0), callees for 22 (recall 1.0, 78
still skipped as partial), and renders for 92 (recall 1.0). Both Launchpoint
label sets score precision 1.0 and recall 1.0. Counting rendered children as
fan-out raised the extreme complexity count from 140 to 173, all React
orchestrators that were under-measured before; health is 66 / 87 / 66.

Follow-up lead recorded for a later change:

| #   | Lead                                                                                                                                                                       | Evidence                                                                                                                                           | Status |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 6   | The cheap callee path misses member calls through typed receivers (`this.dep.method()`), so bounded-mode callee consumers under-count fan-out in dependency-injected code. | Vega `self-audit`: callees recall 0.294 versus the compiler; every top disagreement is a controller or service calling an injected service method. | closed |

### Lead 6 result: the indexer's own bindings as the first callee tier

The index already held the answer. Every SCIP-to-SQLite converter stores each
chunk's occurrences as a zstd-compressed `Document{occurrences}` blob, and an
occurrence at a call line is the symbol the indexer's compiler bound there.
`buildAstCalleeMap` now resolves each call site in tiers:

1. **`scip-occurrence`**: the definitions the indexer bound on that line
   whose leaf is the called name. Exactly one distinct definition is an exact
   edge; several stay unresolved rather than guessed. Rendered elements use
   the same tier.
2. **`ast-callsite`**: the previous leaf-name resolution over imports and
   local receivers, used only when the indexer bound nothing for that
   line-and-leaf. When the indexer bound the key to a symbol outside the
   repository (a library or ambient symbol), the guess is refused, which
   removes same-named false edges the fallback used to produce.

The blobs are decoded per file on demand and cached, so no consumer loads the
whole SCIP artifact; the artifact path survives only for indexes whose chunks
carry no occurrence data (fixtures). Every consumer that maps evidence source
to strength treats the new source as exact, `graph` prints it as `O`, and
`self-audit` now prints cheap rows by source so a regression in the tier mix
is visible.

Vega, same build, `self-audit --samples 300`: callees recall 0.294 → 0.981
over 87 compared symbols (378 occurrence-resolved rows, 49 leaf-name rows);
renders recall 1.0 over 240; references unchanged at 1.0. No oracle-only
callee disagreement remains in the reported list. The AST receiver-typing
tier considered for this lead was not built: the occurrence tier already
answers typed-receiver calls directly, and the remaining leaf-name rows are
calls the indexer left unbound.

### Lead 7: extraction candidates measured line coincidence, not seams

Asked whether `extract-candidates` was accurate, the answer was no, for two
structural reasons. Clusters were connected components of a callee
co-occurrence graph, so no edge ever crossed clusters and the reported
isolation was always 100%. The co-occurrence key was `CalleeRow.chunkId`,
which the original detector read as a SCIP chunk of about 200 occurrences
but which the AST callee path sets to the call line and the compiler path
sets to minus one. In bounded mode a cluster was therefore "names sharing
one line"; in full mode every compiler-resolved callee collapsed into one
cluster spanning two thirds of the body (median span share 0.67 on this
repository, 148 candidates, none of them seams). Launchpoint reported
1,258 rows, 84% labeled orchestration because they had ten callees.

The detector was rebuilt around a definition that can be checked line by
line. A seam is a contiguous range whose callees appear nowhere else in
the function: each callee's first-to-last use interval must stay whole,
overlapping intervals merge, call lines within two lines of each other
join, and the range grows over the enclosing block's opener and closer.
A region counts only when it has three exclusive callees, five lines, at
most three quarters of the body, and leaves two callees outside. Callees
used across half the body are ambient and reported separately. The SCIP
`local` occurrences the index already stores give each region its data
flow: bindings declared before and used inside are parameters, bindings
declared inside (or written inside) and read after are returned values.
A region that would take more than five locals in or hand more than two
back is support tier, listed by the command and disclosed by `health` as
a policy exclusion rather than counted.

| Repository  | Before | After (signal / support) | Signal region lines, median | Signal share of body, median |
| ----------- | ------ | ------------------------ | --------------------------- | ---------------------------- |
| scip-query  | 148    | 51 / 71                  | 16                          | 0.26                         |
| Vega        | 237    | 106 / 91                 | 19                          | 0.23                         |
| Launchpoint | 1,096  | 438 / 492                | 20                          | 0.22                         |

Every reported region is exclusive by construction, so the remaining
judgment is whether the region is a coherent unit, and the interface cost
is printed for that judgment. The seeded-defect recall test plants a seam
and asserts its exact line range; the output test asserts the inbound and
outbound locals of a planted block. `extract-candidates --full --json`
still needs a 12 GB heap on Launchpoint, which is recorded as an open
operational issue.

### Lead 8 (closed): the cycles phase did not flap; the repository changed

Three full Launchpoint health runs today on nearly identical indexes
reported five dependency cycles, then none, then five, then none again,
with no deferral warning in the empty runs. The eighteen risk points that
ride on that finding flip with it (risk 69 versus 87). The empty runs
share nothing obvious with each other yet; the next step is to run the
`cycles` command alone against the same generation several times and
compare its evidence coverage between an empty and a non-empty answer.

Result. The four runs were on four index generations of a checkout another
agent was moving. The five-cycle runs were built from Launchpoint commit
`55227a380`; the empty runs were built from a branch that already contained
`7bfaa770b` "Remove all detected dependency cycles (#3462)", which is now on
Launchpoint's main. Standalone `cycles` on the current generation reports two
module-hierarchy components and no dependency cycle, twice in a row. The
detector was consistent throughout; the finding disappeared because the team
acted on it.

The investigation found a real defect next to it. After a publication that
reused the TypeScript shard (a `package.json` change), the project snapshot
moved on but no overlay was written for it, so the next TypeScript edit made
every refresh fail with "deferred TypeScript SCIP base has no matching
overlay generation" and the watcher served a stale generation while logging
a failed run every few seconds. The incremental planner now bases the next
overlay on the overlay generation the accepted publication carries.

### Lead 9 (closed): whole-project semantic passes ran out of memory

`extract-candidates --full --json` died at the default 4 GB heap on
Launchpoint. Profiling a cold-cache run showed the sequence: the command sent
every candidate definition to the semantic service in one request; the
service's compiler worker died at its 6 GB heap ceiling
(`typescript-semantic/dead-letter` recorded "Worker terminated due to
reaching memory limit"); the service-backed provider then fell back to an
in-process compiler, which loaded 19 TypeScript projects into the command
process and died there. The warm-cache rerun peaked at 1.5 GB, which is
why the failure looked intermittent.

Four changes, each verified on the VM with the semantic callee cache
cleared and the default heap: bulk callee requests go out in bounded
per-file batches of at most 256 definitions; a service failure on a large
index (2,500 documents or 25,000 symbols) disables semantic enrichment for
the rest of the run with a stderr notice instead of loading the compiler
in-process; a service that merely lacks a request kind keeps serving the
others; and the service sizes its compiler worker heaps from the indexed
document count with a machine-memory ceiling (Launchpoint: 12.2 GB on a
61 GB machine). The cold run now completes in 1:32 at 2.3 GB resident with
no declined requests and no dead-lettered work, answering 69 batched
service requests. The occurrence-decode cache is bounded to 256 files, and
the extraction run no longer holds every visited file's locals.

### Lead 10 (closed): the compiler callee oracle dropped imported functions

Building the precision oracle exposed a gap in the oracle itself. The
compiler callee path bound an imported call to its import alias and looked
for a definition at the import statement, so every cross-file call to an
imported function was missing from the semantic callee product and from the
self-audit oracle; member calls through typed receivers were unaffected,
which is why the oracle still looked strong on dependency-injected code.
Aliases now resolve to their declarations, and cached compiler callees
carry a new schema.

The compiler also reports, per definition, how many call and render sites
it bound inside the repository, bound to a library or ambient symbol, or
could not bind. A definition with no unbound site has a complete oracle, so
a cheap-only file there is a false positive rather than an unverified
answer, and `self-audit` measures callee and render precision over those
symbols. Vega, 300 samples: callees precision 1.0 and recall 0.989 over
299 compared symbols (87 compared before, no precision claim); renders
precision 1.0 and recall 1.0 over 300; references precision 0.956 and
recall 1.0.

### Lead 7 follow-up: extraction rules from the reviewed sample

Reading twenty sampled regions in Launchpoint source
(`docs/validation/labels/launchpoint-backend/extract-candidates.json`)
showed two false-positive shapes among exclusive regions: regions that hold
`return` statements of the function itself (its branch structure, not a
helper) and blocks of five to seven lines that are a statement or two. A
region now needs eight lines, and a region holding the function's own
returns (a return indented no deeper than the region's shallowest call) is
support tier. A first cut of those rules also lost a labeled true region
whose calls sit inside one fluent query statement, and an attempt to merge
across statements swallowed every rendered subtree inside a `return`; the
rule that survived both is that exclusive call spans merge when no line at
the function's statement indentation separates them, while spans with
rendered members keep the proximity rule. The label set scores precision
1.0 and recall 1.0 against the current output; the Launchpoint full list is
369 signal-tier and 570 support-tier candidates.
