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
  Both label sets score the signal tier at 0.875 or better; the misses are
  wide-interface regions at support tier (hooks and controllers with many
  locals) and the false rows are fragments of object literals. A unit whose
  calls are separated by unrelated statements is still not found; no
  labeled miss had that shape, so the gap rule stays unbuilt.
- **Label sets cover every health-counted detector on Launchpoint and four
  detectors on Vega 2.0.** Twin drift keeps two Vega false groups that share
  a handler name across controllers of different resources, and similar
  pairs keep four true Launchpoint pairs at signal tier because shared
  domain-noun callees without a behavior verb are scaffolding by the earlier
  calibration. Python, Rust, and the other languages have no label set.
- **`docs/accuracy-audit-checklist.md` still carries the Python-era rows**
  for every detector; only the extraction row notes the rebuild.

## Operational

- **Project-wide semantics need the whole compiler project.** A tsconfig
  larger than the worker heap's file budget is served from file closures:
  callees, coverage, signatures, and import usage stay exact, while
  references and hierarchies are declined per request and answered by the
  cheap paths. On a machine whose heap fits the project nothing changes.
  The self-audit's references question reports the oracle unavailable in
  that mode rather than measuring against a partial scan.
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
