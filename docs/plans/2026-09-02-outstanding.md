# Outstanding after the 2026-09-02 accuracy work

Everything below is open as of the 0.24.0 release. Closed items live in
`docs/plans/2026-09-02-graph-accuracy-investigation.md` and
`docs/validation/2026-09-02-launchpoint-health-calibration.md`.

## Accuracy

- **Self-audit precision is measured per compiler project.** A reference
  or callee in a file outside the definition's tsconfig is reported as
  outside oracle coverage and not counted. Under that rule Vega measures
  references 1.0 / 1.0 and callees 1.0 / 0.967 over 60 samples; the one
  oracle-only callee edge (`search()` into `apps/web/src/api/client.ts`)
  is a genuine cheap-path miss to look at, not a measurement artifact.
- **Callee recall against the compiler is 0.989 on Vega.** The remaining
  oracle-only rows are calls the indexer left unbound and the leaf-name
  fallback could not place. Not yet read individually.
- **Extraction regions are exclusive but coherence is still a judgment.**
  The reviewed Launchpoint sample scores 1.0/1.0, but it is twenty rows.
  Regions that merge through one long statement (a fluent query chain, a
  large literal) are found; a unit that spans several statement-level
  lines with other statements between its calls is not, even when a
  reviewer would still cut there.
- **Label sets exist for six detectors** (React component duplicates,
  hook candidates, extraction, wrappers, passthroughs, twin drift), all on
  Launchpoint. Twin drift keeps four convention-name groups (`printReport`
  across scripts, `emptyCounts`, `sumOf`, per-logger `nextTraceFields`)
  whose similarity is structural; an identifier-weighted similarity would
  separate them but also drops two true groups in the sample, so it needs a
  second repository's labels before changing. The other detectors have no
  label set and no second repository.
- **`docs/accuracy-audit-checklist.md` still carries the Python-era rows**
  for every detector; only the extraction row notes the rebuild.

## Operational

- **Semantic memory is bounded by the largest compiler project, not by the
  repository.** Compiler projects load one at a time and the worker retires
  under memory pressure, so a monorepo of many tsconfigs fits where its sum
  did not. A single tsconfig whose program exceeds the worker heap (a
  7,000-file root project on a 3 GB worker) still cannot be served; the run
  then completes without semantic enrichment and says so on stderr. The
  heap estimate respects the cgroup limit inside containers.
- **The 732-file symbol-reference cycle component on Launchpoint** is
  classified module-hierarchy because its witness passes through barrels
  and tests. On the imports-only basis it shrinks to 57 files with no cycle
  after removing barrels and tests, so the dismissal is right, but the
  classification is by witness path rather than by component content.
- **Launchpoint's checked-in `docs/scip-query/health-full-report.md`** was
  produced by the pre-calibration build. It lives in another team's working
  tree and was left alone.

## Process

- **The VM checkout moves.** Another agent edits and switches branches in
  `~/projects/launchpoint-backend`; the `Input:` line in health reports now
  names the generation and commit, and comparisons should quote it.
- **Development deployments reuse the release version number.** The health
  report cache now keys on a build digest; the per-file evidence products
  still key on payload versions and content hashes, which is correct for
  them but means a dev build with changed detector logic and an unchanged
  payload version reuses cached product rows.
