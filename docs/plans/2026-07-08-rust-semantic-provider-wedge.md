# Rust Semantic Provider Wedge Plan

Date: 2026-07-08

## Goal

Start Rust semantic support without claiming fake Rust reference accuracy. Done
for this slice means Rust has a typed semantic config/readiness/provider entry
point, TypeScript semantic behavior is unchanged, and status/capability output
can distinguish "Rust semantic backend is reachable" from "Rust semantic facts
are implemented."

## Current State

- Source: `scip-query status --capabilities`
  The current project index is fresh and reports TypeScript semantic support
  only.
- Source: `scip-query plan-context src/semantic`
  The semantic module is consumed by cleanup and graph analysis, and currently
  exposes a TypeScript provider through `src/semantic/provider-cache.ts` and
  `src/semantic/shared-primitives.ts`.
- Source: `scip-query plan-context src/runtime/project-readiness.ts`
  Project readiness owns the status/capability handoff and currently has one
  optional TypeScript semantic readiness entry.
- Source: `scip-query plan-context src/domain/config-types.ts`
  Project config is a public surface; semantic config currently exposes only
  `SemanticConfig.typescript`.

## Reuse Audit

- Reuse `getIndexerDependencyStatus(getIndexerConfig('rust'), projectRoot)` for
  rust-analyzer binary availability. The Rust SCIP indexer and the first Rust
  semantic backend use the same executable.
- Reuse the existing `SemanticProvider` contract rather than adding detector
  special cases.
- Reuse runtime config's unknown-key validator by adding Rust semantic keys next
  to the existing TypeScript semantic keys.

## Testability Design

| Behavior | Test seam | Dependencies to inject | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Rust semantic readiness reports separately from TypeScript | `getProjectCapabilities(readiness)` | Readiness object | `languageSemanticCapability` | `getProjectReadiness` probes binaries | Per-language matrix row has accurate status and reason |
| Runtime config accepts `semantic.rust` | `validateProjectConfig(config)` | Config object | unknown-key validator | none | Rust semantic config keys are known; invalid neighbor keys still warn |
| Provider lookup can select Rust without implemented facts | `getSemanticProvider(db, 'src/lib.rs')` | `ScipDatabase` | language selection from path | provider construction | Rust provider returns unavailable fact methods until implemented |

## Steps

1. Extend semantic types/config with a Rust semantic provider language and Rust
   semantic config.
2. Add a Rust provider shell whose availability is based on rust-analyzer
   resolution but whose evidence methods return empty/null until the reference
   engine lands.
3. Generalize provider-cache lookup by source path language, preserving the
   existing TypeScript key and behavior.
4. Add per-language semantic readiness while preserving the existing
   `readiness.semantic` TypeScript compatibility field.
5. Add focused tests for runtime config, project readiness, and provider
   language selection.

## Verification

- `npm run typecheck`
- Focused Vitest files for runtime config, project readiness, and semantic
  providers.
- `scip-query reindex`
- `scip-query diff-gate --json`
