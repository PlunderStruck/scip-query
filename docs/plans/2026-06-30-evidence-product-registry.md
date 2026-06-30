# Evidence Product Registry Plan

Date: 2026-06-30

## Goal

Make persistent evidence caching an architectural optimization instead of a set of one-off optimizations.

An evidence product is a named persistent result, such as source facts or file definitions, stored for one source file and made valid by the file's content hash plus any product-specific guards. The important thing is that the product owns the payload shape and validation rules while the storage layer owns SQLite access.

The first implementation should add a typed file evidence product layer, convert the highest-signal existing file-scoped products, and preserve the current optimization behavior: same `evidence.db` schema, same content-hash invalidation, same in-process cache boundaries, and same public query behavior.

## Current State

Source: `node dist/cli.js status --capabilities`

- SCIP index is fresh for this repo.
- TypeScript semantic provider is available.
- Diff gate, cleanup detectors, and compiler cleanup verification are available.

Source: `node dist/cli.js plan-context src/storage/evidence-cache.ts`

- `src/storage/evidence-cache.ts` is a high-risk storage module: 12 module consumers and 48 external consumers.
- `readCachedFileEvidence` and `writeCachedFileEvidence` each have 9 direct consumers.
- The file usually co-changes with benchmark docs and `tests/storage/evidence-cache.test.ts`, so storage behavior needs direct tests and benchmark-aware validation.

Source: `node dist/cli.js code 'src/storage/evidence-cache.ts:24-40'`

- `FileEvidenceKind` already names the persistent file evidence products: `source-facts`, `file-definitions`, `definition-exclusions`, `doc-path-tokens`, `doc-path-evidence`, `source-imports`, `source-reexports`, `source-fingerprints`, `consumer-file-usage`, `react-component-behavior-profiles`, and `git-file-adds`.

Source: `node dist/cli.js code connectionFor -C 8`

- `evidence.db` has a `file_evidence` table keyed by `(kind, relative_path)` with `content_hash`, `version`, and string `payload`.
- It also has separate semantic tables keyed by symbol plus dependency or project fingerprint. Those are not the first target because they are not file-product shaped.

Source: `node dist/cli.js code readCachedFileEvidence -C 8`

- `readCachedFileEvidence` is the raw file evidence read primitive. It handles DB availability, current and legacy version reads, error disabling, and returns a string payload or `null`.

Source: `node dist/cli.js code writeCachedFileEvidence -C 8`

- `writeCachedFileEvidence` is the raw file evidence write primitive. It writes a string payload for a kind/path/content-hash tuple and disables the connection on storage errors.

Source: `node dist/cli.js code 'src/storage/per-db-cache.ts:48-161'`

- In-process caches are a separate layer. `createPerDbCache` owns key-based invalidation, and `createPerDbSourceCache` owns source-string identity invalidation. The product registry should not absorb these responsibilities.

Source: `node dist/cli.js code 'src/storage/evidence-payload.ts:1-80'`

- The storage module already has small payload validators, `isRecord` and `stringArray`, which should be reused and extended rather than reimplemented.

## Reuse Audit

Source: `node dist/cli.js files evidence`

- There is no existing `evidence-products` module.
- Existing evidence-related modules are `src/storage/evidence-cache.ts`, `src/storage/evidence-payload.ts`, and product consumers such as `src/queries/internal/consumer-evidence.ts`, `src/symbols/graph/call-graph-evidence.ts`, and `src/symbols/references/caller-evidence.ts`.

Source: `node dist/cli.js recent-duplicates`

- No recent re-implementations were found in the last 100 commits.

Source: `node dist/cli.js similar readCachedFileEvidence`

- Similarity results show shared access/query scaffolding between file evidence reads and semantic reads, but also different product semantics. That argues for a product layer above the raw file table, not a broad extraction across all evidence tables.

Source: `node dist/cli.js similar writeCachedFileEvidence`

- Write-side similarity has the same shape: shared DB scaffolding plus different semantic keys. The first abstraction should cover only file evidence products.

Source: `node dist/cli.js similar-files src/storage/evidence-cache.ts`

- No similar file pairs were found, so this is not a file-level duplication cleanup.

## Design Phases

### Phase 1: Add File Evidence Product Layer

File: `src/storage/evidence-products.ts` new file

Source:

- `node dist/cli.js files evidence`
- `node dist/cli.js code 'src/storage/evidence-cache.ts:24-40'`
- `node dist/cli.js code readCachedFileEvidence -C 8`
- `node dist/cli.js code writeCachedFileEvidence -C 8`
- `node dist/cli.js code 'src/storage/evidence-payload.ts:1-80'`

What:

- Add a file-scoped product facade over `readCachedFileEvidence` and `writeCachedFileEvidence`.
- Keep `FileEvidenceKind` in `evidence-cache.ts` unless importing it from the new module lowers coupling without causing churn.
- Export a type like `FileEvidenceProduct<T>` with `kind`, `read`, and `write` behavior.
- Export a factory like `createFileEvidenceProduct<T>({ kind, deserialize, serialize })`.

Change:

