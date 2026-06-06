# TypeScript Performance Skill Audit

Date: 2026-06-06

Scope: every Markdown reference in `.agents/skills/typescript/references`, audited against the full `scip-query` codebase, including `src`, tests, config, and package scripts.

Principle: performance changes must preserve indexing accuracy. In this codebase, an optimization is acceptable only when it either reduces compiler/runtime work without changing behavior, strengthens checks that prevent future slow or unsafe patterns, or documents why a rule is intentionally not applicable.

## Changes Made

- Compiler configuration: made `strictFunctionTypes` explicit and limited ambient type inclusion to Node types.
- Module hygiene: enforced type-only imports with ESLint and converted ts-morph/test dynamic type annotations to type-only imports.
- Whole-repo linting: expanded lint coverage from `src` to `src`, `tests`, and `tsup.config.ts`.
- Type safety: removed `any` from test mock signatures and removed stale lint suppressions.
- Runtime lookup cost: replaced repeated extension-family array scans in the import resolver with prebuilt `Set` lookups while preserving exported extension arrays.
- Exhaustiveness: added a `never` assertion to the finite watcher-status formatter.
- Memory cleanup: centralized watcher timer cleanup so cleared handles are nulled consistently.
- Advanced typing: used `satisfies` for parser registry entries so objects are checked against `LanguageParser` without erasing literal inference.
- Extraction cleanup: split ts-morph definition-node matching into focused helpers after the fresh health run surfaced one legitimate extraction candidate.

## Rule-By-Rule Result

