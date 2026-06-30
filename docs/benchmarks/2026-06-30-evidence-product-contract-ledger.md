# Evidence Product Performance Contract Ledger

Date: 2026-06-30

## Output Contract

The file evidence product migration must preserve command output while keeping
warm evidence-cache paths faster than cold evidence-fill paths. A cold-fill run
starts after deleting the rebuildable `evidence.db` files. A warm-hit run starts
after the cold-fill pass has repopulated the cache. Output identity is tracked
with the SHA-256 hash of stdout for each command.

## Target Selection

The target is the migrated file evidence product layer in
`src/storage/evidence-products.ts`. `createFileEvidenceProduct()` is now used by
source facts, React profiles, source imports, source re-exports, file
definitions, definition exclusions, git file-adds, source fingerprints,
consumer file usage, and doc path evidence.

Source: `node dist/cli.js trace createFileEvidenceProduct`

## Measurement Harness

Run:

```bash
npm run bench:evidence-products
```

The harness is `scripts/evidence-product-contract.mjs`. It resolves the active
SCIP index with `status --json`, deletes only `evidence.db`, `evidence.db-wal`,
and `evidence.db-shm` for cold-fill, then runs the command matrix once cold and
twice warm.

Run history:

- `docs/benchmarks/runs/2026-06-30-evidence-products.jsonl`
- `docs/benchmarks/runs/2026-06-30-evidence-products.profile.jsonl`

## Command Matrix

- `scip-query dead --json`
- `scip-query doc-drift --json`
- `scip-query recent-duplicates --json`
- `scip-query similar --json --full`
- `scip-query health --json --full`

These commands cover the products that matter for the migration: source facts,
definition exclusions, file definitions, source imports/re-exports, consumer
file usage, source fingerprints, git file-add evidence, React behavior profiles,
and doc path evidence.

## Baseline Run

Run id: `2026-06-30T18:23:58.496Z`

| Command                    | Cold-fill | Warm-hit avg | Warm delta | Output hash stable |
| -------------------------- | --------: | -----------: | ---------: | ------------------ |
| `dead --json`              |   4018 ms |       527 ms | 87% faster | yes                |
| `doc-drift --json`         |    260 ms |       207 ms | 20% faster | yes                |
| `recent-duplicates --json` |    302 ms |       274 ms |  9% faster | yes                |
| `similar --json --full`    |    247 ms |       248 ms |         0% | yes                |
| `health --json --full`     |   1638 ms |       820 ms | 50% faster | yes                |

Evidence DB size after warm runs: `7954432` bytes.

## Interpretation

The cold-to-warm contrast is strongest where evidence fill is dominant:
`dead --json` and `health --json --full`. `similar --json --full` is already
fast on this repo and does not show a meaningful warm delta in this run, but its
stdout hash stayed stable and the source-fingerprint product path is covered by
the run history.

This baseline accepts the migration as preserving output identity while keeping
warm cache behavior intact. Future evidence-product work should rerun this
contract and compare against the JSONL history rather than relying on a single
wall-clock anecdote.

## Verification

- `npm run bench:evidence-products`: passed, 15 command runs, 0 failures.
- Every cold/warm command pair had stable stdout hashes.
