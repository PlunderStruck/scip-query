# Persistent Definition Cache Plan

Date: 2026-06-28

## Goal

Make large-repo health and cleanup commands faster by avoiding repeated
fresh-process reconstruction of source-corrected per-file definition catalogs,
while preserving the exact definition records produced from the SCIP index.

Done means Vega_2.0 health-leading phases keep byte-identical JSON output and
the cache is bypassed whenever source bytes or the project evidence fingerprint
do not match.

## Current State

- `isolated()` loads production callables, then checks cross-file callers,
  framework references, non-self callees, and source fallback before returning
  disconnected leaves. Source: `scip-query plan-context isolated`;
  `scip-query code isolated -C 30`.
- A Vega_2.0 stage probe measured `productionCallableDefinitions()` at 922.3ms
  of the `isolated` path, before `crossFileCallerMap()` at 277.7ms. Source:
  local exported `ProjectIndex` timing probe recorded in this run.
- `getDefinitionsForFile()` currently merges primary and fallback definition
  rows and then calls `correctDefinitionRangesFromSource()` inside only an
  in-process cache. Source: `scip-query trace getDefinitionsForFile`.
- `correctDefinitionRangesFromSource()` reads source facts or source text to
  correct start/end lines. Source:
  `scip-query code correctDefinitionRangesFromSource -C 20`.
- Existing persistent file evidence follows a content-hash read, validate,
  rebuild, write pattern in `loadOrBuildSourceFacts()`. Source:
  `scip-query code loadOrBuildSourceFacts -C 70`.
- `projectEvidenceFingerprint()` hashes the completed index fingerprint and
  indexed language set, so it is the right guard for cache payloads derived
  from index rows. Source: `scip-query trace projectEvidenceFingerprint`.

## Reuse Audit

- Reuse `fileContentHash()`, `readCachedFileEvidence()`, and
  `writeCachedFileEvidence()` instead of adding a new storage table. Source:
  `scip-query trace fileContentHash`;
  `scip-query plan-context readCachedFileEvidence`.
- Reuse the `source-facts` cache flow: deserialize/validate first, rebuild on
  miss or corruption, then write. Source:
  `scip-query code loadOrBuildSourceFacts -C 70`.
- Reuse `projectEvidenceFingerprint()` for index identity instead of inventing
  a definition-row digest in this slice. Source:
  `scip-query trace projectEvidenceFingerprint`.
- `scip-query recent-duplicates --json --full` returned no findings before
  this plan. Source: `scip-query recent-duplicates --json --full`.

## Design

### 1. Add A Definition File-Evidence Kind

- [x] **File**: `src/storage/evidence-cache.ts:26-36`
- **Source**: `scip-query code 'src/storage/evidence-cache.ts:24-60'`.
- **What**: `FileEvidenceKind` lists existing per-file persistent evidence
  kinds such as `source-facts`, `source-reexports`, and
  `source-fingerprints`.
- **Change**: Add `file-definitions` as a file evidence kind.
- **Why**: The definition catalog needs the same persistent storage boundary as
  other content-hash-backed source evidence.

### 2. Cache Source-Corrected Definitions

- [x] **File**: `src/symbols/definition-catalog.ts:69-78`
- **Source**: `scip-query trace getDefinitionsForFile`.
- **What**: `getDefinitionsForFile()` always loads SCIP rows and corrects
  ranges from source on a fresh process.
- **Change**: Read source text and `projectEvidenceFingerprint()`, then attempt
  a `file-definitions` cache read by content hash. Accept only payloads whose
  stored project fingerprint matches the current one and whose definitions
  validate as `IndexedDefinition[]` for the requested file. On miss, run the
  current merge/correction path and write the validated payload.
- **Why**: This removes repeated SQL/AST/source range correction work from
  fresh CLI processes while keeping the existing path authoritative.

### 3. Verify Output And Runtime

- [x] **File**: `tests/symbols/definition-catalog.test.ts`
- **Source**: `scip-query plan-context readCachedFileEvidence` history shows
  cache changes usually co-change with this test.
- **What**: Existing tests cover evidence-cache persistence behavior.
- **Change**: Add or extend a focused definition-cache test if no existing
  definition-catalog test covers cache hit/mismatch rebuild behavior.
- **Why**: The cache must prove it rejects mismatched project fingerprints and
  preserves definition records.

## Stress Test

- The change is reversible: deleting `file-definitions` rows or reverting the
  read/write branch falls back to the current index-derived path.
- Failure mode is conservative: missing evidence DB, corrupt JSON, invalid
  shapes, missing project fingerprint, or mismatched fingerprint all rebuild.
- Concurrency is safe under existing `INSERT OR REPLACE` file-evidence writes;
  two processes writing the same deterministic payload are equivalent.
- Public behavior is protected by Vega byte/hash probes for `isolated`,
  `health`, `wrapper`, `stale`, and `similar --full`, plus repo tests and
  `diff-gate`.

## Execution Order

1. Add the evidence kind and definition-cache serialization helpers.
2. Add focused tests around cache hit and fingerprint mismatch.
3. Build and run Vega first-fill and warm probes; keep only if warm output
   hashes are unchanged and runtime improves.
4. Update `docs/benchmarks/2026-06-28-health-ledger.md` and
   `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`.
