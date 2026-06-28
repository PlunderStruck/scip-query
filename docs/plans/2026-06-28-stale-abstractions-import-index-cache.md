# stale-abstractions import-index cache plan - 2026-06-28

## Goal

Reduce Vega_2.0 `scip-query stale-abstractions --json --full` runtime without
changing findings. Done means the command keeps the same stdout byte count and
SHA-256 while the focused benchmark drops from the fresh 43.268s measurement.

## Current State

- `staleAbstractions` builds type candidates, prepares consumer evidence, then
  scores every candidate before applying the final result limit.
  Source: `scip-query plan-context staleAbstractions`;
  `scip-query code staleAbstractions -C 12`.
- The expensive preparation path calls
  `consumerMapForPossiblyStaleTypeCandidates`, which first builds indexed
  caller evidence, then semantic evidence for possible rows, then source
  fallback for candidates still showing at most one real consumer.
  Source: `scip-query code consumerMapForPossiblyStaleTypeCandidates -C 12`.
- Source fallback ultimately calls `findCallerFiles`, which walks source files,
  then calls `attributeIdentifier(db, file, name)` for candidate-name hits.
  Source: `scip-query trace findCallerFiles`;
  `scip-query code findCallerFiles -C 12`.
- `attributeIdentifier` rebuilds the per-file import-name map through
  `sourceImportPathsByLocalName` when a leaf is ambiguous.
  Source: `scip-query code attributeIdentifier -C 8`;
  `scip-query code sourceImportPathsByLocalName -C 8`.

## Reuse Audit

- Reuse `createPerDbCache`, the existing per-database cache primitive used for
  source-file-scoped derived data.
  Source: `scip-query surface src/storage/per-db-cache.ts`.
- Reuse `normalizeRelativePath` for the cache key so source-file invalidation
  and lookup use the same path form.
  Source: `scip-query code pathsResolveSame -C 8`.
- Keep `getSourceImports` as the underlying import parser/cache; only cache the
  derived local-name index.
  Source: `scip-query code getSourceImports -C 8`.

## Design

### 1.1 - Cache per-file import local-name maps

- [ ] **File**: `src/language-parsers/import-index.ts:1-32`
- **Source**: `scip-query plan-context sourceImportPathsByLocalName`.
- **What**: `sourceImportPathsByLocalName` rebuilds a `Map<string,
Set<string>>` from cached source imports on every call.
- **Change**: Add a `createPerDbCache<string, Map<string, Set<string>>>`
  keyed by normalized relative path with `whole-project` and `source-file`
  clear groups; move the existing map build into an uncached helper.
- **Why**: Stale/source fallback can ask for the same file import map many
  times while attributing candidate names; rebuilding that map is pure repeated
  work.

## Verification

- `npx vitest run tests/symbols/identifier-attribution.test.ts
tests/queries/cleanup/stale-abstractions-accuracy.test.ts`
- `npm run typecheck`
- `npm run build`
- Vega output identity:
  `/opt/homebrew/bin/scip-query stale-abstractions --json --full` versus local
  `node dist/cli.js stale-abstractions --json --full`.
- Vega runtime:
  `node dist/cli.js bench --json --command "stale-abstractions --json --full"
--timeout-ms 600000`.
- `scip-query status --capabilities`
- `scip-query diff-gate --json`
