# Cache retention and write-I/O ledger

Date: 2026-07-24
Status: Complete

## Contract

- The complete latest affected-set record remains version 1 and status-readable.
- History retains longitudinal outcome, ratio, count, and reason evidence.
- History retains at most an 8 MiB current segment and one previous segment,
  apart from a single oversized summary.
- A reindex prunes only pre-existing real `reindex-*` directories while holding
  the exclusive reindex lock.
- Cleanup and telemetry remain observational: neither can change publication.

## Baseline

See [the measured baseline](./2026-07-24-cache-retention-io-baseline.md) and the
machine-readable run record in
`runs/2026-07-24-cache-retention-io.jsonl`.

## Results

The representative Vega latest record was 705,617 bytes. Projecting that same
record through the compact-history schema produced a 328-byte JSONL row. At the
observed 337.4 records/day, estimated history appends fall from 147.35 MiB/day
to 0.11 MiB/day, a 99.93% payload reduction. The complete latest file is still
written, so this does not claim that total reindex I/O fell by the same amount.

| Check | Result |
| --- | --- |
| Compact record preserves status, ratios, counts, and reasons | passed |
| Current history rotates without segment rewrite | passed |
| Oversized legacy history is reclaimed on first append | passed |
| Previous archive is bounded to one segment | passed |
| Real stale `reindex-*` directory is removed | passed |
| Prefixed file and symlink are preserved | passed |
| Unrelated cache directory is preserved | passed |
| Focused tests | 52 passed |
| Full test suite | 1,424 passed in 201 files |
| TypeScript typecheck | passed |
| Build | passed |
| Format check | passed |

The retention ceiling is approximately 16 MiB of history per active project
instead of unbounded growth. Abandoned staging capacity is reclaimed on the
next reindex after the interrupted owner releases or loses the lock.

## Live cleanup

After installing the packaged 0.19.2 CLI, a lock-guarded Vega reindex reused
the existing generation in 272 ms while applying cleanup. The project cache
fell from 8,488,048 KiB to 923,576 KiB, reclaiming 7,564,472 KiB (7.21 GiB).
All 88 abandoned `reindex-*` directories were removed. The 2.14 GB legacy
history became four compact rows totaling 1,328 bytes; no archive was retained.

Across the full user cache, retained size fell from 25,166,700 KiB to
17,569,388 KiB, reclaiming 7,597,312 KiB (7.25 GiB).
