# Source Evidence Facade Plan

Date: 2026-06-30

## Goal

Build the next structural optimization from the inventory: a source evidence
facade. Source evidence means the source-file facts that analyzers repeatedly
derive from a file: text, lines, AST, imports, re-exports, source facts, and
identifier sets. The facade should let commands request these facts through one
shared interface while preserving the existing helper contracts and caches.

Done means:

- `src/source/source-evidence.ts` exists as the single source-file evidence
  facade.
- It reuses existing helpers instead of replacing their caches.
- A first set of safe consumers use it.
- Tests and diff-gate prove behavior stayed stable.

## Current State

Source: `node dist/cli.js status --capabilities`

- The index is fresh.
- TypeScript semantic provider, cleanup detectors, compiler verification, and
  diff gate are available.

Source: `node dist/cli.js plan-context src/source/source-facts.ts`

- `getSourceFacts()` is at `src/source/source-facts.ts:37-45`.
- `source-facts.ts` depends on source text, AST, Vue script extraction, and
  evidence products.
- `getSourceFacts()` has 11 consumers and is high risk, so its public behavior
  should not change.
- History says `source-facts.ts` often co-changes with `docs/COMMAND_REFERENCE.md`,
  `package.json`, `src/analysis/framework-patterns.ts`,
  `src/core/project-index.ts`, and `src/queries/index.ts`.

Source: `node dist/cli.js system source`

- The source system already exposes source text, AST, source facts, source
  filesets, identifier helpers, source reference helpers, React/Vue profiles,
  and source-backed reference scans.
- Downstream users include cleanup detectors, graph/navigation queries,
  semantic TypeScript paths, symbol indexing, and ProjectIndex.

Source: `node dist/cli.js code getSourceText -C 8`

- `getSourceText()` is at `src/source/source-text.ts:20-30`.
- It normalizes path separators, reads from project root, caches per DB/path,
  returns `''` for missing paths, and rethrows non-missing read errors.

Source: `node dist/cli.js code getSourceLines -C 8`

- `getSourceLines()` is at `src/source/source-text.ts:42-47`.
- It normalizes path separators, caches per DB/path, and splits the cached
  source text into lines.

Source: `node dist/cli.js code getAst -C 8`

- `getAst()` is at `src/source/ast/ast-core.ts:30-42`.
- It special-cases Vue SFCs, detects AST language, reads source text, and uses a
  source-string cache for parsed trees.

Source: `node dist/cli.js code getSourceImports -C 8`

- `getSourceImports()` is at `src/language-parsers/index.ts:67-83`.
- It normalizes paths, reads source text, uses file evidence product persistence,
  and returns parsed imports or `[]`.

Source: `node dist/cli.js code getReExports -C 8`

- `getReExports()` is at `src/language-parsers/index.ts:48-64`.
- It normalizes paths, reads source text, uses file evidence product persistence,
  and returns parsed re-exports or `[]`.

Source: `node dist/cli.js code getFileIdentifiers -C 8`

- `getFileIdentifiers()` is at `src/symbols/identifier-index.ts:80-90`.
- It first uses `getSourceFacts().fileIdentifiers`; if source facts are
  unavailable, it falls back through `getIdentifierLineMap()`.

Source: `node dist/cli.js code getIdentifierLineMap -C 8`

- `getIdentifierLineMap()` is at `src/symbols/identifier-index.ts:101-105`.
- It first uses `getSourceFacts().identifierLineMap`; if source facts are
  unavailable, it computes a fallback identifier map.

## Reuse Audit

Source: `node dist/cli.js files source-evidence`

- No existing `source-evidence` file exists.

Source: `node dist/cli.js recent-duplicates`

- No recent re-implementations were found.

Source: `node dist/cli.js similar-files src/source/source-facts.ts`

- No similar file pairs were found.

Source: `node dist/cli.js surface source`

- Existing source helpers already own the actual work: `getSourceText`,
  `getSourceLines`, `getAst`, `getSourceFacts`, source filesets, and source
  identifier/fallback helpers.

Decision:

- Add a new facade only as orchestration over existing helpers.
- Do not duplicate source text, AST, import, re-export, or source-facts caches.
- Do not import symbol-layer identifier fallback helpers into the source layer;
  the facade will expose identifiers only when source facts are available. The
  existing `symbols/identifier-index.ts` remains the fallback owner.

## Design Phases

### 1.1 — Add SourceEvidence Facade

- [ ] **File**: `src/source/source-evidence.ts:1-120`
- **Source**: `node dist/cli.js surface source`; `node dist/cli.js code getSourceText -C 8`; `node dist/cli.js code getAst -C 8`; `node dist/cli.js code getSourceImports -C 8`; `node dist/cli.js code getReExports -C 8`; `node dist/cli.js code getSourceFacts -C 8`
- **What**: Source-backed evidence is currently requested by calling individual
  helpers directly.
- **Change**: Add `sourceEvidence(db)` returning an object with:
  - `forFile(file, opts)`
  - `forFiles(files, opts)`
  - result fields: `file`, `text`, `lines`, `ast`, `imports`, `reexports`,
    `facts`, `identifiers`, `identifierLineMap`
- **Why**: This creates one structural access point while preserving existing
  helper ownership.

### 1.2 — Add Facade Tests

