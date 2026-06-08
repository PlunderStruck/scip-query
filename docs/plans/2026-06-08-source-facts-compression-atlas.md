# Source Facts Compression Atlas

## Scope Map

Scope: AST-backed source analysis for Rust, Python, TypeScript, TSX, and JavaScript.

Entry points:
- `src/source/ast.ts` exposes AST facts to the rest of the package.
- `src/source/ast-facts.ts` exposes callable sites, call sites, and type-container facts.
- `src/source/ast-signatures.ts` exposes callable parameter counts.
- `src/analysis/passthrough-detect.ts` classifies literal passthrough callables.
- `src/symbols/identifier-index.ts` exposes identifier line maps and line-indexed identifiers.
- `src/symbols/definition-catalog.ts` consumes callable ranges for SCIP definition correction.

Tests to preserve:
- command/source accuracy tests for `code`, `symbols`, `refs`, and `call-graph`
- wrapper and passthrough candidate tests
- full typecheck, lint, build, and test suite

## Role Inventory

Recurring role: read a source file, load its syntax tree, walk/query the tree, cache a per-file projection, and answer a narrow question.

Execution shape:
1. detect language from path
2. load tree from source text
3. inspect language-specific syntax nodes
4. materialize a small fact view
5. cache by file/tree
6. expose a query-specific helper

The repeated shape appears in:
- callable range extraction
- callable signature extraction
- passthrough-body detection
- callsite extraction
- type-container extraction
- identifier line extraction

## Opportunity Ledger

O1 `merge`: Create one source-facts bundle that derives AST facts from one cached source/tree view.
Evidence: `ast-facts`, `ast-signatures`, `passthrough-detect`, and `identifier-index` each repeat language detection, AST loading, walking, and line-range keying.

O2 `enforce`: Keep callable range, signature, and passthrough status on the same callable fact.
Evidence: the TypeScript assigned-function bug came from one consumer correcting callable ranges while another concept still treated callable identity separately.

O3 `merge`: Derive identifier line maps and identifiers-by-line from source facts for AST-supported files, preserving regex fallback for unsupported languages.
Evidence: `identifier-index` already states its three caches are views of one scan.

O4 `skip`: Do not fold all framework exclusion policy into this first slice.
Evidence: Rust framework exclusions encode macro, generated-file, serde, trait, and cross-language policy; those are policy-heavy, not merely traversal-heavy.

O5 `defer`: Later fold Rust attribute references and JS cross-language dispatch names into source facts once the callable/identifier/callsite bundle is stable.
Blocking fact: those helpers are correctness policy for dead-code evidence and need narrower regression tests before moving.

## Deferred Register

O5 remains for the next pass. Revisit after this refactor passes full verification and source facts has a stable public shape.

## Compression Clusters

Cluster A: source-facts core.
Files: `src/source/source-facts.ts`, `src/source/ast.ts`, `src/source/ast-facts.ts`.

Cluster B: consumer migration.
Files: `src/source/ast-signatures.ts`, `src/analysis/passthrough-detect.ts`, `src/symbols/identifier-index.ts`, `src/core/project-index.ts`, `src/queries/passthrough-candidates.ts`.

Cluster C: cleanup and verification.
Files: obsolete wrappers if they become pure pass-throughs, tests as needed.

## Dependency Order

1. Add source facts without changing consumers.
2. Route existing AST fact exports through source facts.
3. Route signatures and passthrough detection through source facts.
4. Route AST-supported identifier maps through source facts while preserving fallback behavior.
5. Delete wrappers only when imports are migrated.

## Touch Map

Primary touch: `src/source`, `src/analysis`, `src/symbols`, `src/core`, `src/queries`.

Conflict risk: low with current worktree; only existing unrelated change is `.claude/scheduled_tasks.lock` deletion.

## Validation Plan

Focused:
- `npm test -- tests/source-backed-accuracy.test.ts`
- `npm test -- tests/command-accuracy.test.ts`
- `npm test -- tests/file-wide-caller-fallback.test.ts`
- `npm test -- tests/identifier-attribution.test.ts`

Final:
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm test`
