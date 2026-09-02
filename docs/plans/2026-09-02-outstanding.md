# Outstanding after the 2026-09-02 accuracy work

Everything below is open as of the 0.24.0 release. Closed items live in
`docs/plans/2026-09-02-graph-accuracy-investigation.md` and
`docs/validation/2026-09-02-launchpoint-health-calibration.md`.

## Accuracy

- **Self-audit references precision is 0.956 on Vega** (1.0 on Launchpoint).
  The cheap-only references have not been classified; they may be the
  source-attribution path counting type-only or re-export mentions the
  compiler does not. Same method as lead 2: dump the disagreements and read
  each.
- **Callee recall against the compiler is 0.989 on Vega.** The remaining
  oracle-only rows are calls the indexer left unbound and the leaf-name
  fallback could not place. Not yet read individually.
- **Extraction regions are exclusive but coherence is still a judgment.**
  The reviewed Launchpoint sample scores 1.0/1.0, but it is twenty rows.
  Regions that merge through one long statement (a fluent query chain, a
  large literal) are found; a unit that spans several statement-level
  lines with other statements between its calls is not, even when a
  reviewer would still cut there.
- **Label sets exist for three detectors only** (React component
  duplicates, React hook candidates, extraction candidates), all on
  Launchpoint. Wrappers, passthroughs, twins, similar, dead, and cycles have
  the seeded-defect recall gate but no reviewed precision sample.
- **`docs/accuracy-audit-checklist.md` still carries the Python-era rows**
  for every detector; only the extraction row notes the rebuild.

## Operational

- **The semantic service needs a worker heap sized to the project.** The
  service now estimates it from the indexed document count (2.5 GB plus
  1.25 MB per document, at most 60% of machine memory, never below 6 GB).
  On a machine with less memory than a large repository needs, the worker
  still dies at its ceiling and the CLI declines semantic enrichment for the
  run with a stderr notice; there is no smaller-batch retry yet.
- **Full-mode passes disable semantic enrichment after one service
  failure** rather than retrying with a smaller batch. The run completes and
  says so; it does not recover.
- **The health report cache is keyed by CLI version and index fingerprint.**
  A development build deployed under an unchanged version serves the
  previous build's cached report until the cache file is removed.
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
- **Development deployments reuse the release version number.** Evidence
  caches keyed by tool version cannot tell two builds of 0.23.0 apart. A
  build identity in the cache key would remove the manual cache clearing
  this work needed.