- `read` should call `readCachedFileEvidence(db, kind, relativePath, contentHash)` and return `T | null` after deserialization.
- `write` should serialize `T` and call `writeCachedFileEvidence(db, kind, relativePath, contentHash, payload)`.
- Deserialization failure should return `null`, preserving the existing "fall through and rebuild" behavior.
- The product layer must not compute source text, content hash, project fingerprint, dependency digest, or in-process cache keys.

Why:

- The repeated optimization is not SQLite access itself; it is the relationship between a named cache product, its payload shape, and its validity guard. Naming that relationship once lets future cache work become structural.

### Phase 2: Test Storage Product Behavior

File: `tests/storage/evidence-cache.test.ts` or new `tests/storage/evidence-products.test.ts`

Source:

- `node dist/cli.js co-change src/storage/evidence-cache.ts`
- `node dist/cli.js code readCachedFileEvidence -C 8`
- `node dist/cli.js code writeCachedFileEvidence -C 8`

What:

- Add tests that prove the product layer preserves raw evidence behavior.

Change:

- Test a valid payload round trip.
- Test invalid/corrupt payload handling returns `null`.
- Test a content-hash mismatch misses.
- If an existing storage test harness already creates a temporary SCIP DB, reuse it.

Why:

- The abstraction is only worthwhile if it locks in the current optimization contract and prevents future products from hand-rolling the same read/deserialize/write loop.

### Phase 3: Convert `source-facts`

File: `src/source/source-facts.ts:1-72`

Source:

- `node dist/cli.js code 'src/source/source-facts.ts:1-120'`
- `node dist/cli.js trace getSourceFacts`
- `node dist/cli.js co-change src/source/source-facts.ts`

What:

- Replace direct raw file evidence calls with a `SOURCE_FACTS_PRODUCT`.

Change:

- Replace the import of `readCachedFileEvidence` and `writeCachedFileEvidence` with the product helper while keeping `fileContentHash`.
- Define `SOURCE_FACTS_PRODUCT` near `SOURCE_FACTS_CACHE`.
- Keep `deserializeSourceFacts`, `serializeSourceFacts`, and the language equality guard in `loadOrBuildSourceFacts`.
- Preserve the Clojure fast path and AST-build path exactly: cached hit, Clojure build/write, AST build/write.

Why:

- This is the cleanest first conversion because all serialization functions live in the file and `getSourceFacts` already has high fan-out. It proves the registry on a valuable optimization without changing consumers.

### Phase 4: Convert `file-definitions`

File: `src/symbols/definition-catalog.ts:85-145`

Source:

- `node dist/cli.js code 'src/symbols/definition-catalog.ts:70-145'`
- `node dist/cli.js trace getDefinitionsForFile`
- `node dist/cli.js co-change src/symbols/definition-catalog.ts`

What:

- Replace direct raw file evidence calls with a `FILE_DEFINITIONS_PRODUCT`.

Change:

- Keep `readDefinitionEvidence` as the boundary that knows about `projectEvidenceFingerprint`, `getSourceText`, and relative-path validation.
- Move only the raw evidence read/write plus payload serialization through the product helper.
- Preserve `deserializeDefinitionEvidence(payload, projectFingerprint, relativePath)` as the product-specific guard.

Why:

- Definition evidence is high value but higher risk: it feeds symbol lookup, production callables, reference sites, affected analysis, cleanup planning, and semantic TypeScript paths. It should come after the product layer and source-facts proof are green.

### Phase 5: Convert Source Import Products

File: `src/language-parsers/index.ts:23-97`

Source:

- `node dist/cli.js code getReExports -C 12`
- `node dist/cli.js code getSourceImports -C 12`
- `node dist/cli.js trace readCachedFileEvidence`
- `node dist/cli.js trace writeCachedFileEvidence`

What:

- Add `SOURCE_IMPORTS_PRODUCT` and `SOURCE_REEXPORTS_PRODUCT`.

Change:

- Keep `importResolutionFingerprint(db)` in the caller, because it is a product-specific validity guard in addition to `contentHash`.
- Replace the duplicate read/parse/try-catch/write loops with product reads and writes.
- Keep parser selection, missing-source behavior, and empty-array behavior unchanged.

Why:

- These are the most obvious repeated loops after source facts. Converting both together makes the architectural pattern visible without touching semantic caches.

### Phase 6: Convert Remaining Simple File Products

File: `src/source/react-profile.ts:154-175`

Source: `node dist/cli.js code loadOrBuildReactComponentBehaviorProfiles -C 12`

What:

- Convert `react-component-behavior-profiles` to a file evidence product.

Change:

- Keep `REACT_COMPONENT_BEHAVIOR_PROFILE_CACHE` as the in-process source cache.
- Use the product helper only for persistent payload read/write.

Why:

- This preserves the optimization while removing another one-off persistent cache loop.

File: `src/queries/internal/consumer-evidence.ts:89-105`

Source: `node dist/cli.js code computeFileLeafUsage -C 12`

What:

- Convert `consumer-file-usage` to a file evidence product.

Change:

