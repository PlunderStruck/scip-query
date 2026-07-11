# TypeScript Factual Evidence Renewal

Date: 2026-07-11
Status: Six low-population detector verdicts renewed; all remain insufficiently evidenced

## Result

The remaining low-population TypeScript factual families were rerun uncapped on
four pinned repositories. All 25 emitted rows were reviewed and valid, but no
family met the repository-breadth and sample-size gates required for
certification. These are terminal evidence verdicts for the present corpus, not
claims that the commands are inaccurate.

| Detector              | Uncapped rows | Valid | Repositories with rows | Known-positive fixtures | Verdict      |
| --------------------- | ------------: | ----: | ---------------------: | ----------------------: | ------------ |
| `unused-params`       |             5 |   5/5 |                      1 |                       1 | insufficient |
| `cycles`              |             3 |   3/3 |                      1 |                       1 | insufficient |
| `isolated`            |             3 |   3/3 |                      2 |                       1 | insufficient |
| `not-implemented`     |             0 |     — |                      0 |                       1 | insufficient |
| `decorative-checkers` |             0 |     — |                      0 |                       1 | insufficient |
| `test-quality`        |            14 | 14/14 |                      2 |                       3 | insufficient |

## Corpus

- Vega_2.0 `6d8a9d552716946405cf940440cf31d0cbd7205f`
- openwork `1bc2b18ef426c4751a6d8c16fbbf8023f5da9f6e`
- Stable_Management `bd221c3fa61034b4e52734f15ce6ef0b285ec78e`
- traceroot `c41ac2bb3801fc2ce882ea3bacba9b0c4c5afeb9`

Each run used a detached worktree, unique temporary cache, forced TypeScript
reindex, uncapped candidate frame, and deterministic seed
`typescript-factual-expansion-v1`.

Raw generated packet:
`reports/accuracy/2026-07-11T16-00-12-326Z-typescript-factual-calibration.json`.
Reviewed generated packet:
`reports/accuracy/2026-07-11T16-04-27-218Z-typescript-typescript-factual-reviewed.json`.
Both are intentionally ignored artifacts; the committed verdict input is
[`2026-07-11-typescript-factual-expansion-verdicts.json`](./2026-07-11-typescript-factual-expansion-verdicts.json).

## Review Findings

Twenty-one rows reproduced already reviewed calibration identities. The four
new rows were `test-quality` mock-echo facts in Vega. Each correctly identified
a literal supplied by a mock and later asserted, while the containing test also
checked routing, call arguments, headers, or response structure. The narrow
echo fact is valid; treating the whole test as low quality without considering
those additional assertions would be an invalid recommendation.

No new false-positive archetype or production correction was found. The two
zero-population commands retain known-positive fixtures, so their zero real
rows mean “no current precision population,” not “the detector cannot fire.”

## Closure Decision

These six rows no longer require repeated runs against the same corpus. Renew
them only when a named new repository or historical revision contains a larger
natural population. Until then, public output must retain their
`insufficient` state and must not promote them to certified actionable facts.