| Reference | Result |
| --- | --- |
| `advanced-branded-types` | Audited. Not applied: public string/path/symbol shapes are intentionally interoperable with SCIP, SQLite rows, and CLI JSON output; branded IDs would add internal casting without measurable performance value. |
| `advanced-satisfies-operator` | Applied to the language parser registry entries. |
| `advanced-template-literal-types` | Audited. Not applied: symbol strings and file paths are external data from SCIP/source files, so runtime validation and parsing remain more important than compile-time string-pattern typing. |
| `async-avoid-loop-await` | Audited. Existing loop awaits are intentional for concurrency workers, serial retry after parallel indexer failure, and default-output indexers that write fixed files. |
| `async-avoid-unnecessary-async` | Audited. The small test loaders and reindex wrappers use `async` to load mocked modules or preserve error flow; no production no-op async wrapper was found. |
| `async-defer-await` | Audited. Existing awaits are already placed at dependency boundaries: reindex preparation, concurrent indexer fan-out, and CLI command execution. |
| `async-explicit-return-types` | Audited. Production exported async functions already expose explicit `Promise` return types where relevant. |
| `async-parallel-promises` | Audited. Existing indexer execution already uses bounded parallelism and serial fallback for reliability. |
| `mem-avoid-closure-leaks` | Audited. Long-lived closures in the watcher keep only required state; no large captured data structures were found. |
| `mem-avoid-global-state` | Audited. Existing global state is bounded native-module/parser failure caches or per-database WeakMap-backed caches. |
| `mem-cleanup-event-listeners` | Audited. `fs.watch` handles are closed in `Watcher.stop`; child-process listeners are one-shot process lifecycle listeners. |
| `mem-clear-timers` | Applied: watcher timer cleanup now clears and nulls timer handles consistently. |
| `mem-use-weakmap-for-metadata` | Audited. Per-database caches already use WeakMap-backed helpers. |
| `module-avoid-barrel-imports` | Audited. Internal code already imports directly except intentional public/package and CLI query barrels. |
| `module-avoid-circular-dependencies` | Audited with `cycles`; no dependency cycles were reported. |
| `module-control-types-inclusion` | Applied: `tsconfig.json` now explicitly includes only Node ambient types. |
| `module-dynamic-imports` | Audited. Large optional functionality is already lazy-loaded through optional dependency boundaries, notably ts-morph/tree-sitter-style providers. |
| `module-use-type-imports` | Applied: ESLint now enforces type-only imports, and existing dynamic type annotations were converted. |
| `runtime-avoid-object-spread-in-loops` | Audited. Remaining spreads are either outside hot loops, small result construction, or deliberate immutable row shaping. |
| `runtime-cache-property-access` | Audited. Hot loops already cache repeated values where material; no safe broad rewrite was identified. |
| `runtime-prefer-array-methods` | Audited. No lodash-style dependency or hand-rolled replacement target was found; loops remain where Sets/Maps/early exits are clearer or faster. |
| `runtime-use-for-of-for-iteration` | Audited. Existing indexed loops are used where indices are semantically needed; collection iteration mostly uses `for...of`. |
| `runtime-use-set-for-lookups` | Applied to import-path extension-family lookups. Existing command analysis also already relies heavily on Sets/Maps. |
| `runtime-use-string-methods` | Audited. Existing code already uses native string APIs for simple checks and reserves regexes for real parsing. |
| `safety-assertion-functions` | Audited. No repeated validation block justified a new assertion abstraction. |
| `safety-const-assertions` | Audited. Literal arrays and discriminators already use `as const` where it preserves useful literal information. |
| `safety-exhaustive-checks` | Applied to the finite watcher-status formatter. Open switches over platform, extension, and AST node strings intentionally keep defaults. |
| `safety-prefer-unknown-over-any` | Applied to test mock signatures; no production `any` remained. |
| `safety-strict-null-checks` | Audited. Covered by existing `strict: true`. |
| `safety-use-type-guards` | Audited. Existing dynamic inputs use type guards/unknown checks; no broad unsafe assertion pattern was found. |
| `tscfg-enable-incremental` | Already satisfied. |
| `tscfg-exclude-properly` | Already satisfied by narrow includes and excludes for generated/build folders. |
| `tscfg-isolate-modules` | Already satisfied. |
| `tscfg-project-references` | Audited. Not applied: this is a compact single-package CLI/library; references would add project-management overhead without a current compile-time payoff. |
| `tscfg-skip-lib-check` | Already satisfied. |
| `tscfg-strict-function-types` | Applied explicitly. |
| `type-avoid-deep-generics` | Audited. No deep generic hierarchy was found; nested Maps/Sets are runtime collection shapes, not type-level computation. |
| `type-avoid-large-unions` | Audited. No large application union needed splitting. |
| `type-explicit-return-types` | Audited. Exported production APIs already use explicit return types for the relevant surfaces. |
| `type-extract-conditional-types` | Audited. No expensive conditional utility type was found in app code. |
| `type-interfaces-over-intersections` | Audited. No production intersection-heavy type surface was found; tiny intersections are test fixture source strings. |
| `type-limit-recursion-depth` | Audited. No recursive type utilities were found. |
| `type-simplify-mapped-types` | Audited. No complex mapped type utilities were found. |

## Verification Results

- `npm run typecheck -- --extendedDiagnostics`: passed; warm incremental total time 0.41s, 333 files, about 158 MB reported memory.
- `npm run lint`: passed across `src`, `tests`, and `tsup.config.ts`.
- `npm test`: passed; 35 files and 174 tests.
- `npm run build`: passed.
- `node dist/cli.js reindex`: passed; TypeScript indexing completed in 1.7s on this repo.
- `node dist/cli.js cycles`: passed; no circular dependencies found.
- `node dist/cli.js dead --min-loc 5`: passed; 0 dead code, with file-internal helpers reported separately.
- `node dist/cli.js isolated --min-loc 3`: passed; no isolated symbols found.
- `node dist/cli.js extract-candidates -n 10`: passed; no extraction candidates found after the ts-morph helper extraction.
- `node dist/cli.js health --json`: passed; score 100 with every finding bucket at 0.
- `/usr/bin/time -p node dist/cli.js health --json`: passed; real 4.93s on this repo.
- `npm pack --dry-run`: passed; tarball size 231.8 kB, unpacked size 800.2 kB, 162 files.
