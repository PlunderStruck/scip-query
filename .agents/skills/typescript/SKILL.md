---
name: typescript
description: Apply TypeScript performance and safety rules. Use for tsc speed, tsconfig, type errors, async patterns, module organization, import hygiene, type definitions, memory issues, or .ts/.tsx/.d.ts work. Not for TypeScript basics or framework-specific testing.
---

# TypeScript Best Practices

Use this skill as a compact router to the TypeScript rule pack. A TypeScript rule is a narrow, evidence-backed coding guideline whose purpose is to improve compile speed, runtime behavior, type safety, or maintainability for TypeScript projects.

The full compiled document is [`AGENTS.md`](AGENTS.md). Individual detailed rules live under [`references/`](references/).

## Rules

1. Start with the highest-impact category that matches the work.
2. Read the specific reference file before applying a non-obvious rule.
3. Prefer project conventions when a rule conflicts with established local architecture.
4. Verify with the project typecheck, test, or build command after edits.

## Categories

| Priority | Category | Use for | Prefix |
| --- | --- | --- | --- |
| 1 | Type system performance | slow type checking, complex types, exported APIs | `type-` |
| 2 | Compiler configuration | tsconfig, project references, included files | `tscfg-` |
| 3 | Async patterns | Promise concurrency, async wrappers, return types | `async-` |
| 4 | Module organization | imports, barrels, dynamic imports, @types scope | `module-` |
| 5 | Type safety | unknown, guards, exhaustive checks, nullability | `safety-` |
| 6 | Memory management | timers, listeners, closures, global caches | `mem-` |
| 7 | Runtime optimization | hot loops, lookups, object spread, string methods | `runtime-` |
| 8 | Advanced patterns | branded types, satisfies, template literal types | `advanced-` |

## Quick Map

Type system:

- `type-interfaces-over-intersections`
- `type-avoid-large-unions`
- `type-extract-conditional-types`
- `type-limit-recursion-depth`
- `type-explicit-return-types`
- `type-avoid-deep-generics`
- `type-simplify-mapped-types`

Compiler:

- `tscfg-enable-incremental`
- `tscfg-skip-lib-check`
- `tscfg-isolate-modules`
- `tscfg-project-references`
- `tscfg-exclude-properly`
- `tscfg-strict-function-types`

Async and modules:

- `async-parallel-promises`
- `async-defer-await`
- `async-avoid-loop-await`
- `async-explicit-return-types`
- `async-avoid-unnecessary-async`
- `module-avoid-barrel-imports`
- `module-avoid-circular-dependencies`
- `module-use-type-imports`
- `module-dynamic-imports`
- `module-control-types-inclusion`

Safety, memory, runtime, advanced:

- `safety-prefer-unknown-over-any`
- `safety-use-type-guards`
- `safety-exhaustive-checks`
- `safety-strict-null-checks`
- `safety-const-assertions`
- `safety-assertion-functions`
- `mem-use-weakmap-for-metadata`
- `mem-avoid-closure-leaks`
- `mem-cleanup-event-listeners`
- `mem-avoid-global-state`
- `mem-clear-timers`
- `runtime-use-set-for-lookups`
- `runtime-cache-property-access`
- `runtime-avoid-object-spread-in-loops`
- `runtime-use-for-of-for-iteration`
- `runtime-prefer-array-methods`
- `runtime-use-string-methods`
- `advanced-branded-types`
- `advanced-template-literal-types`
- `advanced-satisfies-operator`

## Use

Open the specific reference file for detailed examples, apply the smallest relevant rule, and verify with the local TypeScript check. The skill is complete only when the chosen rule, changed files, and verification command are reported.
