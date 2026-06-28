# Diff Gate Hyper Optimization Ledger

Date: 2026-06-28

## Target

`diff-gate --json` on `/Users/aydansalois/Documents/GitHub/Vega_2.0`.

The output contract is unchanged JSON findings and exit code. Vega currently
exits 1 because `doc-reference` findings are present.

## Baseline Measurements

Full heavy cold matrix:

- Result JSON: `/tmp/vega-heavy-cold-20260628-125130.json`
- Profile JSONL: `/tmp/vega-heavy-cold-20260628-125130.jsonl`
- `diff-gate --json`: 23.027s, exit 1, 19,708 stdout bytes.

Targeted cold index:

- Result JSON: `/tmp/vega-diffgate-cold-20260628-130239.json`
- Profile JSONL: `/tmp/vega-diffgate-cold-20260628-130239.jsonl`
- Cold index: 39.422s.
- Warm index check: 1.651s.
- `diff-gate --json`: 25.316s, exit 1, 19,708 stdout bytes.

Direct cold-like cache clear:

- Output JSON: `/tmp/vega-diffgate-direct-profile-20260628-130927.json`
- Profile JSONL: `/tmp/vega-diffgate-direct-profile-20260628-130927.jsonl`
- Cleared `file_evidence`, `semantic_callees`, and `semantic_references`.
- `diff-gate --json`: 22.119s, exit 1, 19,708 stdout bytes.
- Existing profile emitted only one non-useful `semantic.references.cache-scan`
  span, so check-level instrumentation is required.

## Cache Ablation

| Case                                               | Duration | Exit | stdout bytes | File evidence rows                                                                                 |
| -------------------------------------------------- | -------: | ---: | -----------: | -------------------------------------------------------------------------------------------------- |
| full                                               |  22.487s |    1 |       19,708 | `doc-path-evidence:11290`, `file-definitions:1779`, `source-facts:1779`, `source-fingerprints:864` |
| skip doc-reference                                 |  13.828s |    0 |        1,009 | `file-definitions:1779`, `source-facts:1779`, `source-fingerprints:864`                            |
| only doc-reference                                 |   3.217s |    1 |       20,163 | `doc-path-evidence:11290`, `file-definitions:7`, `source-facts:7`                                  |
| skip echo                                          |  22.336s |    1 |       19,797 | `doc-path-evidence:11290`, `file-definitions:1779`, `source-facts:1779`                            |
| skip incomplete-migration                          |  23.089s |    1 |       19,813 | `doc-path-evidence:11290`, `file-definitions:1779`, `source-facts:1779`, `source-fingerprints:864` |
| only echo                                          |  13.553s |    0 |        1,375 | `file-definitions:1779`, `source-facts:1779`, `source-fingerprints:864`                            |
| only incomplete-migration                          |  13.280s |    0 |        1,359 | `file-definitions:1779`, `source-facts:1779`                                                       |
| no echo, no incomplete-migration                   |   3.488s |    1 |       19,894 | `doc-path-evidence:11290`, `file-definitions:7`, `source-facts:7`                                  |
| no echo, no incomplete-migration, no doc-reference |   0.717s |    0 |        1,187 | `file-definitions:7`, `source-facts:7`                                                             |

## Hypotheses

1. `newCallablesInDiff()` can use the existing `files` option on
   `productionCallableDefinitions()` and avoid whole-project helper discovery.
2. Check-level profile spans are necessary before deeper `similar` or
   doc-reference changes.
3. `doc-reference` is a real but secondary cold bucket; optimize it only after
   the source evidence bucket is reduced.
4. Diff-gate echo source fallback can avoid whole-project source fingerprints
   by applying the exact similarity lower bound before candidate definition
   loading: a source-token candidate cannot reach `minSimilarity` unless it
   shares at least `ceil(targetTokenCount * minSimilarity)` target tokens.

## Accepted Measurements

