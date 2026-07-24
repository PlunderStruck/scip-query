# Cache retention and write-I/O baseline

Date: 2026-07-24
Version: 0.19.1

This is an observational baseline from the local scip-query cache before the
retention repair. Disk capacity and SSD wear are different measurements:
retained bytes prove a capacity leak, while write volume estimates the storage
traffic that contributes to flash wear.

| Measurement | Value |
| --- | ---: |
| Total scip-query cache | 25,166,700 KiB |
| Per-project caches | 24,508,592 KiB |
| Shared repository cache | 657,524 KiB |
| Vega project cache | 8,488,048 KiB |
| Vega `reindex-*` directories | 88 |
| Vega `reindex-*` directories older than one day | 78 |
| Vega `reindex-*` retained size | 5,241,768 KiB |
| Vega affected-set history | 2,141,266,418 bytes |
| History records | 4,676 |
| Observed history age | 13.86 days |
| Mean full history record | 457,927 bytes |
| Full history append rate | 147.4 MiB/day |
| Latest record at observation | 704,514 bytes |

At the observed 337.4 records/day, writing each full record once to history and
again as latest is approximately 295 MiB/day before filesystem metadata and
index-generation writes. That rate alone does not establish rapid SSD
exhaustion: device endurance, write caching, and the much larger indexing
workload were not measured. It does establish avoidable write amplification.

The abandoned staging directories are stronger evidence of unintended index
traffic but not a valid daily-write estimate: they are partial survivors, not
a counter of all bytes written. This repair therefore makes no unsupported SSD
lifetime claim. It bounds retention, cuts history payload size, and leaves
device-level host-write measurement as a separate diagnostic if needed.
