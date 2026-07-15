# Navigation command latency baseline

Date: 2026-07-15
Status: Baseline captured; first optimization pass completed

## Target and output contract

Interactive latency is the elapsed time between invoking a navigation command
and receiving its complete output. It is a user-facing response-time measure:
process startup, freshness checks, database access, semantic work, and rendering
all count because the caller waits for all of them.

This campaign targets `code`, `outline`, and `refs` without changing their
observable results:

- `code` must return the same resolved symbol or direct file range, source text,
  context lines, language, path, and resolution notices.
- `outline` must return the same hierarchy, symbol identities, signatures, and
  line ranges.
- `refs` must return the same deduplicated file-and-line set. Compiler-semantic
  references are part of this contract when the semantic provider is enabled.

A clean worktree is a checked-out repository whose tracked and untracked files
match the committed snapshot. A dirty worktree is one with an added, removed,
or changed file. The distinction matters because shared-generation validation
takes different paths for these two observable repository states.

## Corpus and run history

- Repository: `/Users/aydansalois/Documents/GitHub/scip-query`
- Corpus: 557 source files, 338 indexed files, 23,255 symbols, 16.2 MB SQLite
  index.
- Primary profiled run:
  [`2026-07-15-navigation-latency.jsonl`](./runs/2026-07-15-navigation-latency.jsonl)
- Clean runs:
  [`clean`](./runs/2026-07-15-navigation-latency-clean.jsonl) and
  [`clean repeat`](./runs/2026-07-15-navigation-latency-clean-repeat.jsonl)
- Stable dirty run:
  [`dirty`](./runs/2026-07-15-navigation-latency-dirty-stable.jsonl)
- Shared-cache-disabled comparison:
  [`no shared cache`](./runs/2026-07-15-navigation-latency-no-shared.jsonl)

The benchmark harness starts one fresh CLI process per sample. It deliberately
sets `SCIP_QUERY_SKIP_WATCH_SERVICE=1`, so its `refs` values measure local
TypeScript-provider construction rather than the warmed watch-service path.
Direct warmed commands were timed separately to avoid treating that harness
choice as normal interactive behavior.

## Baseline scoreboard

| Scenario | `code` symbol | `code` range | `outline` small | `outline` large | `refs` function | `refs` class |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Clean benchmark | 688 ms | 565 ms | 604 ms | 604 ms | 1,601 ms | 1,802 ms |
| Stable dirty benchmark | 1,197 ms | 1,068 ms | 1,068 ms | 1,098 ms | 2,149 ms | 2,305 ms |
| Clean, shared cache disabled | 499 ms median | — | — | 443 ms median | 1,387 ms median | — |
| Stable dirty, warmed watch service, direct CLI | 1,420 ms | — | — | 1,260 ms | 1,280 ms | — |

The direct warmed values are one-run wall-clock checks after the semantic
service had created and reused its TypeScript project. The durable benchmark
runs remain the acceptance harness until a watch-cold/watch-warm option is added.

Post-change measurements and output-identity hashes are recorded in the
[`optimization ledger`](./2026-07-15-navigation-latency-ledger.md).

## Profile findings

Source-mapped Node CPU profiles make the dominant costs concrete:

1. In a dirty worktree, `prepareWorktreeIndex` computes the full project-input
   fingerprint in `getIndexFreshness`, then computes the same fingerprint again
   in `publishFreshLocalGenerationForProject`. The second pass occurs before
   `buildSharedGenerationSnapshot` rejects the dirty worktree. The two passes
   together accounted for about 500 ms of file reads and SHA-256 work in the
   sampled `code` run.
2. Clean commands repeatedly call `resolveGitWorktreeContext` from lease
   validation, repository-cache sweeping, shared-evidence database resolution,
   and watch-service startup. Each resolution launches several synchronous Git
   subprocesses. Three visible call sites accounted for roughly 160-200 ms of
   self time in clean `code`/`outline` profiles.
3. `code` and `refs` resolve the same symbol once for the query and again for
   resolution notices or JSON metadata. The two fuzzy lookups accounted for
   about 56-60 ms in the sampled `code` run.
4. `outline`'s geometric containment fallback is quadratic in definitions per
   file, but the 165-definition large input was no slower than the small input.
   It is not a current latency bottleneck.
5. With the watch service disabled, each `refs` process constructs a TypeScript
   project. Profiled repeats spent 893-928 ms in TypeScript work, including
   523-552 ms mapping references and 370-375 ms loading the provider and project.
   With the service warm, `refs` falls back to the same startup/freshness floor
   as `code` and `outline`.

## Accuracy probe for a SCIP-first `refs`

A SCIP reference chunk is the compiler-indexed set of symbol occurrences stored
with the SCIP document. It is faster to query than starting a live TypeScript
analysis, but it is not yet a complete substitute on this corpus.

| Symbol | Semantic rows | SCIP rows | Difference | SCIP query time |
| --- | ---: | ---: | --- | ---: |
| `findFirstSymbolMatch` | 41 | 41 | identical | 3.5 ms |
| `resolveGitWorktreeContext` | 13 | 13 | identical | 1.5 ms |
| `ScipDatabase` | 949 | 948 | SCIP missed one constructor use | 23.6 ms |
| `outline` | 2 | 1 | SCIP missed one property-access call | 0.1 ms |

Switching `refs` to SCIP-only lookup is therefore rejected: it is fast, but it
violates the current completeness contract. The viable version of this idea is
to materialize or cache the missing semantic references against the published
index generation.

## Initial performance targets

These are hypotheses to test, not claims of achieved performance:

- clean `code`/`outline`: at most 250 ms median;
- stable dirty `code`/`outline`: at most 450 ms median;
- warmed `refs`: at most 350 ms median;
- cold `refs`: at most 1.2 s median;
- byte-identical stdout and equal structured row hashes for every accepted
  change.