- Keep `FILE_USAGE_CACHE` and AST computation unchanged.
- Use the product helper for persistent payload read/write.

Why:

- This product is a direct fit for the same file/content-hash/cache-miss pattern.

### Phase 7: Defer Non-File Evidence Products

File: `src/storage/evidence-cache.ts:264-365`

Source:

- `node dist/cli.js change-surface src/storage/evidence-cache.ts`
- `node dist/cli.js similar readCachedFileEvidence`
- `node dist/cli.js similar writeCachedFileEvidence`

What:

- Do not convert semantic callee/reference caches in this first pass.

Change:

- Leave `readCachedSemanticCallees`, `readCachedSemanticReferences`, `writeCachedSemanticCalleesBatch`, and `writeCachedSemanticReferencesBatch` untouched.
- Create a follow-up note only after file products prove the shape.

Why:

- Semantic evidence products are keyed by symbol plus dependency or project fingerprint, not only file path plus content hash. Folding them into the first registry would blur the abstraction before its simpler unit is stable.

## Stress Test Findings

1. Evidence before idea: The target comes from `plan-context`, `change-surface`, `affected`, `trace`, `similar`, `files`, `co-change`, `doc-drift`, and `recent-duplicates`, not from a visual scan.
2. Preserve optimizations: The plan keeps `evidence.db`, content hashes, legacy version reads, error disabling, and in-process caches intact.
3. Small blast radius: Existing raw storage functions remain public, so consumers can be converted one product at a time.
4. Real abstraction: The new layer represents a named cache product and its payload contract; it is not just a synonym for `readCachedFileEvidence`.
5. Correct invalidation: File content hash stays at the call site, and product-specific guards such as language, project fingerprint, and resolution fingerprint remain explicit.
6. Payload safety: Existing deserializers remain the source of truth. Invalid payloads continue to miss and rebuild.
7. Language neutrality: The registry does not need to know about TypeScript, Vue, Clojure, Rust, or parser capabilities.
8. Performance: A product read/write adds one TypeScript function call around the existing DB operation; it must not add extra source reads, AST parses, DB reads, or JSON work beyond existing serialization.
9. Migration safety: Convert `source-facts` first, then definitions/imports, then remaining products. Stop if any product conversion changes output or cache-hit behavior.
10. Testability: Storage-level product tests cover the abstraction; product-specific tests or command smoke checks cover source facts, definitions, imports, and profile consumers.
11. Health score: Because this adds a helper and removes repeated one-off cache logic, run `recent-duplicates`, `wrapper-candidates`, and `incomplete-migration` after implementation.

## Execution Order

1. Add `src/storage/evidence-products.ts` with the generic file product helper.
2. Add storage tests for product round trip, invalid payload miss, and content-hash miss.
3. Convert `src/source/source-facts.ts`.
4. Run focused tests and source-facts smoke commands.
5. Convert `src/symbols/definition-catalog.ts`.
6. Run focused tests and definition/affected smoke commands.
7. Convert `src/language-parsers/index.ts` for source imports and re-exports.
8. Convert `src/source/react-profile.ts` and `src/queries/internal/consumer-evidence.ts`.
9. Run health-oriented cleanup checks.
10. Reindex and run diff gate.

## Ship Order

Ship 1:

- Product helper plus storage tests only.
- Verification: storage tests, typecheck/build.

Ship 2:

- `source-facts` conversion.
- Verification: source-facts tests or smoke commands, `node dist/cli.js affected getSourceFacts`, `node dist/cli.js recent-duplicates`.

Ship 3:

- `file-definitions`, `source-imports`, and `source-reexports`.
- Verification: affected/cleanup/navigation smoke commands, `node dist/cli.js wrapper-candidates`, `node dist/cli.js incomplete-migration`.

Ship 4:

- React profiles and consumer file usage.
- Verification: relevant cleanup/frontend commands, full typecheck/build, `node dist/cli.js reindex`, `node dist/cli.js diff-gate --json`.

## Validation Commands

Pre-plan checks already run:

- `node dist/cli.js status --capabilities`
- `node dist/cli.js plan-context src/storage/evidence-cache.ts`
- `node dist/cli.js recent-duplicates`
- `node dist/cli.js doc-drift docs/plans/2026-06-30-structural-optimization-inventory.md`

Implementation checks:

- `npm test -- tests/storage/evidence-cache.test.ts`
- `npm run typecheck`
- `npm run build`
- `node dist/cli.js affected readCachedFileEvidence`
- `node dist/cli.js affected writeCachedFileEvidence`
- `node dist/cli.js recent-duplicates`
- `node dist/cli.js wrapper-candidates`
- `node dist/cli.js incomplete-migration`
- `node dist/cli.js diff-impact --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Summary

The biggest architectural optimization is to promote persistent file evidence from raw string cache calls into typed evidence products. The storage layer should keep doing only storage work, the in-process cache layer should keep doing only invalidation work, and each product should declare how its payload is serialized, deserialized, and rejected as stale.

The first useful slice is not a schema migration. It is a small registry over the existing file evidence table, proven on `source-facts`, then applied to definitions and import evidence once the product helper is tested.
