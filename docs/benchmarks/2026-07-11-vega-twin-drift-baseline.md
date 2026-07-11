# VegaAssistant twin-drift performance baseline

Date: 2026-07-11
Status: Optimization verified; keep as the campaign record

## Target

`twin-drift` groups same or near-same callable names across files and compares
their normalized bodies. Its result must remain identical for the same index,
options, and source: group identity, relationship, members, divergence, and
the first divergent token run are all output contract.

The target was selected because `health --full` on the current 765-file,
48,192-symbol VegaAssistant index could not finish: the isolated `twin-drift`
phase used a CPU core for more than 12 minutes. The ordinary bounded command
finished in 340 ms with 20 returned groups, while bounded health finished in
23.48 s with score 55 and explicitly capped candidate scans.

## Corpus and run history

- Repository: `/Users/aydansalois/Documents/GitHub/VegaAssistant`
- Index: 20,989 callable definitions, 17,364 distinct leaf names, and 1,041
  leaf names represented by more than one callable.
- Run history:
  [`2026-07-11-vega-twin-drift.jsonl`](./runs/2026-07-11-vega-twin-drift.jsonl).
- Full durable run: aborted after 389 s with no JSON when its Rust semantic
  session stopped responding.
- Full worker fallback: aborted after 750 s with `twin-drift` consuming a CPU
  core; no JSON was emitted.
- Full uncapped twin-drift after optimization: 440 ms, 374 groups, 19,409 LOC.
- Full uncapped health after optimization: 12.81 s, score 10, risk 84,
  hygiene 10. A warm evidence-cache run is 220 ms with the same result.

## Hypothesis

The original full path rebuilt the member list by scanning every record for
every leaf-name cluster. The optimization now indexes records by leaf once and
reconstructs near-name members in original order. It also applies the existing
metadata-only candidate filter before reading/snippet-normalizing source, even
in full mode: only definitions whose leaf cluster can occur across files are
parsed. Source snippets reuse the per-file line cache, and each selected
definition performs one comment/string mask that feeds normalization, tokens,
and thin-forwarder classification.

The bounded result was compared before and after the changes and is byte-for-byte
equivalent. The full path now uses the same detector rules, but its work is
limited to the 1,684 metadata candidates that can participate in a cross-file
twin cluster (1,612 records after source filtering).