All runs below used the local built CLI against
`/Users/aydansalois/Documents/GitHub/Vega_2.0`, cleared `file_evidence`,
`semantic_callees`, and `semantic_references`, and compared stdout to
`/tmp/vega-diffgate-direct-profile-20260628-130927.json`.

| Run                                      | Duration | Exit | stdout bytes | Output SHA | File evidence rows                                                                                 |
| ---------------------------------------- | -------: | ---: | -----------: | ---------- | -------------------------------------------------------------------------------------------------- |
| Baseline direct cold-like                |  22.119s |    1 |       19,708 | `8cb4481`  | `doc-path-evidence:11290`, `file-definitions:1779`, `source-facts:1779`, `source-fingerprints:864` |
| Scoped incomplete + doc candidate filter |  15.690s |    1 |       19,708 | same       | `doc-path-evidence:8`, `file-definitions:1779`, `source-facts:1779`, `source-fingerprints:864`     |
| Final accepted source-bound echo pass    |   3.046s |    1 |       19,708 | same       | `doc-path-evidence:8`, `file-definitions:9`, `source-facts:9`, `source-fingerprints:3`             |

Final accepted profile:

- Output JSON: `/tmp/vega-diffgate-after-echo-threshold-20260628203105.json`
- Profile JSONL:
  `/tmp/vega-diffgate-after-echo-threshold-20260628203105.jsonl`
- SHA-256:
  `8cb44814e1c5ab700c1caef3b8c8667ee6cb11b939ac7d2d20315c41d9f64d5e`
- Baseline match: byte-identical.

Final top spans:

| Span                                      | Duration | Notes                                                                        |
| ----------------------------------------- | -------: | ---------------------------------------------------------------------------- |
| `diff-gate.check.doc-reference`           |   1.351s | 7 findings; 8 docs reached exact path evidence after 11,282 candidate misses |
| `doc-reference.docs-citing-files`         |   1.349s | 11,290 living docs scanned; only docs with target path candidates are cached |
| `diff-gate.check.echo`                    |   0.762s | no findings; source fallback no longer builds whole-project fingerprints     |
| `similar.source-shape`                    |   0.478s | `ActiveNavIndicator`, 30 target tokens, 31 candidates, 0 results             |
| `similar.source-shape.target-files`       |   0.448s | required shared tokens 24; 1,779 files scanned; 3 candidate files            |
| `diff-gate.check.co-change-partner`       |   0.341s | no findings                                                                  |
| `similar.source-shape.target-definitions` |   0.026s | 34 candidate definitions                                                     |

## Rejected / Superseded Measurements

- A weak source prefilter requiring only two shared target tokens preserved the
  Vega output but did not materially improve runtime: 15.652s with 1,680
  candidate files and 2,500 candidate definitions. It is superseded by the
  similarity-bound threshold because the latter is still an exact necessary
  condition and reduced candidate files to 3 on the same target.

## Decisions

- Keep check-level `diff-gate.check.*` spans. They are disabled unless
  `SCIP_QUERY_PROFILE` is enabled and are the evidence that found echo and
  doc-reference as separate bottlenecks.
- Keep changed-file scoping in `newCallablesInDiff()`. It preserves the helper
  predicate but stops changed-file-only checks from loading whole-project
  production callables.
- Keep the doc-reference path-candidate prefilter. It changed persistent
  evidence writes from every living doc to only the 8 docs containing target
  path candidates while preserving output.
- Keep target-pruned source fallback only for diff-gate echo. The normal
  `similar` command keeps its existing full source index behavior; the gate
  path applies a mathematically necessary similarity bound before exact
  fingerprint extraction.

## Remaining Bottlenecks

The remaining cold-like direct Vega `diff-gate --json` path is now mostly:

1. `doc-reference` scanning 11,290 living docs for 7 changed files: 1.35s.
2. `echo` scanning indexed source text for a high-similarity lower bound:
   0.76s.
3. `co-change-partner`: 0.34s.

The next meaningful diff-gate pass should target doc-reference only if a
repeatable exact index can avoid reading every living doc without losing short
path and suffix citations.
