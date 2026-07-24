# Reindex frequency and cache baseline

Date: 2026-07-24
Scale: campaign
Machine: local macOS development workstation

## User-visible workload

The observed workload is normal `scip-query` command use with the daemon watcher enabled. A watcher refresh is a reindex attempt started after a source, Git, startup, or on-demand freshness trigger.

## Historical Vega observation

Before the 0.19.2 cache-retention repair, Vega's affected-set history contained 4,676 records across 13.86 days:

- 337.4 recorded reindex outcomes per day
- 2.14 GB of affected-set history
- approximately 457,927 bytes per legacy history record
- approximately 0.3–0.4 GiB/day of telemetry writes

The prior history did not retain trigger provenance, so it cannot distinguish watcher, manual, startup, and command-demand refreshes. This is why durable trigger-aware activity measurement is required.

## Global cache inventory

Read-only scan before this campaign:

- total cache: 18,059,676 KiB
- project caches: 16,885,116 KiB
- repository caches: 1,170,300 KiB
- project-cache directories: 1,616
- project caches referenced by repository leases: 10
- project-cache directories with no current lease: 1,606
- abandoned `reindex-*` directories: 3, totaling 430,924,305 bytes
- oversized legacy `affected-shadow.jsonl` files: 2, totaling 38,142,850 bytes

The three abandoned workspaces were:

- `projects/2989ab1122bd/reindex-kIpwtE` — 255,436 KiB
- `projects/5efb54c8ea25/reindex-PRj7kv` — 73,740 KiB
- `projects/8a41cfa454b3/reindex-haym8W` — 96,320 KiB

No `index.lock` was present in those three project caches. Their last metadata updates were on 2026-07-13.

## Trigger behavior baseline

`Watcher.triggerReindex` launches a cooldown rerun whenever `dirty` became true during an active reindex. It does not consult the freshness observation already made by the daemon completion callback. Therefore this constructed workload produces two child reindex processes:

1. source event starts reindex A;
2. a delayed event for content already included by A arrives during A;
3. A completes with a fresh index;
4. cooldown expires;
5. reindex B runs and normally reports `reused`.

The benchmark target is one child reindex plus one recorded suppression for that workload, while a genuinely stale completion must still produce two children.

## Metrics

Primary:

- refresh runs per rolling 24 hours
- rebuilt, reused, and failed runs
- freshness-proven refreshes suppressed
- estimated logical output bytes from rebuilt runs

Guardrails:

- no stale change is lost
- telemetry stays within two bounded segments
- reindex result is unaffected by telemetry write failures
- cache cleanup never touches active caches or project source
