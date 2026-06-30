# Evidence Product Performance Contract Plan

Date: 2026-06-30

## Goal

Add a repeatable performance contract for the file evidence product migration.

A performance contract is a benchmark harness and run history that records the observable timing and output shape of important commands in known cache states. Here the real-world thing being measured is `evidence.db`: a rebuildable SQLite cache that stores derived source and symbol evidence. The contract should prove that cold evidence fill still works, warm evidence hits remain fast, and future changes have a durable comparison point.

## Evidence

Source: `node dist/cli.js status --capabilities`

- The index is fresh.
- TypeScript semantic provider, cleanup detectors, compiler verification, and diff gate are available.

Source: `node dist/cli.js trace createFileEvidenceProduct`

- `src/storage/evidence-products.ts:20-36` defines `createFileEvidenceProduct`.
- Production users now include source facts, React profiles, source imports, source re-exports, file definitions, definition exclusions, git file-adds, source fingerprints, consumer file usage, and doc path evidence.

Source: `node dist/cli.js code handleBench -C 8`

- `src/runtime/commands/command-handlers.ts:281-338` already implements `bench`, including JSON output, progress, profile options, and profile event writing.

Source: `node dist/cli.js code runBenchCommand -C 8`

- `src/runtime/commands/command-handlers.ts:448-503` times subprocess command runs, records stdout/stderr byte counts, and writes profile events.

Source: `node dist/cli.js code benchProfileEnv -C 8`

- `src/runtime/commands/command-handlers.ts:509-516` enables profiling through `SCIP_QUERY_PROFILE`, `SCIP_QUERY_PROFILE_COMMAND`, and `SCIP_QUERY_PROFILE_OUT`.

Source: `node dist/cli.js code EVIDENCE_DB_FILENAME -C 4`

- `src/storage/evidence-cache.ts:24` defines the persistent evidence filename as `evidence.db`.

## Implementation

### 1. Add a Focused Contract Runner

File: `scripts/evidence-product-contract.mjs`

Source:

- `node dist/cli.js code EVIDENCE_DB_FILENAME -C 4`
- `node dist/cli.js code runBenchCommand -C 8`

Change:

- Resolve the active SCIP DB path from `node dist/cli.js status --json`.
- Clear only `evidence.db`, `evidence.db-wal`, and `evidence.db-shm` for the cold-fill phase.
- Run this representative command matrix:
  - `dead --json`
  - `doc-drift --json`
  - `recent-duplicates --json`
  - `similar --json --full`
  - `health --json --full`
- Run one cold-fill pass and two warm-hit passes by default.
- Append one JSONL record per command run to `docs/benchmarks/runs/YYYY-MM-DD-evidence-products.jsonl`.
- Include timestamp, phase, iteration, command, duration, exit status, output hash, stdout/stderr byte counts, and evidence DB size.

Why:

- This gives the migrated file evidence products a durable baseline without changing the CLI's public benchmark command.

### 2. Add an npm Script

File: `package.json`

Source:

- `node dist/cli.js code handleBench -C 8`

Change:

- Add `bench:evidence-products` to run the focused contract script.

Why:

- The contract must be easy to rerun during future optimization work.

### 3. Add the Ledger

File: `docs/benchmarks/2026-06-30-evidence-product-contract-ledger.md`

Source:

- `node dist/cli.js trace createFileEvidenceProduct`
- `node dist/cli.js code handleBench -C 8`
- `node dist/cli.js code benchProfileEnv -C 8`

Change:

- Document the output contract, command matrix, run-history path, cache states, and accepted interpretation of cold-fill versus warm-hit numbers.

Why:

- The structured JSONL is the source of truth, but humans need the contract and interpretation in one place.

## Stress Test

1. Understand before touch: this does not change cache behavior; it measures the existing evidence-product users.
2. Blast radius: public benchmark/profile code is reused, not modified.
3. Valid intermediate state: adding the script alone has no runtime effect.
4. Reversibility: deleting the script and ledger restores the prior state.
5. Failure behavior: command failures are recorded as JSONL records and make the script exit non-zero.
6. Concurrency: the runner clears `evidence.db`; it is intended for local benchmark runs, not concurrent production use.
7. Boundary: CLI inputs are only local script flags.
8. Data integrity: only rebuildable evidence cache files are removed.
9. Observability: every command run records timing, status, bytes, hash, and evidence DB size.
10. Human: one npm script makes the contract easy to rerun.
11. Reuse: existing `bench`/profile conventions are reused; no new profiler is introduced.

## Verification

- `npm run bench:evidence-products`
- `npm run typecheck`
- `npm test -- tests/storage/evidence-cache.test.ts tests/queries/cleanup/source-fingerprint-cache.test.ts tests/analysis/git-history.test.ts`
- `node dist/cli.js recent-duplicates`
- `node dist/cli.js incomplete-migration`
- `node dist/cli.js wrapper-candidates`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`
