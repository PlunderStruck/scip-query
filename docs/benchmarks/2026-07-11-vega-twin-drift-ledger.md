# VegaAssistant twin-drift optimization ledger

Date: 2026-07-11
Status: Optimization verified

## Output contract

For identical input records and options, `groupTwins` must preserve every
group's representative leaf, relationship, divergence, sorted member list,
and first divergent token run. A speedup that changes those fields is rejected
unless separately justified as an accuracy correction.

## Current pipeline

1. Load callable definitions and apply the same ignored/barrel/callable filters.
2. Cluster definition metadata before source parsing; retain only leaf clusters
   that can occur across files.
3. Build twin records from selected definitions. Source lines are reused from
   the per-file cache, and one masked implementation body feeds normalization,
   tokenization, and thin-forwarder classification.
4. Cluster unique record leaf names by exact case-folding or bounded edit distance.
5. Select members through a leaf-to-record index, preserving source record order.
6. Evaluate cross-file pairs, delegation exclusions, normalized-body equality,
   and token Jaccard similarity.
7. Sort groups and render/aggregate them.

## Measurements

The baseline and subsequent measurements live in
[`2026-07-11-vega-twin-drift.jsonl`](./runs/2026-07-11-vega-twin-drift.jsonl).

| Scenario | Result |
| --- | --- |
| Vega bounded `twin-drift` | 340 ms, 20 groups |
| Vega bounded `health` | 23.48 s, score 55, intentionally capped |
| Vega full `health` durable | no result after 389 s; stalled semantic session |
| Vega full `health` worker | no result after 750 s; `twin-drift` dominated |
| Vega full `twin-drift` after optimization | 440 ms, 374 groups, 19,409 LOC |
| Vega full `health` after optimization (cold) | 12.81 s, score 10, risk 84, hygiene 10 |
| Vega full `health` after optimization (warm evidence cache) | 220 ms, same score |

## Decision log

- Baseline diagnosis: repeated cluster membership scans are the first concrete
  bottleneck.
- Accepted: a leaf-to-record index that preserves original record order when
  assembling a near-name cluster.
- Accepted: run the existing metadata-only candidate filter in full mode before
  source parsing; it cannot remove a group because every group requires a
  cross-file leaf/near-leaf cluster.
- Accepted: reuse cached source lines and mask each selected body once.
- Verification: bounded output is byte-for-byte equivalent before and after;
  full uncapped twin-drift completes in under one second.