- [ ] **File**: `tests/source/source-evidence.test.ts:1-120`
- **Source**: `node dist/cli.js code getSourceText -C 8`; `node dist/cli.js code getSourceFacts -C 8`; `node dist/cli.js code getSourceImports -C 8`; `node dist/cli.js code getReExports -C 8`
- **What**: There is no facade test because the facade does not exist yet.
- **Change**: Add a fixture DB with a TypeScript file and a barrel re-export.
  Assert that `forFile()` returns requested text, lines, facts, identifiers,
  imports, and reexports; assert `forFiles()` returns a map keyed by file.
- **Why**: The facade is only valid if it preserves existing helper behavior.

### 2.1 — Migrate ProjectIndex Callable Signatures

- [ ] **File**: `src/core/project-index.ts:139-146`
- **Source**: `node dist/cli.js code ProjectIndex:callableSignature -C 8`; `node dist/cli.js change-surface src/core/project-index.ts`
- **What**: `callableSignature()` directly calls `getSourceFacts()` and finds
  the matching callable by source range.
- **Change**: Use `sourceEvidence(this.db).forFile(definition.relativePath, { facts: true })`
  and find the callable from `evidence.facts`.
- **Why**: This moves a high-level read-model method to the shared facade without
  changing its public method shape.

### 2.2 — Migrate File Classifier Function Detection

- [ ] **File**: `src/analysis/file-classifier.ts:109-125`
- **Source**: `node dist/cli.js code definesFunctions -C 8`
- **What**: `definesFunctions()` normalizes the path, calls `getSourceFacts()`,
  and falls back to SQL range evidence.
- **Change**: Read facts through `sourceEvidence(db).forFile(normalized, { facts: true })`;
  leave the SQL fallback unchanged.
- **Why**: This is a small source-facts read with a clear fallback path.

### 2.3 — Migrate Definition Catalog Source Reads

- [ ] **File**: `src/symbols/definition-catalog.ts:81-129`
- **Source**: `node dist/cli.js code getDefinitionsForFile -C 10`; `node dist/cli.js code readDefinitionEvidence -C 10`
- **What**: `getDefinitionsForFile()` and `readDefinitionEvidence()` call
  `getSourceText()` directly to decide whether file-definition evidence can be
  read or written.
- **Change**: Use `sourceEvidence(db).forFile(relativePath, { text: true })`
  and keep `fileContentHash()` plus project-fingerprint validation unchanged.
- **Why**: This moves source text acquisition to the facade while preserving the
  definition evidence cache contract.

### 2.4 — Migrate Consumer Evidence Source Reads

- [ ] **File**: `src/queries/internal/consumer-evidence.ts:95-194`
- **Source**: `node dist/cli.js code computeFileLeafUsage -C 10`; `node dist/cli.js code isReExportOnlyConsumer -C 10`; `node dist/cli.js change-surface src/queries/internal/consumer-evidence.ts`
- **What**: `computeFileLeafUsage()` separately reads source text and AST.
  `isReExportOnlyConsumer()` separately reads source lines and re-exports.
- **Change**:
  - In `computeFileLeafUsage()`, request `{ text: true, ast: true }`.
  - Pass `evidence.ast` into `computeFileLeafUsageFromAst()` instead of
    reloading the AST there.
  - In `isReExportOnlyConsumer()`, request `{ lines: true, reexports: true }`.
- **Why**: This is the clearest local proof that the facade reduces repeated
  source evidence assembly.

## Stress-Test Findings

1. Understand before touch: the facade reuses existing helpers; it does not
   change parse policy, Vue behavior, or cache invalidation.
2. Blast radius: `ProjectIndex` is high risk, so the migration keeps the method
   signature unchanged and verifies via existing ProjectIndex consumers.
3. Intermediate validity: Phase 1 is additive and deployable by itself.
4. Reversibility: each migration can revert to direct helper calls without data
   migration.
5. Failure behavior: source read error behavior remains owned by `getSourceText`.
6. Concurrency: no new mutable global state is introduced.
7. Boundaries: this is internal source evidence, not a public CLI/API boundary.
8. Data integrity: persistent cache keys and payload validators remain unchanged.
9. Observability: benchmark contract can be rerun after the migration.
10. Human: no command output or CLI surface should change.
11. Reuse: all actual evidence computation reuses existing helpers.

## Execution Order

1. Add `src/source/source-evidence.ts`.
2. Add `tests/source/source-evidence.test.ts`.
3. Migrate `ProjectIndex.callableSignature()`.
4. Migrate `definesFunctions()`.
5. Migrate `definition-catalog` source reads.
6. Migrate `consumer-evidence` source reads.
7. Run targeted tests, typecheck, benchmark contract, reindex, and diff-gate.

## Ship Order

One deployable ship is acceptable because every change is internal and
reversible. If split, ship Phase 1 first, then migrate consumers in Phase 2.

## Summary

Files to create:

- `src/source/source-evidence.ts`
- `tests/source/source-evidence.test.ts`

Files to modify:

- `src/core/project-index.ts`
- `src/analysis/file-classifier.ts`
- `src/symbols/definition-catalog.ts`
- `src/queries/internal/consumer-evidence.ts`

Expected net effect: no output changes, but source evidence access gains one
owner facade that later detector migrations can reuse.
